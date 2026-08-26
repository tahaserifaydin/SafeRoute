// Canlı konum paylaşımı: KV'de rastgele bir id altında oturum oluşturur.
// TTL, sunucusuz ortamda "6 saat sonra otomatik silinsin" davranışını KV'nin
// kendi expirationTtl özelliğiyle sağlar (eski Node sunucusundaki bellek-içi
// pruneEmergencySessions'ın yerini alır).
const TTL_SECONDS = 6 * 60 * 60;

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { lat, lng, label } = body || {};
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const now = Date.now();
  const session = {
    label: typeof label === "string" ? label.slice(0, 60) : "",
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    startedAt: now,
    updatedAt: now,
    active: true,
  };
  await env.EMERGENCY_KV.put(id, JSON.stringify(session), { expirationTtl: TTL_SECONDS });
  return Response.json({ id });
}
