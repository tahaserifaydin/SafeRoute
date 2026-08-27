export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const regionId = url.searchParams.get("region");
  const raw = await env.EMERGENCY_KV.get("study-responses");
  const all = raw ? JSON.parse(raw) : [];
  const filtered = regionId ? all.filter((r) => r.region === regionId) : all;
  const total = filtered.length;
  const safeChosen = filtered.filter((r) => r.chosenIsSafe).length;
  const avgDetourPct = total
    ? filtered.reduce((s, r) => {
        const fastD = r.safeIsA ? r.distanceB : r.distanceA;
        const safeD = r.safeIsA ? r.distanceA : r.distanceB;
        return s + (fastD ? ((safeD - fastD) / fastD) * 100 : 0);
      }, 0) / total
    : null;

  return Response.json({
    total,
    safeChosen,
    safeChosenPct: total ? Math.round((safeChosen / total) * 100) : null,
    avgDetourPct: avgDetourPct != null ? Math.round(avgDetourPct * 10) / 10 : null,
  });
}
