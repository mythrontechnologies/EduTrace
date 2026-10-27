// Points the app at a throwaway database for this test process so `npm test` never reads or
// overwrites data/demo-db.json. Require this before any module that loads or saves demo data.
// (It lives outside test/ because the Node test runner treats every file in test/ as a test file.)
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edutrace-test-'));
process.env.EDUTRACE_DB_PATH = path.join(dir, 'demo-db.json');
// Tests never contact a real model: provider settings from the developer's environment are dropped,
// and tests that need a provider inject a stub transport.
for (const key of Object.keys(process.env)) if (key.startsWith('EDUTRACE_AI_') || key === 'EDUTRACE_OLLAMA_URL' || key === 'ANTHROPIC_API_KEY') delete process.env[key];
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
module.exports = { dir, dbPath: process.env.EDUTRACE_DB_PATH };
