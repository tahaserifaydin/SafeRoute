const STOPPED_TTL_SECONDS = 10 * 60; // durdurulan oturum kısa süre "durduruldu" olarak görünsün, sonra silinsin

export async function onRequestPost({ env, params }) {
  const raw = await env.EMERGENCY_KV.get(params.id);
  if (raw) {
    const s = JSON.parse(raw);
    s.active = false;
    s.updatedAt = Date.now();
    await env.EMERGENCY_KV.put(params.id, JSON.stringify(s), { expirationTtl: STOPPED_TTL_SECONDS });
  }
  return Response.json({ ok: true });
}
