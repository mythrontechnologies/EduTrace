require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { dataPath, DEFAULT_DATA } = require('../src/seed');

function snapshot(file) {
  if (!fs.existsSync(file)) return { exists: false };
  return { exists: true, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtimeMs: fs.statSync(file).mtimeMs };
}

test('tests run against an isolated database, never the working demo database', () => {
  assert.notEqual(dataPath(), path.resolve(DEFAULT_DATA));
  assert.ok(dataPath().startsWith(path.resolve(require('node:os').tmpdir())));
});

test('the rest of the test suite leaves data/demo-db.json byte-for-byte unchanged', () => {
  const before = snapshot(DEFAULT_DATA);
  const others = fs.readdirSync(__dirname).filter(file => file.endsWith('.test.js') && file !== path.basename(__filename)).map(file => path.join(__dirname, file));
  assert.ok(others.length >= 3, 'the other test files were found');
  /* Run them in a fresh runner without inheriting this process's isolation, so each file must isolate itself. */
  const env = { ...process.env };
  delete env.EDUTRACE_DB_PATH;
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', ...others], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  assert.equal(run.status, 0, `nested test run failed:\n${run.stdout}\n${run.stderr}`);
  assert.deepEqual(snapshot(DEFAULT_DATA), before);
});
