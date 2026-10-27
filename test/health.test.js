const { dbPath } = require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { server } = require('../server');

function call({ method = 'GET', url, headers = {} }) {
  return new Promise(resolve => {
    const request = Readable.from([]);
    request.method = method; request.url = url; request.headers = { host: 'localhost', 'x-demo-role': 'regulator', ...headers };
    const response = new EventEmitter(); let status = 200; let responseHeaders = {}; const chunks = [];
    response.writeHead = (code, values) => { status = code; responseHeaders = values; };
    response.end = value => { if (value) chunks.push(value); resolve({ status, headers: responseHeaders, json: JSON.parse(chunks.join('')) }); };
    server.emit('request', request, response);
  });
}

test('the health endpoint answers without touching the database and reveals nothing else', async () => {
  assert.equal(fs.existsSync(dbPath), false);
  const res = await call({ url: '/healthz', headers: { 'x-demo-role': 'regulator' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: 'ok' });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  // Answered before loadDemo(), so no database was seeded, read or migrated.
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal((await call({ method: 'POST', url: '/healthz' })).status, 404);
});
