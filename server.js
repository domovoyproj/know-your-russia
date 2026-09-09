// Know Your Russia — single-file Bun HTTP server.
import { join, normalize } from "node:path";
import { db } from "./lib/db.js";
import {
  issueToken, currentUser, hashPassword, checkPassword,
} from "./lib/auth.js";
import { storeUpload, storeAvatar, deleteFiles, UPLOAD_ROOT, hasFfmpeg } from "./lib/media.js";
import { areasInBbox, featureById, pointInGeom, areaOfPoint } from "./lib/geo.js";

const PORT = Number(Bun.env.PORT) || 3000;
const MAX_UPLOAD = Number(Bun.env.MAX_UPLOAD_BYTES) || 512 * 1024 * 1024;
const AVATAR_MAX = 4 * 1024 * 1024;

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
  size: m.size,
  status: m.status,
  review_note: m.review_note || "",
  reviewed_at: m.reviewed_at || null,
  user_id: m.user_id,
  username: m.username,
  created_at: m.created_at,
});

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  is_admin: u.is_admin,
  created_at: u.created_at,
  bio: u.bio || "",
  avatar: u.avatar ? `/uploads/${u.avatar}` : null,
});

// Profile counters. `ownView` includes pending/rejected rows; public view does not.
function statsFor(userId, ownView) {
  const rows = db.query(
    `SELECT status, kind, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes
     FROM media WHERE user_id = ? GROUP BY status, kind`
  ).all(userId);
  const s = { total: 0, approved: 0, pending: 0, rejected: 0, photos: 0, videos: 0, bytes: 0 };
  for (const r of rows) {
    if (!ownView && r.status !== "approved") continue;
    s.total += r.n;
    s[r.status] += r.n;
    if (r.kind === "video") s.videos += r.n; else s.photos += r.n;
    s.bytes += r.bytes;
  }
  return s;
}

// Media rows carrying the region they fall into — powers profile geography.
// The ISO code travels along so the client can show the Russian region name.
const withArea = (rows) => rows.map((m) => {
  const area = areaOfPoint(m.lng, m.lat, 1);
  return {
    ...publicMedia(m),
    region: area ? area.name : null,
    region_iso: area ? area.iso : null,
  };
});

const geographyOf = (media) => {
  const byRegion = new Map();
  for (const m of media) {
    if (!m.region) continue;
    const cur = byRegion.get(m.region) || { name: m.region, iso: m.region_iso, count: 0 };
    cur.count++;
    byRegion.set(m.region, cur);
  }
  return [...byRegion.values()].sort((a, b) => b.count - a.count);
};

const userMedia = (userId, approvedOnly) => withArea(db.query(
  `SELECT m.*, u.username FROM media m JOIN users u ON u.id = m.user_id
   WHERE m.user_id = ?${approvedOnly ? " AND m.status = 'approved'" : ""}
   ORDER BY m.created_at DESC`
).all(userId));

async function serveStatic(baseDir, relPath) {
  const safe = normalize(relPath).replace(/^([/\\.]+)/, "");
  const abs = join(baseDir, safe);
  if (!abs.startsWith(normalize(baseDir))) return err("forbidden", 403);
  const file = Bun.file(abs);
  if (!(await file.exists())) return err("not found", 404);
  
  const headers = {};
  if (abs.endsWith(".apk")) {
    headers["content-type"] = "application/vnd.android.package-archive";
    headers["content-disposition"] = 'attachment; filename="kyr.apk"';
  } else if (abs.endsWith(".webmanifest")) {
    headers["content-type"] = "application/manifest+json; charset=utf-8";
  }
  return new Response(file, { headers });
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
  const user = db.query("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  return json({ token: issueToken(user), user: publicUser(user) });
});

