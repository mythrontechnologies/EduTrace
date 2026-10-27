const { dir } = require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MODES, HOSTING_MARKERS, StartupError, resolveMode, PRODUCTION_CAPABILITIES, PRODUCTION_REQUIREMENTS, productionBlockers, assertProductionReady } = require('../src/mode');

const ROOT = path.join(__dirname, '..');
// A child environment without any EduTrace, provider, NODE_ENV or hosting settings from the developer's shell.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('EDUTRACE_') || key === 'ANTHROPIC_API_KEY' || key === 'NODE_ENV' || key === 'PORT' || key === 'NODE_TEST_CONTEXT' || HOSTING_MARKERS.includes(key)) delete env[key];
  return { ...env, ...extra };
}
// Starts the real entry point and expects it to refuse: exit code 1, a diagnostic, no listening line, no database file.
function refuses(extra, script = 'server.js') {
  const dbPath = path.join(fs.mkdtempSync(path.join(dir, 'mode-')), 'never-created.json');
  const run = spawnSync(process.execPath, [script], { cwd: ROOT, env: cleanEnv({ PORT: '0', EDUTRACE_DB_PATH: dbPath, ...extra }), encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /EduTrace did not start/);
  assert.doesNotMatch(run.stdout, /running at/, 'it never listened');
  assert.equal(fs.existsSync(dbPath), false, 'no database was read, seeded or written');
  return run.stderr;
}

test('supported modes are explicit, and an unset mode remains development on a local machine', () => {
  assert.deepEqual(MODES, ['development', 'demo', 'synthetic-test', 'production']);
  for (const mode of MODES) assert.deepEqual(resolveMode({ EDUTRACE_MODE: mode }), { mode, explicit: true, hosted: [] });
  assert.deepEqual(resolveMode({}), { mode: 'development', explicit: false, hosted: [] });
  for (const bad of ['Demo', 'DEMO', ' demo', 'demo ', '', 'prod', 'test', 'readonly', 'development,demo']) {
    assert.throws(() => resolveMode({ EDUTRACE_MODE: bad }), error => error instanceof StartupError && /not a recognised mode/.test(error.message), `rejects ${JSON.stringify(bad)}`);
  }
});

test('synthetic-test must be explicit, is local-only, and rejects hosted environments', () => {
  assert.equal(resolveMode({ EDUTRACE_MODE: 'synthetic-test' }).mode, 'synthetic-test');
  assert.equal(resolveMode({}).mode, 'development', 'the default remains unchanged');
  for (const env of [{ NODE_ENV: 'production' }, ...HOSTING_MARKERS.map(key => ({ [key]: 'true' }))]) {
    assert.throws(() => resolveMode({ ...env, EDUTRACE_MODE: 'synthetic-test' }), /localhost-only/);
  }
});

test('a production or hosted environment needs an explicit mode and never gets development', () => {
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'Production' }, ...HOSTING_MARKERS.map(key => ({ [key]: '1' }))]) {
    assert.throws(() => resolveMode(env), /must be set explicitly/, JSON.stringify(env));
    assert.throws(() => resolveMode({ ...env, EDUTRACE_MODE: 'development' }), /local machine only/, JSON.stringify(env));
    assert.equal(resolveMode({ ...env, EDUTRACE_MODE: 'demo' }).mode, 'demo');
  }
  assert.equal(resolveMode({ NODE_ENV: 'development' }).mode, 'development');
});

test('production lists every unmet prerequisite, and no environment flag can satisfy them', () => {
  assert.ok(Object.isFrozen(PRODUCTION_CAPABILITIES));
  assert.ok(Object.values(PRODUCTION_CAPABILITIES).every(value => value === null), 'no production capability exists in code yet');
  const hopeful = { EDUTRACE_MODE: 'production', EDUTRACE_DATABASE_URL: 'postgres://db.example/edutrace', EDUTRACE_AUTH: 'oidc', EDUTRACE_PRODUCTION_READY: 'true', EDUTRACE_AUTH_READY: 'true', EDUTRACE_SAFEGUARDS: 'true' };
  const ids = productionBlockers(hopeful).map(b => b.id);
  for (const id of ['durable_database', 'database_connection', 'no_seed_on_missing_storage', 'authentication', 'server_side_authorization', 'tenant_scoping', 'production_safeguards']) assert.ok(ids.includes(id), `${id} is still a blocker`);
  assert.throws(() => assertProductionReady(hopeful), error => error instanceof StartupError && error.details.some(line => /authentication/i.test(line)) && error.details.some(line => /database/i.test(line)));
  // The checks read real capabilities: once each exists in code, its blocker goes away.
  const real = { database: { durable: true, connectionVerified: true, seedsWhenMissing: false }, authentication: {}, authorization: { denyAnonymous: true }, tenantScoping: {}, safeguards: {} };
  assert.deepEqual(productionBlockers(hopeful, real), []);
  assert.ok(productionBlockers({ EDUTRACE_AI_PROVIDER: 'anthropic' }, real).some(b => b.id === 'server_side_secrets'));
  assert.equal(PRODUCTION_REQUIREMENTS.length, 8);
});

test('the entry point refuses an unknown mode before listening or touching data', () => {
  assert.match(refuses({ EDUTRACE_MODE: 'staging' }), /EDUTRACE_MODE="staging" is not a recognised mode/);
  assert.match(refuses({ EDUTRACE_MODE: '' }), /not a recognised mode/);
});

test('the entry point refuses to start writable development mode in a production environment', () => {
  assert.match(refuses({ NODE_ENV: 'production' }), /must be set explicitly/);
  assert.match(refuses({ NODE_ENV: 'production', EDUTRACE_MODE: 'development' }), /local machine only/);
  assert.match(refuses({ RENDER: 'true' }), /detected: RENDER/);
});

test('the entry point refuses production mode and names the missing prerequisites', () => {
  const stderr = refuses({ EDUTRACE_MODE: 'production', NODE_ENV: 'production', EDUTRACE_DATABASE_URL: 'postgres://db.example/edutrace' });
  assert.match(stderr, /production mode is not available/);
  assert.match(stderr, /No durable production database is wired/);
  assert.match(stderr, /No production identity provider is configured and verified/);
  assert.match(stderr, /memberships live in a local file/);
  assert.doesNotMatch(stderr, /postgres:\/\//, 'configuration values are not echoed');
});

test('the local-AI launcher runs development mode only', () => {
  assert.match(refuses({ EDUTRACE_MODE: 'demo' }, 'scripts/start-local-ai.js'), /development mode only/);
  assert.match(refuses({ EDUTRACE_MODE: 'bogus' }, 'scripts/start-local-ai.js'), /not a recognised mode/);
});
