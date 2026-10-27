// Response headers and request rate limits.
//
// Every response gets anti-sniffing, anti-framing, referrer and cross-origin isolation headers. HTML
// responses also get a Content Security Policy: scripts only from this origin plus the exact inline
// theme script (by SHA-256 of what is served), no plugins, no framing, no external connections.
// Inline style attributes are still used by the templates, so style-src-attr allows them; style
// elements and sheets must come from this origin.
//
// Rate limits are per client address and per bucket, in fixed one-minute windows, held in this
// process only. They slow down abuse of one instance; several instances behind a load balancer
// would each count separately (a shared store is a production item).
const crypto = require('node:crypto');

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
};
const inlineHashes = new Map();
function scriptHashes(html) {
  if (inlineHashes.has(html)) return inlineHashes.get(html);
  // Browsers hash the script as parsed, and the HTML parser turns CRLF and lone CR into LF first.
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`);
  inlineHashes.clear(); inlineHashes.set(html, hashes);
  return hashes;
}
function contentSecurityPolicy(html) {
  return [
    "default-src 'self'", `script-src 'self' ${scriptHashes(html).join(' ')}`.trim(), "style-src 'self'", "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"
  ].join('; ');
}
function securityHeaders(type, body) {
  return String(type).startsWith('text/html') ? { ...BASE_HEADERS, 'Content-Security-Policy': contentSecurityPolicy(String(body)) } : { ...BASE_HEADERS };
}

const DEFAULT_LIMITS = { windowMs: 60000, read: 1200, write: 240, simulation: 60 };
function rateBucket(method, pathname) { return method === 'GET' || method === 'HEAD' ? 'read' : pathname === '/api/v1/simulations/correction' ? 'simulation' : 'write'; }
function createRateLimiter(limits = DEFAULT_LIMITS, now = () => Date.now()) {
  const windows = new Map();
  return {
    // Returns 0 when the request may go ahead, otherwise the seconds until the window resets.
    take(client, bucket) {
      const limit = limits[bucket]; if (!limit) return 0;
      const t = now(); const key = `${bucket}|${client}`;
      let w = windows.get(key);
      if (!w || t - w.start >= limits.windowMs) { w = { start: t, count: 0 }; windows.set(key, w); }
      if (windows.size > 10000) for (const [k, v] of windows) if (t - v.start >= limits.windowMs) windows.delete(k);
      w.count++;
      return w.count > limit ? Math.max(1, Math.ceil((w.start + limits.windowMs - t) / 1000)) : 0;
    }
  };
}

module.exports = { BASE_HEADERS, securityHeaders, contentSecurityPolicy, createRateLimiter, rateBucket, DEFAULT_LIMITS };
