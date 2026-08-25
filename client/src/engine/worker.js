// Rota motoru: sunucudaki (server/index.js) mantığın tamamı burada tarayıcı
// Web Worker'ı içinde çalışır. Ana iş parçacığı bloklanmasın diye graf kurma
// (Dijkstra hazırlığı, birkaç yüz ms - birkaç sn) ve rota hesaplama burada yapılır.
import * as turf from "@turf/turf";
import PathFinder, { pathToGeoJSON } from "geojson-path-finder";
import {
  ALPHA_LEVELS,
  alphaFromPreference,
  getTimeName,
  TIME_PROFILE_HOURS,
  ACCESSIBLE_HIGHWAY_PENALTY,
  SAFE_HAVEN_TYPES,
  SAFE_HAVEN_SHOPS,
  SAFE_HAVEN_OTHER,
  havenKind,
  isHavenOpenAt,
  HEATMAP_BANDS,
  weightedReports,
  reportEffectAt,
  adjustScore,
} from "./scoring.js";

const WALK_SPEED_KMH = 5;
const TURN_SAMPLE_M = 20;
const TURN_ANGLE_THRESHOLD = 40;
const MIN_STEP_M = 20;
const SEGMENT_SAMPLE_M = 25;
const MATCH_MAX_DIST_M = 35;

const regionData = {}; // id -> { roadsScored, amenities, segmentIndex, vertexPoints, bbox }
const finderCache = new Map(); // "regionId:timeName:alpha:accessible" -> PathFinder
const MAX_CACHED_FINDERS = 6; // tarayıcı sekmesi tek kullanıcıya ait, sunucudan daha cömert olabilir
let currentReports = []; // { region, lat, lng, type, createdAt, confirmations }[] — ana iş parçacığından beslenir

function extractVertexPoints(roadsScored) {
  const seen = new Set();
  const points = [];
  for (const f of roadsScored.features) {
    if (!f.geometry || f.geometry.type !== "LineString") continue;
    for (const c of f.geometry.coordinates) {
      const key = `${c[0]},${c[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push(turf.point(c));
    }
  }
  return turf.featureCollection(points);
}

function buildSegmentIndex(roadsScored) {
  const index = new Map();
  const cell = 0.002;
  roadsScored.features.forEach((f, i) => {
    if (!f.geometry || f.geometry.type !== "LineString") return;
    const seen = new Set();
    for (const [lng, lat] of f.geometry.coordinates) {
      const key = `${Math.floor(lat / cell)},${Math.floor(lng / cell)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(i);
    }
  });
  return { index, cell };
}

async function loadRegion(id) {
  if (regionData[id]) return regionData[id];
  const [roadsScored, amenities] = await Promise.all([
    fetch(`/data/${id}/roads.json`).then((r) => r.json()),
    fetch(`/data/${id}/amenities.json`).then((r) => r.json()),
  ]);
  const region = {
    id,
    roadsScored,
    amenities,
    segmentIndex: buildSegmentIndex(roadsScored),
    vertexPoints: extractVertexPoints(roadsScored),
    bbox: turf.bbox(roadsScored),
  };
  regionData[id] = region;
  return region;
}

function getWeightedReportsFor(regionId) {
  return weightedReports(currentReports.filter((r) => r.region === regionId));
}

