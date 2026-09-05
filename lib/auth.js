// Auth: bcrypt password hashing (Bun.password) + hand-rolled HS256 JWT.
// No external deps — node:crypto is enough for a self-contained service.
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "./db.js";

const SECRET = Bun.env.JWT_SECRET || "change-me-in-production";
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const b64url = (buf) =>
  Buffer.from(buf).toString("base64url");

const sign = (data) =>
  createHmac("sha256", SECRET).update(data).digest("base64url");

export function issueToken(user) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: user.id,
      username: user.username,
      admin: !!user.is_admin,
      exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    })
  );
  const body = `${header}.${payload}`;
  return `${body}.${sign(body)}`;
}

export function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = sign(`${header}.${payload}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

// Resolve the current user from a request's Authorization header.
export function currentUser(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const claims = verifyToken(token);
  if (!claims) return null;
  return db
    .query("SELECT id, username, is_admin, created_at, bio, avatar FROM users WHERE id = ?")
    .get(claims.sub);
}

export const hashPassword = (p) => Bun.password.hash(p);
export const checkPassword = (p, hash) => Bun.password.verify(p, hash);
