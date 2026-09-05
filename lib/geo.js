// Administrative-boundary lookups: load simplified GeoJSON once, answer
// "which areas are in this bbox" and "is this point inside this area".
import { readFileSync, existsSync } from "node:fs";

const cache = {}; // level -> features | null

function bboxOf(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const scan = (c) => {
    if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0];
    if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
  };
  const walk = (a) => { if (typeof a[0] === "number") scan(a); else for (const b of a) walk(b); };
  walk(geom.coordinates);
  return [w, s, e, n];
}

function load(level) {
  if (cache[level] !== undefined) return cache[level];
  const path = `public/geo/adm${level}.min.json`;
  if (!existsSync(path)) {
    console.warn(`[geo] ${path} missing — area layer disabled for level ${level}`);
    return (cache[level] = null);
  }
  const gj = JSON.parse(readFileSync(path, "utf8"));
  const feats = gj.features.map((f, i) => ({
    id: f.properties.id ?? i,
    name: f.properties.shapeName || `#${i}`,
    iso: f.properties.shapeISO || null,
    geometry: f.geometry,
    bbox: bboxOf(f.geometry),
  }));
  console.log(`[geo] loaded adm${level}: ${feats.length} features`);
  return (cache[level] = feats);
}

export function areasInBbox(level, bbox) {
  const feats = load(level);
  if (!feats) return [];
  if (!bbox) return feats;
  const [w, s, e, n] = bbox;
  return feats.filter((f) => {
    const [fw, fs, fe, fn] = f.bbox;
    return !(fe < w || fw > e || fn < s || fs > n);
  });
}

export function featureById(level, id) {
  const feats = load(level);
  if (!feats) return null;
  return feats.find((f) => String(f.id) === String(id)) || null;
}

// Ray-casting point-in-polygon with hole support.
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolygon(x, y, rings) {
  if (!inRing(x, y, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(x, y, rings[k])) return false; // hole
  return true;
}
export function pointInGeom(x, y, geom) {
  if (geom.type === "Polygon") return inPolygon(x, y, geom.coordinates);
  if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) if (inPolygon(x, y, poly)) return true;
  }
  return false;
}

// First administrative area containing the point — used for profile geography.
export function areaOfPoint(x, y, level = 1) {
  const feats = load(level);
  if (!feats) return null;
  for (const f of feats) {
    const [w, s, e, n] = f.bbox;
    if (x < w || x > e || y < s || y > n) continue;
    if (pointInGeom(x, y, f.geometry)) return { id: f.id, name: f.name, iso: f.iso };
  }
  return null;
}