function buildFinder(region, scoreField, alpha, accessible) {
  const weighted = getWeightedReportsFor(region.id);
  return new PathFinder(region.roadsScored, {
    weight: (a, b, props) => {
      const distanceKm = turf.distance(a, b);
      const base = props[scoreField] ?? 50;
      const adjusted = adjustScore(base, weighted, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      const penalty = (100 - adjusted) / 100;
      let cost = distanceKm * (1 + alpha * penalty);
      if (accessible) {
        const mult = ACCESSIBLE_HIGHWAY_PENALTY[props.highway];
        if (mult) cost *= mult;
      }
      return cost;
    },
    edgeDataSeed: (props) => ({
      weightedSum: (props[scoreField] ?? 50) * (props.length_m ?? 1),
      totalLenM: props.length_m ?? 1,
      minScore: props[scoreField] ?? 50,
    }),
    edgeDataReducer: (a, b) => ({
      weightedSum: a.weightedSum + b.weightedSum,
      totalLenM: a.totalLenM + b.totalLenM,
      minScore: Math.min(a.minScore, b.minScore),
    }),
  });
}

function getFinder(region, timeName, alpha, accessible) {
  const key = `${region.id}:${timeName}:${alpha}:${accessible ? "a" : "n"}`;
  const cached = finderCache.get(key);
  if (cached) {
    finderCache.delete(key);
    finderCache.set(key, cached);
    return cached;
  }
  const finder = buildFinder(region, `s_${timeName}`, alpha, accessible);
  finderCache.set(key, finder);
  while (finderCache.size > MAX_CACHED_FINDERS) {
    finderCache.delete(finderCache.keys().next().value);
  }
  return finder;
}

function snapToNetwork(region, lng, lat) {
  return turf.nearestPoint(turf.point([lng, lat]), region.vertexPoints);
}

function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}

function turnLabel(delta) {
  const abs = Math.abs(delta);
  const yon = delta > 0 ? "sağa" : "sola";
  if (abs < 60) return `Hafif ${yon} dön`;
  if (abs < 130) return yon === "sağa" ? "Sağa dön" : "Sola dön";
  return `Keskin ${yon} dön`;
}

function buildSteps(lineCoords) {
  const line = turf.lineString(lineCoords);
  const totalKm = turf.length(line, { units: "kilometers" });
  const sampleKm = TURN_SAMPLE_M / 1000;

  const samples = [];
  for (let d = 0; d < totalKm; d += sampleKm) {
    samples.push(turf.along(line, d, { units: "kilometers" }).geometry.coordinates);
  }
  samples.push(lineCoords[lineCoords.length - 1]);

  if (samples.length < 3) {
    return [
      { instruction: "Başlangıç noktasından hedefe doğru yürü", distanceM: Math.round(totalKm * 1000), at: samples[0] },
      { instruction: "Hedefe ulaştın", distanceM: 0, at: lineCoords[lineCoords.length - 1] },
    ];
  }

  const steps = [{ instruction: "Yürümeye başla", distanceM: 0, at: samples[0] }];
  let currentBearing = turf.bearing(turf.point(samples[0]), turf.point(samples[1]));

  for (let i = 0; i < samples.length - 1; i++) {
    const segKm = turf.distance(turf.point(samples[i]), turf.point(samples[i + 1]), { units: "kilometers" });
    if (i > 0) {
      const b = turf.bearing(turf.point(samples[i]), turf.point(samples[i + 1]));
      const delta = angleDiff(currentBearing, b);
      if (Math.abs(delta) >= TURN_ANGLE_THRESHOLD) {
        steps.push({ instruction: turnLabel(delta), distanceM: 0, at: samples[i] });
        currentBearing = b;
      }
    }
    steps[steps.length - 1].distanceM += Math.round(segKm * 1000);
  }

  steps.push({ instruction: "Hedefe ulaştın", distanceM: 0, at: lineCoords[lineCoords.length - 1] });

  const cleaned = [];
  for (const step of steps) {
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.distanceM < MIN_STEP_M && cleaned.length > 1) {
      prev.instruction = step.instruction;
      prev.distanceM += step.distanceM;
    } else {
      cleaned.push({ ...step });
    }
  }
  return cleaned;
}

function findNearestSegment(region, lng, lat) {
  const { index, cell } = region.segmentIndex;
  const cLat = Math.floor(lat / cell);
  const cLng = Math.floor(lng / cell);
  const pt = turf.point([lng, lat]);
  let best = null;
  let bestDist = Infinity;
  const checked = new Set();
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLng = -1; dLng <= 1; dLng++) {
      const bucket = index.get(`${cLat + dLat},${cLng + dLng}`);
      if (!bucket) continue;
      for (const idx of bucket) {
        if (checked.has(idx)) continue;
        checked.add(idx);
        const feature = region.roadsScored.features[idx];
        const snapped = turf.nearestPointOnLine(feature, pt, { units: "meters" });
        if (snapped.properties.dist < bestDist) {
          bestDist = snapped.properties.dist;
          best = feature;
        }
      }
    }
  }
  return bestDist <= MATCH_MAX_DIST_M ? best : null;
}

