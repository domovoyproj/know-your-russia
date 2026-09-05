// One-off: shrink raw geoBoundaries GeoJSON into map-ready *.min.json.
// Rounds coordinates to 4 decimals (~11 m), drops duplicate points, and runs
// Douglas-Peucker so the browser/server handle kilobytes, not tens of MB.
//   bun scripts/simplify-geo.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const R = 1e4;
const round = (v) => Math.round(v * R) / R;

function segDist(p, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - ax, p[1] - ay);
  let t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
}

function douglasPeucker(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let idx = -1, dmax = 0;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], ax, ay, bx, by);
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function ring(r, eps) {
  let pts = r.map((c) => [round(c[0]), round(c[1])]);
  const dedup = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = dedup[dedup.length - 1], b = pts[i];
    if (a[0] !== b[0] || a[1] !== b[1]) dedup.push(b);
  }
  let s = douglasPeucker(dedup, eps);
  if (s.length && (s[0][0] !== s[s.length - 1][0] || s[0][1] !== s[s.length - 1][1])) s.push(s[0]);
  return s.length >= 4 ? s : (dedup.length >= 4 ? dedup : null);
}
const poly = (p, eps) => p.map((r) => ring(r, eps)).filter(Boolean);

function simplify(g, eps) {
  if (g.type === "Polygon") return { type: "Polygon", coordinates: poly(g.coordinates, eps).filter((r) => r.length) };
  if (g.type === "MultiPolygon")
    return { type: "MultiPolygon", coordinates: g.coordinates.map((p) => poly(p, eps)).filter((p) => p.length) };
  return g;
}

for (const [lvl, eps] of [["adm1", 0.012], ["adm2", 0.006]]) {
  const src = `public/geo/${lvl}.geojson`;
  if (!existsSync(src)) { console.warn(`skip ${src} (missing)`); continue; }
  const gj = JSON.parse(readFileSync(src, "utf8"));
  const features = gj.features.map((f, i) => ({
    type: "Feature",
    properties: { id: i, shapeName: f.properties.shapeName, shapeISO: f.properties.shapeISO || null },
    geometry: simplify(f.geometry, eps),
  }));
  const out = `public/geo/${lvl}.min.json`;
  writeFileSync(out, JSON.stringify({ type: "FeatureCollection", features }));
  console.log(`${out}: ${features.length} features`);
}
