// Know Your Russia — single-file Bun HTTP server.
import { join, normalize } from "node:path";
import { db } from "./lib/db.js";
import {
  issueToken, currentUser, hashPassword, checkPassword,
} from "./lib/auth.js";
import { storeUpload, UPLOAD_ROOT, hasFfmpeg } from "./lib/media.js";
import { areasInBbox, featureById, pointInGeom } from "./lib/geo.js";

const PORT = Number(Bun.env.PORT) || 3000;
const MAX_UPLOAD = Number(Bun.env.MAX_UPLOAD_BYTES) || 512 * 1024 * 1024;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const err = (msg, status = 400) => json({ error: msg }, status);

const publicMedia = (m) => ({
  id: m.id,
  title: m.title,
  description: m.description,
  kind: m.kind,
  url: `/uploads/${m.filename}`,
  thumb: m.thumb ? `/uploads/${m.thumb}` : null,
  lat: m.lat,
  lng: m.lng,
  status: m.status,
  user_id: m.user_id,
  username: m.username,
  created_at: m.created_at,
});

async function serveStatic(baseDir, relPath) {
  const safe = normalize(relPath).replace(/^([/\\.]+)/, "");
  const abs = join(baseDir, safe);
  if (!abs.startsWith(normalize(baseDir))) return err("forbidden", 403);
  const file = Bun.file(abs);
  if (!(await file.exists())) return err("not found", 404);
  return new Response(file);
}

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const rx = new RegExp(
    "^" + pattern.replace(/:[a-zA-Z]+/g, (m) => {
      keys.push(m.slice(1));
      return "([^/]+)";
    }) + "$"
  );
  routes.push({ method, rx, keys, handler });
};

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw json({ error: "unauthorized" }, 401);
  return user;
}
function requireAdmin(req) {
  const user = requireUser(req);
  if (!user.is_admin) throw json({ error: "forbidden" }, 403);
  return user;
}

// Auth
route("POST", "/api/register", async (req) => {
  const { username, password } = await req.json().catch(() => ({}));
  if (!username || !password) return err("username and password required");
  if (String(username).length < 3) return err("username too short (min 3)");
  if (String(password).length < 6) return err("password too short (min 6)");
  const exists = db.query("SELECT id FROM users WHERE username = ?").get(username);
  if (exists) return err("username taken", 409);
  const hash = await hashPassword(String(password));
  const info = db
    .query("INSERT INTO users (username, password_hash) VALUES (?, ?)")
    .run(String(username), hash);
  const user = { id: info.lastInsertRowid, username, is_admin: 0 };
  return json({ token: issueToken(user), user: { id: user.id, username, is_admin: 0 } });
});

