export const perfStats = {};

export function perfAdd(name, ms) {
  if (!perfStats[name]) perfStats[name] = { total: 0, count: 0, max: 0, min: Infinity };
  const s = perfStats[name];
  s.total += ms; s.count += 1; s.max = Math.max(s.max, ms); s.min = Math.min(s.min, ms);
}

export async function perfMeasureAsync(name, fn) {
  const t0 = performance.now();
  const res = await fn();
  const dt = performance.now() - t0;
  perfAdd(name, dt);
  return [res, dt];
}

export function perfSummaryLines() {
  const entries = Object.entries(perfStats)
    .map(([k, v]) => ({ name: k, total: v.total, count: v.count, avg: v.total / Math.max(1, v.count) }))
    .sort((a, b) => b.total - a.total);
  return entries.map(e => `${e.name}: ${Math.round(e.total)}ms total (${e.count}x, avg ${Math.round(e.avg)}ms)`);
}

