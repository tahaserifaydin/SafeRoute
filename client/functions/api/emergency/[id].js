export async function onRequestGet({ env, params }) {
  const raw = await env.EMERGENCY_KV.get(params.id);
  if (!raw) {
    return Response.json({ error: "Oturum bulunamadı (süresi dolmuş olabilir)" }, { status: 404 });
  }
  const s = JSON.parse(raw);
  return Response.json({
    label: s.label,
    lat: s.lat,
    lng: s.lng,
    active: s.active,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    ageSeconds: Math.round((Date.now() - s.updatedAt) / 1000),
  });
}
