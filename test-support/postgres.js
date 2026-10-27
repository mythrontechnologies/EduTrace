// A throwaway PostgreSQL server for integration tests: real PostgreSQL binaries from the embedded-postgres
// devDependency, a fresh data directory under the OS temp folder, a random port and a random password.
// Nothing here touches data/demo-db.json. If EDUTRACE_TEST_DATABASE_URL is set, that server is used instead
// (the caller must point it at an empty, disposable database).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function startPostgres() {
  if (process.env.EDUTRACE_TEST_DATABASE_URL) return { url: process.env.EDUTRACE_TEST_DATABASE_URL, external: true, stop: async () => {} };
  const EmbeddedPostgres = (await import('embedded-postgres')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edutrace-pg-'));
  const port = await freePort(); const password = crypto.randomBytes(18).toString('hex');
  // UTF-8, as the store requires (JSONB in SQL_ASCII cannot hold characters such as the masking bullet).
  const pg = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'edutrace_test', password, port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
  await pg.initialise(); await pg.start(); await pg.createDatabase('edutrace_test');
  return {
    url: `postgres://edutrace_test:${password}@127.0.0.1:${port}/edutrace_test`, external: false,
    stop: async () => { try { await pg.stop(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  };
}

module.exports = { startPostgres };