function buildSegments(region, lineCoords, scoreField, breakdownField) {
  const line = turf.lineString(lineCoords);
  const totalKm = turf.length(line, { units: "kilometers" });
  const stepKm = SEGMENT_SAMPLE_M / 1000;
  const weighted = getWeightedReportsFor(region.id);

  const parts = [];
  let prev = null;

  for (let d = 0; d <= totalKm; d += stepKm) {
    const coord = turf.along(line, Math.min(d, totalKm), { units: "kilometers" }).geometry.coordinates;
    const match = findNearestSegment(region, coord[0], coord[1]);
    const baseScore = match ? match.properties[scoreField] : null;
    const reportEffect = Math.round(reportEffectAt(weighted, coord[0], coord[1]));
    const score = baseScore == null ? null : Math.max(0, Math.min(100, baseScore - reportEffect));

    if (prev && prev.score === score) {
      prev.coordinates.push(coord);
      prev.lengthKm += stepKm;
    } else {
      if (prev) prev.coordinates.push(coord);
      prev = {
        score,
        baseScore,
        reportEffect,
        name: match ? match.properties.name || null : null,
        highway: match ? match.properties.highway : null,
        buurt: match ? match.properties.buurt || null : null,
        breakdown: match ? match.properties[breakdownField] || null : null,
        coordinates: [coord],
        lengthKm: stepKm,
      };
      parts.push(prev);
    }
  }
  return parts.filter((p) => p.coordinates.length >= 2);
}

function computeRoute(region, startLng, startLat, endLng, endLat, finder, timeName) {
  const startSnap = snapToNetwork(region, startLng, startLat);
  const endSnap = snapToNetwork(region, endLng, endLat);

  const result = finder.findPath(startSnap, endSnap);
  if (!result) return null;

  const line = pathToGeoJSON(result);
  const distanceKm = turf.length(line, { units: "kilometers" });

  const segments = buildSegments(region, line.geometry.coordinates, `s_${timeName}`, `b_${timeName}`);

  let avgSafety = null;
  let minSafety = null;
  const scored = segments.filter((s) => s.score != null);
  if (scored.length) {
    const totalLen = scored.reduce((s, x) => s + x.lengthKm, 0);
    avgSafety = totalLen ? Math.round(scored.reduce((s, x) => s + x.score * x.lengthKm, 0) / totalLen) : null;
    minSafety = Math.min(...scored.map((s) => s.score));
  }

  return {
    route: line,
    distanceKm: Math.round(distanceKm * 100) / 100,
    durationMin: Math.round((distanceKm / WALK_SPEED_KMH) * 60),
    avgSafetyScore: avgSafety,
    minSafetyScore: minSafety,
    hasSteps: segments.some((s) => s.highway === "steps"),
    segments,
    steps: buildSteps(line.geometry.coordinates),
    snappedStart: startSnap.geometry.coordinates,
    snappedEnd: endSnap.geometry.coordinates,
  };
}

function buildHeatmap(region, timeName) {
  const scoreField = `s_${timeName}`;
  const buckets = HEATMAP_BANDS.map(() => []);
  for (const f of region.roadsScored.features) {
    if (!f.geometry || f.geometry.type !== "LineString") continue;
    const score = f.properties[scoreField];
    if (score == null) continue;
    const bandIdx = HEATMAP_BANDS.findIndex((b) => score < b.max);
    const coords = f.geometry.coordinates;
    const simplified =
      coords.length > 4 ? coords.filter((_, i) => i === 0 || i === coords.length - 1 || i % 3 === 0) : coords;
    buckets[bandIdx === -1 ? HEATMAP_BANDS.length - 1 : bandIdx].push(simplified);
  }
  return HEATMAP_BANDS.map((b, i) => ({ color: b.color, label: b.label, lines: buckets[i] }));
}
const heatmapCache = new Map();

