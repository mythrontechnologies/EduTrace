'use strict';

// Local-only router for the two separately configured judge backends. It never starts or changes a backend.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { hostedEnvironment } = require('../src/mode');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const MAX_RUNTIME_BYTES = 16 * 1024;
const ROUTES = Object.freeze([
  { prefix: '/demo', expectedMode: 'demo', key: 'demo' },
  { prefix: '/synthetic', expectedMode: 'synthetic-test', key: 'synthetic' }
]);

class FrontDoorError extends Error { constructor(message) { super(message); this.name = 'FrontDoorError'; } }

function validPort(value, label, { allowZero = false } = {}) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65535) throw new FrontDoorError(`${label} must be ${allowZero ? 'an integer from 0' : 'an integer from 1'} to 65535.`);
  return port;
}

function backendRuntime(target) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: target.host, port: target.port, path: '/api/v1/runtime', timeout: 1200, headers: { host: `${target.host}:${target.port}`, accept: 'application/json' } }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RUNTIME_BYTES) { request.destroy(new Error('Runtime response exceeded its limit.')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error(`Backend runtime returned HTTP ${response.statusCode}.`);
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof payload?.data?.mode !== 'string') throw new Error('Backend runtime did not identify its mode.');
          resolve(payload.data.mode);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Backend runtime check timed out.')));
    request.on('error', reject);
  });
}

function send(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

function errorResponse(req, res, route, status, message) {
  req.resume();
  const accept = String(req.headers.accept || '');
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (accept.includes('text/html') && (pathname.endsWith('/') || pathname.endsWith('.html'))) {
    const title = `${route.expectedMode === 'demo' ? 'Demo Mode' : 'Synthetic Test Mode'} unavailable`;
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:12vh auto;padding:0 1.25rem;color:#142D43"><p><a href="/">← EduTrace AI</a></p><h1>${title}</h1><p>${message}</p><p>Check that this mode's local backend is running with the expected configuration, then reload.</p></body></html>`;
    return send(res, status, html, 'text/html; charset=utf-8');
  }
  if (pathname.includes('/api/')) return send(res, status, JSON.stringify({ error: message, code: status === 503 ? 'judge_backend_unavailable' : 'judge_backend_mode_mismatch', mode: route.expectedMode }), 'application/json; charset=utf-8');
  send(res, status, message, 'text/plain; charset=utf-8');
}

function stripPrefix(url, prefix) {
  const rest = url.slice(prefix.length);
  return rest ? (rest.startsWith('/') ? rest : `/${rest}`) : '/';
}

function rewriteSetCookie(value, prefix) {
  const cookiePath = `${prefix}/`;
  const replacePath = cookie => /;\s*Path=/i.test(cookie)
    ? cookie.replace(/;\s*Path=[^;]*/i, `; Path=${cookiePath}`)
    : `${cookie}; Path=${cookiePath}`;
  return Array.isArray(value) ? value.map(replacePath) : replacePath(value);
}

function scopedHeaders(headers, route) {
  const out = { ...headers };
  delete out.connection; delete out['keep-alive']; delete out['proxy-authenticate']; delete out['proxy-authorization'];
  delete out['transfer-encoding']; delete out.upgrade;
  if (route.key === 'demo' && out['set-cookie']) out['set-cookie'] = rewriteSetCookie(out['set-cookie'], route.prefix);
  else delete out['set-cookie'];
  if (out.location && String(out.location).startsWith('/')) out.location = `${route.prefix}${out.location}`;
  return out;
}

function forwardedHeaders(incoming, route, target) {
  const headers = { ...incoming, host: `${target.host}:${target.port}` };
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'upgrade', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto']) delete headers[name];
  // A session or authorization header from one mount must not be reused by the other backend.
  if (route.key === 'synthetic') {
    for (const name of ['cookie', 'authorization', 'x-demo-role', 'x-demo-institution', 'x-csrf-token']) delete headers[name];
  } else {
    delete headers['x-edutrace-test-institution'];
  }
  return headers;
}

function createFrontDoor({ demo = { host: '127.0.0.1', port: 3101 }, synthetic = { host: '127.0.0.1', port: 3102 }, publicDir = PUBLIC } = {}) {
  for (const target of [demo, synthetic]) {
    if (!target || target.host !== '127.0.0.1' || !Number.isInteger(Number(target.port)) || Number(target.port) < 1 || Number(target.port) > 65535) throw new FrontDoorError('Judge backends must use valid 127.0.0.1 ports.');
  }
  if (Number(demo.port) === Number(synthetic.port)) throw new FrontDoorError('Demo and Synthetic Test backends must use different ports.');
  const targets = { demo, synthetic };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        const body = fs.readFileSync(path.join(publicDir, 'judge-entry.html'));
        return send(res, 200, body, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, JSON.stringify({ status: 'ok', local_only: true }), 'application/json; charset=utf-8');
      const route = ROUTES.find(item => url.pathname === item.prefix || url.pathname.startsWith(`${item.prefix}/`));
      if (!route) return send(res, 404, 'Not found. Open the local EduTrace judge entry page at /.');
      if (url.pathname === route.prefix) {
        req.resume();
        return send(res, 308, '', 'text/plain; charset=utf-8', { Location: `${route.prefix}/${url.search}` });
      }
      const target = targets[route.key];
      let actualMode;
      try { actualMode = await backendRuntime(target); }
      catch { return errorResponse(req, res, route, 503, `The local ${route.expectedMode} backend is not reachable.`); }
      if (actualMode !== route.expectedMode) return errorResponse(req, res, route, 502, `The configured ${route.expectedMode} address is running ${actualMode}; no request was forwarded.`);

      const proxyRequest = http.request({ hostname: target.host, port: target.port, path: stripPrefix(req.url, route.prefix), method: req.method, headers: forwardedHeaders(req.headers, route, target), timeout: 30000 }, proxyResponse => {
        const headers = scopedHeaders(proxyResponse.headers, route);
        res.writeHead(proxyResponse.statusCode || 502, headers);
        proxyResponse.pipe(res);
      });
      proxyRequest.on('timeout', () => proxyRequest.destroy(new Error('Backend request timed out.')));
      proxyRequest.on('error', () => {
        if (!res.headersSent) errorResponse(req, res, route, 503, `The local ${route.expectedMode} backend stopped responding.`);
        else res.destroy();
      });
      req.pipe(proxyRequest);
    } catch {
      if (!res.headersSent) send(res, 500, 'The local judge front door could not process this request.');
      else res.destroy();
    }
  });
  return server;
}

