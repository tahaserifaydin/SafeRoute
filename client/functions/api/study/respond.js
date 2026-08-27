// Kör A/B test yanıtları: tüm bölgelerin yanıtları tek bir KV anahtarında
// (JSON dizi) tutulur — hacim düşük (tez için katılımcı sayısı sınırlı),
// bölge başına ayrı anahtara gerek yok.
export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const { scenarioId, region, chosen, safeIsA, distanceA, distanceB, avgSafetyA, avgSafetyB } = body || {};
  if (!scenarioId || (chosen !== "A" && chosen !== "B") || !region) {
    return Response.json({ error: "scenarioId, region ve chosen ('A' ya da 'B') zorunlu" }, { status: 400 });
  }
  const raw = await env.EMERGENCY_KV.get("study-responses");
  const responses = raw ? JSON.parse(raw) : [];
  const chosenIsSafe = (chosen === "A") === !!safeIsA;
  responses.push({
    scenarioId,
    region,
    chosen,
    chosenIsSafe,
    safeIsA: !!safeIsA,
    distanceA,
    distanceB,
    avgSafetyA,
    avgSafetyB,
    createdAt: new Date().toISOString(),
  });
  await env.EMERGENCY_KV.put("study-responses", JSON.stringify(responses));
  return Response.json({ ok: true });
}
