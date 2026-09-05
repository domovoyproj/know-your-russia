// Local-disk media storage + preview generation.
// Files land in uploads/<yyyy>/<mm>/. Previews are made with ffmpeg when it is
// on PATH (works for both images and video posters); otherwise we degrade
// gracefully and the frontend falls back to the original / a placeholder.
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const UPLOAD_ROOT = "uploads";
mkdirSync(UPLOAD_ROOT, { recursive: true });

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const VIDEO_MIME = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"]);

const EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "image/gif": "gif", "image/avif": "avif",
  "video/mp4": "mp4", "video/webm": "webm",
  "video/quicktime": "mov", "video/x-matroska": "mkv",
};

// Detect ffmpeg once at startup.
let ffmpegPath = null;
try {
  const which = Bun.spawnSync(
    [process.platform === "win32" ? "where" : "which", "ffmpeg"],
  );
  if (which.exitCode === 0) {
    ffmpegPath = which.stdout.toString().trim().split(/\r?\n/)[0] || "ffmpeg";
  }
} catch { /* no ffmpeg */ }
export const hasFfmpeg = !!ffmpegPath;
console.log(`[media] ffmpeg previews: ${hasFfmpeg ? "on" : "off (serving originals)"}`);

export function classify(mime) {
  if (IMAGE_MIME.has(mime)) return "image";
  if (VIDEO_MIME.has(mime)) return "video";
  return null;
}

// Persist an uploaded File to disk. Returns { filename, kind, thumb, size, mime }.
export async function storeUpload(file) {
  const mime = file.type;
  const kind = classify(mime);
  if (!kind) throw new Error(`unsupported media type: ${mime || "unknown"}`);

  const now = new Date();
  const dir = join(
    UPLOAD_ROOT,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0")
  );
  mkdirSync(dir, { recursive: true });

  const id = randomUUID();
  const ext = EXT[mime] || "bin";
  const rel = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}.${ext}`;
  const abs = join(UPLOAD_ROOT, rel);

  const bytes = await file.arrayBuffer();
  await Bun.write(abs, bytes);

  const thumb = await makeThumb(abs, rel, kind);
  return { filename: rel, kind, thumb, size: bytes.byteLength, mime };
}

// Generate a 480px-wide JPEG preview next to the original. Returns rel path or null.
async function makeThumb(absSource, relSource, kind) {
  if (!hasFfmpeg) return null;
  const relThumb = relSource.replace(/\.[^.]+$/, "") + ".thumb.jpg";
  const absThumb = join(UPLOAD_ROOT, relThumb);
  // For video, grab a frame ~1s in; for images, just rescale.
  const args = kind === "video"
    ? ["-ss", "1", "-i", absSource, "-frames:v", "1",
       "-vf", "scale=480:-2", "-y", absThumb]
    : ["-i", absSource, "-vf", "scale=480:-2", "-frames:v", "1", "-y", absThumb];
  try {
    const proc = Bun.spawnSync([ffmpegPath, "-loglevel", "error", ...args]);
    if (proc.exitCode === 0 && existsSync(absThumb)) return relThumb;
  } catch { /* fall through */ }
  return null;
}
