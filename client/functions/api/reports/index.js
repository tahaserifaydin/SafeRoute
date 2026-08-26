// Kullanıcı raporları: KV'de bölge başına tek bir JSON dizi olarak tutulur
// (beklenen hacim düşük — kalabalık raporlama değil, tekil kullanıcı bildirimleri).
// Eski Node sunucusundaki (server/index.js) aynı güven/zaman-azalması mantığı
// burada tekrarlanıyor ki statik siteye (Cloudflare Pages) taşınırken davranış
// değişmesin.
const REPORT_TYPES = {
  dark: "Karanlık / lamba yok",
  unsafe: "Tekinsiz hissettim",
  harassment: "Taciz / rahatsız edilme",
  blocked: "Yol kapalı / geçilmiyor",
  safe: "Burası güvenli",
};
const REPORT_HALFLIFE_DAYS = 180;
const CONFIRM_BONUS = 0.5;

async function readReports(kv, region) {
  const raw = await kv.get(`reports:${region}`);
  return raw ? JSON.parse(raw) : [];
}

async function writeReports(kv, region, reports) {
  await kv.put(`reports:${region}`, JSON.stringify(reports));
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const region = url.searchParams.get("region");
  const reports = region ? await readReports(env.EMERGENCY_KV, region) : [];
  const now = Date.now();
  return Response.json({
    reports: reports.map((r) => {
      const ageDays = (now - new Date(r.createdAt).getTime()) / 86400000;
      const confirms = r.confirmations || 0;
      return {
        ...r,
        confirmations: confirms,
        trust: Math.round(Math.min(1, Math.pow(0.5, ageDays / REPORT_HALFLIFE_DAYS) * (1 + confirms * CONFIRM_BONUS)) * 100),
      };
    }),
    types: REPORT_TYPES,
  });
}

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const { lat, lng, type, note, region } = body || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !REPORT_TYPES[type] || !region) {
    return Response.json({ error: "Geçerli lat, lng, type ve region zorunlu" }, { status: 400 });
  }
  const reports = await readReports(env.EMERGENCY_KV, region);
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    lat,
    lng,
    type,
    note: typeof note === "string" ? note.slice(0, 280) : "",
    region,
    createdAt: new Date().toISOString(),
    confirmations: 0,
  };
  reports.push(entry);
  await writeReports(env.EMERGENCY_KV, region, reports);
  return Response.json({ ok: true, report: { ...entry, trust: 100 } });
}