function start(env = process.env) {
  const hosted = hostedEnvironment(env);
  if (hosted.length) throw new FrontDoorError('The judge front door is local-only and refuses hosted or production environments.');
  if (env.HOST && !['127.0.0.1', 'localhost'].includes(String(env.HOST).toLowerCase())) throw new FrontDoorError('The judge front door binds only to 127.0.0.1.');
  const port = validPort(env.EDUTRACE_JUDGE_PORT ?? '3100', 'EDUTRACE_JUDGE_PORT');
  const demoPort = validPort(env.EDUTRACE_DEMO_PORT ?? '3101', 'EDUTRACE_DEMO_PORT');
  const syntheticPort = validPort(env.EDUTRACE_SYNTHETIC_TEST_PORT ?? '3102', 'EDUTRACE_SYNTHETIC_TEST_PORT');
  if (new Set([port, demoPort, syntheticPort]).size !== 3) throw new FrontDoorError('Front door, Demo, and Synthetic Test ports must be distinct.');
  const app = createFrontDoor({ demo: { host: '127.0.0.1', port: demoPort }, synthetic: { host: '127.0.0.1', port: syntheticPort } });
  app.listen(port, '127.0.0.1', () => console.log(`EduTrace local judge entry running at http://127.0.0.1:${app.address().port}`));
  return app;
}

if (require.main === module) {
  try { start(); }
  catch (error) { console.error(`EduTrace judge front door did not start: ${error.message}`); process.exitCode = 1; }
}

module.exports = { createFrontDoor, start, FrontDoorError };
