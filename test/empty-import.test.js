require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULT_DATA } = require('../src/seed');
const { CONFIRMATION, createEmptyImportDataset } = require('../src/empty-import');
const { toRelational, validateRelational } = require('../src/relational');
const { createApp } = require('../server');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
async function call(port, method, pathname, { role = 'regulator', json } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'x-demo-role': role, ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
    body: json === undefined ? undefined : JSON.stringify(json)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('administrator initializes an isolated empty import generation safely and imports into it', { concurrency: false }, async t => {
  assert.equal(fs.existsSync(DEFAULT_DATA), true);
  fs.copyFileSync(DEFAULT_DATA, process.env.EDUTRACE_DB_PATH);
  const isolatedSource = process.env.EDUTRACE_DB_PATH;
  const sourceHash = hash(isolatedSource);
  const sourceBefore = fs.readFileSync(isolatedSource);
  const portDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edutrace-init-failure-'));
  const failureSource = path.join(portDbDir, 'source.json');
  fs.copyFileSync(isolatedSource, failureSource);
  const failingFs = Object.create(fs);
  let writeNumber = 0;
  failingFs.writeFileSync = (fd, value, encoding) => {
    if (++writeNumber === 1) return fs.writeFileSync(fd, value, encoding);
    fs.writeFileSync(fd, String(value).slice(0, 32), 'utf8');
    throw new Error('simulated mid-write failure');
  };
  assert.throws(() => createEmptyImportDataset({ sourcePath: failureSource, actor: 'test:platform-admin', fsImpl: failingFs }), /could not be committed/);
  assert.deepEqual(fs.readdirSync(portDbDir), ['source.json']);
  assert.equal(hash(failureSource), sourceHash);
  const failingRenameFs = Object.create(fs);
  failingRenameFs.renameSync = () => { throw new Error('simulated commit failure'); };
  assert.throws(() => createEmptyImportDataset({ sourcePath: failureSource, actor: 'test:platform-admin', fsImpl: failingRenameFs }), /could not be committed/);
  assert.deepEqual(fs.readdirSync(portDbDir), ['source.json']);
  const lockPath = path.join(portDbDir, `empty-import-${sourceHash}.json.lock`);
  fs.writeFileSync(lockPath, 'another initializer owns this lock', { flag: 'wx' });
  assert.throws(() => createEmptyImportDataset({ sourcePath: failureSource, actor: 'test:platform-admin' }), /already in progress/);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'another initializer owns this lock');
  fs.unlinkSync(lockPath);
  assert.equal(path.dirname(path.resolve(portDbDir)), path.resolve(os.tmpdir()));
  assert.match(path.basename(portDbDir), /^edutrace-init-failure-/);
  fs.rmSync(portDbDir, { recursive: true, force: true });

  let app = createApp();
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  let port = app.address().port;
  t.after(() => app.listening ? new Promise(resolve => app.close(resolve)) : undefined);
  const endpoint = '/api/v1/admin/initialize-empty-import';

  let response = await call(port, 'POST', endpoint, { role: 'institution', json: { confirmation: CONFIRMATION } });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'forbidden');
  assert.deepEqual(fs.readdirSync(path.dirname(isolatedSource)), ['demo-db.json']);

  response = await call(port, 'POST', endpoint, { json: {} });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'confirmation_required');
  assert.deepEqual(fs.readdirSync(path.dirname(isolatedSource)), ['demo-db.json']);

  response = await call(port, 'POST', endpoint, { json: { confirmation: CONFIRMATION } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const outputPath = path.join(path.dirname(isolatedSource), response.body.data.database_file);
  assert.equal(hash(isolatedSource), sourceHash);
  assert.equal(response.body.data.source_database_sha256, sourceHash);

  response = await call(port, 'POST', endpoint, { json: { confirmation: CONFIRMATION } });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'already_initialized');
  assert.equal(hash(isolatedSource), sourceHash);

  await new Promise(resolve => app.close(resolve));
  process.env.EDUTRACE_DB_PATH = outputPath;
  app = createApp();
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  port = app.address().port;

  const source = JSON.parse(sourceBefore.toString('utf8'));
  const empty = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.deepEqual(empty.institutions, source.institutions);
  assert.deepEqual(empty.capacityRules, source.capacityRules);
  for (const key of ['sourceRecords', 'importBatches', 'findings', 'identityLinks', 'identityLinkEvents', 'correctionCandidates', 'lineageEvents', 'notifications', 'automationRuns', 'decisionReceipts', 'consentRecords']) assert.deepEqual(empty[key], [], `${key} must start empty`);
  assert.deepEqual(empty.matchDecisions, {});
  assert.deepEqual(empty.notificationRegistry, {});
  assert.equal(empty.auditEvents.length, 1);
  assert.equal(empty.auditEvents[0].action, 'empty_import_initialized');
  assert.equal(empty.auditEvents[0].source_database_sha256, sourceHash);
  assert.equal(empty.auditEvents[0].actor, 'demo:regulator');
  assert.equal(empty.auditEvents[0].finding_id, undefined);
  assert.deepEqual(validateRelational(toRelational(empty)), { ok: true, problems: [] });

  // The new process starts on the generated dataset. The original remains the archived source generation.
  response = await call(port, 'GET', '/healthz');
  assert.equal(response.status, 200);
  response = await call(port, 'GET', '/api/v1/runtime');
  assert.equal(response.status, 200);
  assert.equal(response.body.data.mode, 'development');
  assert.equal(response.body.data.read_only, false);
  response = await call(port, 'GET', '/api/v1/dashboard/summary');
  assert.equal(response.status, 200);
  assert.equal(response.body.data.imported_records, 0);
  assert.equal(response.body.data.institutions, source.institutions.length);
  response = await call(port, 'GET', '/api/v1/audit');
  assert.equal(response.status, 200);
  assert.equal(response.body.data[0].action, 'empty_import_initialized');
  assert.equal(response.body.data[0].records_count, 0);

  const csv = 'Student ID,Full Name,DOB,College,Course,Session,Status\n799999999999,Synthetic Test,01/02/2005,NITM,BTECH CSE,2026-27,Active';
  const mapping = { apaar_id: 'Student ID', student_name: 'Full Name', date_of_birth: 'DOB', institution_code: 'College', programme: 'Course', academic_session: 'Session', enrolment_status: 'Status' };
  response = await call(port, 'POST', '/api/v1/imports/preview', { json: { filename: 'synthetic.csv', csv, mapping, institution_code: 'NITM' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.total_rows, 1);
  const beforeInvalid = fs.readFileSync(outputPath);
  response = await call(port, 'POST', '/api/v1/imports/confirm', { json: { filename: 'synthetic.csv', csv: 'Student ID,Full Name\n"broken', mapping: { apaar_id: 'Student ID', student_name: 'Full Name' }, institution_code: 'NITM' } });
  assert.equal(response.status, 400);
  assert.deepEqual(fs.readFileSync(outputPath), beforeInvalid);
  response = await call(port, 'POST', '/api/v1/imports/confirm', { json: { filename: 'synthetic.csv', csv, mapping, institution_code: 'NITM' } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const imported = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(imported.sourceRecords.length, 1, JSON.stringify(response.body));
  assert.equal(imported.importBatches.length, 1);
  assert.equal(hash(isolatedSource), sourceHash);
  assert.equal(hash(DEFAULT_DATA), sourceHash);
});
