// Rapor client'tan yalnızca id ile geliyor (hangi bölgede olduğu bilinmiyor);
// bölge sayısı az olduğundan tüm bölgelerde arayıp buluyoruz.
const REGION_IDS = ["eindhoven", "nuenen", "bornova", "buca", "gaziemir", "alsancak", "mustafakemalpasa"];

export async function onRequestPost({ env, params }) {
  for (const region of REGION_IDS) {
    const raw = await env.EMERGENCY_KV.get(`reports:${region}`);
    if (!raw) continue;
    const reports = JSON.parse(raw);
    const idx = reports.findIndex((r) => r.id === params.id);
    if (idx === -1) continue;
    reports[idx].confirmations = (reports[idx].confirmations || 0) + 1;
    await env.EMERGENCY_KV.put(`reports:${region}`, JSON.stringify(reports));
    return Response.json({ ok: true, confirmations: reports[idx].confirmations });
  }
  return Response.json({ error: "Rapor bulunamadı" }, { status: 404 });
}
