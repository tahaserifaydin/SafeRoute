const TTL_SECONDS = 6 * 60 * 60;

export async function onRequestPost({ request, env, params }) {
  const raw = await env.EMERGENCY_KV.get(params.id);
  if (!raw) {
    return Response.json({ error: "Oturum bulunamadı (süresi dolmuş olabilir)" }, { status: 404 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { lat, lng } = body || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return Response.json({ error: "lat ve lng zorunlu" }, { status: 400 });
  }
  const s = JSON.parse(raw);
  s.lat = lat;
  s.lng = lng;
  s.updatedAt = Date.now();
  // Ping her seferinde TTL'i yeniler ki aktif takip 6 saatten önce sessizce silinmesin.
  await env.EMERGENCY_KV.put(params.id, JSON.stringify(s), { expirationTtl: TTL_SECONDS });
  return Response.json({ ok: true });
}