async function handleRoute({ region: regionId, startLat, startLng, endLat, endLng, time, safetyPref, accessible }) {
  const region = await loadRegion(regionId);
  const timeName = getTimeName(time);
  const alpha = alphaFromPreference(parseFloat(safetyPref));
  const isAccessible = !!accessible;
  const sLng = parseFloat(startLng);
  const sLat = parseFloat(startLat);
  const eLng = parseFloat(endLng);
  const eLat = parseFloat(endLat);

  const fastFinder = getFinder(region, timeName, 0, isAccessible);
  const safeFinder = getFinder(region, timeName, alpha, isAccessible);
  const fastRoute = computeRoute(region, sLng, sLat, eLng, eLat, fastFinder, timeName);
  const safeRoute = computeRoute(region, sLng, sLat, eLng, eLat, safeFinder, timeName);

  if (!fastRoute || !safeRoute) {
    throw new Error("Bu iki nokta arasında rota bulunamadı (ağ dışında olabilir).");
  }
  return { fast: fastRoute, safe: safeRoute, timeProfile: timeName, alpha };
}

async function handleHeatmap({ region: regionId, time }) {
  const region = await loadRegion(regionId);
  const timeName = getTimeName(time);
  const key = `${region.id}:${timeName}`;
  if (!heatmapCache.has(key)) heatmapCache.set(key, buildHeatmap(region, timeName));
  return { bands: heatmapCache.get(key), timeProfile: timeName };
}

async function handleSafeHavens({ region: regionId, lat, lng, time }) {
  const region = await loadRegion(regionId);
  const timeName = getTimeName(time);
  const hour = TIME_PROFILE_HOURS[timeName] ?? new Date().getHours();
  const from = turf.point([parseFloat(lng), parseFloat(lat)]);

  const havens = region.amenities.features
    .filter((f) => {
      const kind = havenKind(f.properties);
      return SAFE_HAVEN_TYPES[kind] || SAFE_HAVEN_SHOPS[kind] || SAFE_HAVEN_OTHER[kind];
    })
    .map((f) => {
      const kind = havenKind(f.properties);
      const label = SAFE_HAVEN_TYPES[kind]?.label || SAFE_HAVEN_SHOPS[kind] || SAFE_HAVEN_OTHER[kind];
      const isOpen = isHavenOpenAt(f.properties, hour);
      return {
        type: kind,
        typeLabel: label,
        name: f.properties.name || label,
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
        distanceM: Math.round(turf.distance(from, f, { units: "meters" })),
        isOpen,
        alwaysOpen: !!SAFE_HAVEN_TYPES[kind]?.always,
      };
    })
    .sort((a, b) => (a.isOpen === b.isOpen ? a.distanceM - b.distanceM : a.isOpen ? -1 : 1))
    .slice(0, 12);

  return { havens, timeProfile: timeName };
}

async function handleRegions() {
  return {
    currentTimeProfile: getTimeName(undefined),
  };
}

function invalidateReportDependentCaches() {
  finderCache.clear();
  heatmapCache.clear();
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    let result;
    switch (type) {
      case "setReports":
        currentReports = payload.reports || [];
        invalidateReportDependentCaches();
        result = { ok: true };
        break;
      case "route":
        result = await handleRoute(payload);
        break;
      case "heatmap":
        result = await handleHeatmap(payload);
        break;
      case "safeHavens":
        result = await handleSafeHavens(payload);
        break;
      case "regions":
        result = await handleRegions();
        break;
      case "bounds": {
        const region = await loadRegion(payload.region);
        result = { bbox: region.bbox };
        break;
      }
      default:
        throw new Error(`Bilinmeyen istek tipi: ${type}`);
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
