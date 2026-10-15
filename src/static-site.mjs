import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function createStaticSite({ dir, log = console } = {}) {
  const root = resolve(dir);
  const indexFile = join(root, "index.html");

  function sendFile(req, res, file, { index = false } = {}) {
    const body = readFileSync(file);
    const extension = extname(file).toLowerCase();
    const immutable = !index && /[-.][A-Za-z0-9_-]{8,}\.[^.]+$/.test(file);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": index ? "no-cache, no-store, must-revalidate" : immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      "Content-Security-Policy": CSP,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
  }

  return {
    serve(req, res, pathname) {
      if (!["GET", "HEAD"].includes(req.method)) return false;
      let decoded;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        return false;
      }
      const relative = normalize(decoded).replace(/^([/\\])+/, "");
      const candidate = resolve(root, relative);
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return false;
      if (relative && existsSync(candidate) && statSync(candidate).isFile()) {
        sendFile(req, res, candidate);
        return true;
      }
      const acceptsHtml = String(req.headers.accept ?? "").includes("text/html");
      if (acceptsHtml && existsSync(indexFile)) {
        sendFile(req, res, indexFile, { index: true });
        return true;
      }
      if (!existsSync(indexFile)) log.error?.(`管理控制台构建产物缺失：${indexFile}`);
      return false;
    },
  };
}