route("POST", "/api/login", async (req) => {
  const { username, password } = await req.json().catch(() => ({}));
  if (!username || !password) return err("username and password required");
  const user = db.query("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !(await checkPassword(String(password), user.password_hash)))
    return err("invalid credentials", 401);
  return json({
    token: issueToken(user),
    user: { id: user.id, username: user.username, is_admin: user.is_admin },
  });
});

route("GET", "/api/me", (req) => {
  const user = requireUser(req);
  return json({ id: user.id, username: user.username, is_admin: user.is_admin });
});

route("GET", "/api/me/media", (req) => {
  const user = requireUser(req);
  const rows = db.query(
    `SELECT m.*, u.username FROM media m JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? ORDER BY m.created_at DESC`
  ).all(user.id);
  return json(rows.map(publicMedia));
});

route("GET", "/api/users/:id", (req, p) => {
  const u = db.query("SELECT id, username, created_at, is_admin FROM users WHERE id = ?").get(p.id);
  if (!u) return err("user not found", 404);
  const media = db.query(
    `SELECT m.*, u.username FROM media m JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? AND m.status = 'approved' ORDER BY m.created_at DESC`
  ).all(p.id);
  return json({ user: u, media: media.map(publicMedia) });
});

// Media upload & points
route("POST", "/api/media", async (req) => {
  const user = requireUser(req);
  const form = await req.formData().catch(() => null);
  if (!form) return err("multipart/form-data required");
  const file = form.get("file");
  const title = String(form.get("title") || "").trim();
  const description = String(form.get("description") || "").trim();
  const lat = Number(form.get("lat"));
  const lng = Number(form.get("lng"));

  if (!(file instanceof File) || file.size === 0) return err("file required");
  if (file.size > MAX_UPLOAD) return err("file too large", 413);
  if (!title) return err("title required");
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return err("invalid lat");
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return err("invalid lng");

  let stored;
  try {
    stored = await storeUpload(file);
  } catch (e) {
    return err(e.message, 415);
  }

  const info = db.query(
    `INSERT INTO media (user_id, title, description, kind, filename, thumb, mime, size, lat, lng)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, title, description, stored.kind, stored.filename,
        stored.thumb, stored.mime, stored.size, lat, lng);

  const row = db.query(
    `SELECT m.*, u.username FROM media m JOIN users u ON u.id = m.user_id WHERE m.id = ?`
  ).get(info.lastInsertRowid);
  return json(publicMedia(row), 201);
});

route("GET", "/api/points", (req) => {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("bbox") || "").split(",").map(Number);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 2000, 5000);
  let sql = `SELECT m.id, m.title, m.kind, m.thumb, m.lat, m.lng
             FROM media m WHERE m.status = 'approved'`;
  const args = [];
  if (raw.length === 4 && raw.every(Number.isFinite)) {
    const [west, south, east, north] = raw;
    sql += " AND m.lat BETWEEN ? AND ? AND m.lng BETWEEN ? AND ?";
    args.push(Math.min(south, north), Math.max(south, north),
              Math.min(west, east), Math.max(west, east));
  }
  sql += " ORDER BY m.created_at DESC LIMIT ?";
  args.push(limit);
  const rows = db.query(sql).all(...args);
  return json(rows.map((m) => ({
    id: m.id, title: m.title, kind: m.kind, lat: m.lat, lng: m.lng,
    thumb: m.thumb ? `/uploads/${m.thumb}` : null,
  })));
});

// Administrative areas (level 1 = region / oblast, level 2 = rayon / district)
route("GET", "/api/areas", (req) => {
  const url = new URL(req.url);
  const level = Number(url.searchParams.get("level")) === 2 ? 2 : 1;
  const raw = (url.searchParams.get("bbox") || "").split(",").map(Number);
  const bbox = raw.length === 4 && raw.every(Number.isFinite) ? raw : null;

  const areas = areasInBbox(level, bbox);
  if (!areas.length) return json({ type: "FeatureCollection", features: [] });

  // Get approved media to compute count per area
  const approved = db.query(
    "SELECT id, kind, lat, lng FROM media WHERE status = 'approved'"
  ).all();

  const features = areas.slice(0, 500).map((a) => {
    let photos = 0, videos = 0;
    for (const m of approved) {
      if (pointInGeom(m.lng, m.lat, a.geometry)) {
        if (m.kind === "video") videos++; else photos++;
      }
    }
    return {
      type: "Feature",
      properties: {
        id: a.id,
        name: a.name,
        iso: a.iso,
        level,
        photos,
        videos,
        total: photos + videos,
      },
      geometry: a.geometry,
    };
  });

  return json({ type: "FeatureCollection", features });
});

// Media inside a specific administrative area
route("GET", "/api/areas/:level/:id/media", (req, p) => {
  const level = Number(p.level) === 2 ? 2 : 1;
  const feat = featureById(level, p.id);
  if (!feat) return err("area not found", 404);

  const rows = db.query(
    `SELECT m.*, u.username FROM media m JOIN users u ON u.id = m.user_id
     WHERE m.status = 'approved' ORDER BY m.created_at DESC`
  ).all();

  const inArea = rows.filter((m) => pointInGeom(m.lng, m.lat, feat.geometry));
  return json({
    area: { id: feat.id, name: feat.name, iso: feat.iso, level },
    media: inArea.map(publicMedia),
  });
});

route("GET", "/api/media/:id", (req, p) => {
  const row = db.query(
    `SELECT m.*, u.username FROM media m JOIN users u ON u.id = m.user_id WHERE m.id = ?`
  ).get(p.id);
  if (!row) return err("not found", 404);
  if (row.status !== "approved") {
    const user = currentUser(req);
    if (!user || (user.id !== row.user_id && !user.is_admin))
      return err("not found", 404);
  }
  return json(publicMedia(row));
});

// Admin
route("GET", "/api/admin/pending", (req) => {
  requireAdmin(req);
  const rows = db.query(
    `SELECT m.*, u.username FROM media m JOIN users u ON u.id = m.user_id
     WHERE m.status = 'pending' ORDER BY m.created_at ASC`
  ).all();
  return json(rows.map(publicMedia));
});

const review = (status) => (req, p) => {
  const admin = requireAdmin(req);
  const m = db.query("SELECT id FROM media WHERE id = ?").get(p.id);
  if (!m) return err("not found", 404);
  db.query(
    `UPDATE media SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`
  ).run(status, admin.id, p.id);
  return json({ id: Number(p.id), status });
};
route("POST", "/api/admin/media/:id/approve", review("approved"));
route("POST", "/api/admin/media/:id/reject", review("rejected"));

Bun.serve({
  port: PORT,
  maxRequestBodySize: MAX_UPLOAD + 8 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    if (path.startsWith("/uploads/")) {
      return serveStatic(UPLOAD_ROOT, path.slice("/uploads/".length));
    }

    if (path.startsWith("/api/")) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const match = r.rx.exec(path);
        if (!match) continue;
        const params = {};
        r.keys.forEach((k, i) => (params[k] = match[i + 1]));
        try {
          return await r.handler(req, params);
        } catch (thrown) {
          if (thrown instanceof Response) return thrown;
          console.error("[500]", req.method, path, thrown);
          return err("internal error", 500);
        }
      }
      return err("not found", 404);
    }

    if (path === "/") return serveStatic("public", "index.html");
    return serveStatic("public", path.slice(1));
  },
});

console.log(`KYR running on http://localhost:${PORT}`);