route("POST", "/api/login", async (req) => {
  const { username, password } = await req.json().catch(() => ({}));
  if (!username || !password) return err("username and password required");
  const user = db.query("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !(await checkPassword(String(password), user.password_hash)))
    return err("invalid credentials", 401);
  return json({ token: issueToken(user), user: publicUser(user) });
});

route("GET", "/api/me", (req) => json(publicUser(requireUser(req))));

// Everything the personal cabinet renders in one round-trip.
route("GET", "/api/me/profile", (req) => {
  const user = requireUser(req);
  const media = userMedia(user.id, false);
  return json({
    user: publicUser(user),
    stats: statsFor(user.id, true),
    geography: geographyOf(media),
    media,
  });
});

route("PATCH", "/api/me", async (req) => {
  const user = requireUser(req);
  const { bio } = await req.json().catch(() => ({}));
  if (bio === undefined) return err("nothing to update");
  const next = String(bio).trim().slice(0, 500);
  db.query("UPDATE users SET bio = ? WHERE id = ?").run(next, user.id);
  return json(publicUser({ ...user, bio: next }));
});

route("POST", "/api/me/avatar", async (req) => {
  const user = requireUser(req);
  const form = await req.formData().catch(() => null);
  const file = form && form.get("file");
  if (!(file instanceof File) || file.size === 0) return err("file required");
  if (file.size > AVATAR_MAX) return err("avatar too large (max 4 MB)", 413);

  let rel;
  try { rel = await storeAvatar(file); } catch (e) { return err(e.message, 415); }
  db.query("UPDATE users SET avatar = ? WHERE id = ?").run(rel, user.id);
  if (user.avatar) deleteFiles(user.avatar);
  return json(publicUser({ ...user, avatar: rel }));
});

route("DELETE", "/api/me/avatar", (req) => {
  const user = requireUser(req);
  db.query("UPDATE users SET avatar = NULL WHERE id = ?").run(user.id);
  if (user.avatar) deleteFiles(user.avatar);
  return json(publicUser({ ...user, avatar: null }));
});

route("POST", "/api/me/password", async (req) => {
  const user = requireUser(req);
  const { current, next } = await req.json().catch(() => ({}));
  if (!current || !next) return err("current and next password required");
  if (String(next).length < 6) return err("password too short (min 6)");
  const row = db.query("SELECT password_hash FROM users WHERE id = ?").get(user.id);
  if (!(await checkPassword(String(current), row.password_hash)))
    return err("wrong current password", 403);
  db.query("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(await hashPassword(String(next)), user.id);
  return json({ ok: true });
});

route("GET", "/api/users/:id", (req, p) => {
  const u = db.query(
    "SELECT id, username, created_at, is_admin, bio, avatar FROM users WHERE id = ?"
  ).get(p.id);
  if (!u) return err("user not found", 404);
  const media = userMedia(u.id, true);
  return json({
    user: publicUser(u),
    stats: statsFor(u.id, false),
    geography: geographyOf(media),
    media,
  });
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

// Author (or admin) edits their own submission.
route("PATCH", "/api/media/:id", async (req, p) => {
  const user = requireUser(req);
  const row = db.query("SELECT * FROM media WHERE id = ?").get(p.id);
  if (!row) return err("not found", 404);
  if (row.user_id !== user.id && !user.is_admin) return err("forbidden", 403);

  const { title, description } = await req.json().catch(() => ({}));
  const nextTitle = String(title ?? row.title).trim();
  if (!nextTitle) return err("title required");
  const nextDesc = String(description ?? row.description).trim().slice(0, 2000);

  // Premoderation invariant: republished text must be re-checked, so an author
  // editing an approved item sends it back to the queue. Admin edits do not.
  const requeue = !user.is_admin && row.status === "approved";
  db.query(
    `UPDATE media SET title = ?, description = ?, status = ?, review_note = ?,
     reviewed_by = ?, reviewed_at = ? WHERE id = ?`
  ).run(
    nextTitle.slice(0, 120), nextDesc,
    requeue ? "pending" : row.status,
    requeue ? "" : row.review_note,
    requeue ? null : row.reviewed_by,
    requeue ? null : row.reviewed_at,
    row.id
  );
  const fresh = db.query(
    `SELECT m.*, u.username FROM media m JOIN users u ON u.id = m.user_id WHERE m.id = ?`
  ).get(row.id);
  return json({ ...publicMedia(fresh), requeued: requeue });
});

route("DELETE", "/api/media/:id", (req, p) => {
  const user = requireUser(req);
  const row = db.query("SELECT * FROM media WHERE id = ?").get(p.id);
  if (!row) return err("not found", 404);
  if (row.user_id !== user.id && !user.is_admin) return err("forbidden", 403);
  db.query("DELETE FROM media WHERE id = ?").run(row.id);
  deleteFiles(row.filename, row.thumb);
  return json({ id: row.id, deleted: true });
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

const review = (status) => async (req, p) => {
  const admin = requireAdmin(req);
  const m = db.query("SELECT id FROM media WHERE id = ?").get(p.id);
  if (!m) return err("not found", 404);
  const body = await req.json().catch(() => ({}));
  const note = String((body && body.note) || "").trim().slice(0, 500);
  db.query(
    `UPDATE media SET status = ?, review_note = ?, reviewed_by = ?,
     reviewed_at = datetime('now') WHERE id = ?`
  ).run(status, note, admin.id, p.id);
  return json({ id: Number(p.id), status, review_note: note });
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
