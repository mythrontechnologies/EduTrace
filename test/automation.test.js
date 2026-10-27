require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { server } = require('../server');
const { resetDemo, loadDemo } = require('../src/seed');
const { normaliseRecord, isCurrent } = require('../src/engine');
const { compareRecords, AUTO_LINK_POLICY } = require('../src/identity');

function call({ method = 'GET', url, headers = {}, json }) {
  return new Promise(resolve => {
    const request = Readable.from(json === undefined ? [] : [JSON.stringify(json)]);
    request.method = method; request.url = url; request.headers = { host: 'localhost', 'x-demo-role': 'regulator', ...headers };
    const response = new EventEmitter(); let status = 200; let responseHeaders = {}; const chunks = [];
    response.writeHead = (code, values) => { status = code; responseHeaders = values; };
    response.end = value => { if (value) chunks.push(value); const text = chunks.join(''); resolve({ status, text, json: responseHeaders['Content-Type']?.includes('json') ? JSON.parse(text) : undefined }); };
    server.emit('request', request, response);
  });
}
const reg = { 'x-demo-role': 'regulator' };
const nitm = { 'x-demo-role': 'institution' };
const header = 'Student ID,Full Name,DOB,College,Course,Session,Status';
const mapping = { apaar_id: 'Student ID', student_name: 'Full Name', date_of_birth: 'DOB', institution_code: 'College', programme: 'Course', academic_session: 'Session', enrolment_status: 'Status' };
const row = (id, name, dob, inst = 'NITM') => `${id},${name},${dob},${inst},BTECH CSE,2026-27,Active`;
const scenario = [
  header,
  row('791111111111', 'Asha Verma', '01/02/2005'),
  row('791111111111', 'Asha Verma', '01/02/2005'),   // exact repeat: policy allows automatic matching
  row('792222222222', 'Ravi Kumar', '03/04/2005'),
  row('792222222222', 'Ravi Kumar', '04/04/2005'),   // same identifier, different date of birth
  row('', 'Meena Iyer', '05/06/2005'),
  row('793333333333', 'Meena Iyer', '05/06/2005', 'RCA'),   // same name and date of birth elsewhere, one identifier missing
  row('794444444444', 'Kiran Das', '07/08/2005')     // clean, unique
].join('\n');
const importCsv = (csv, institution = 'MULTI', headers = reg) => call({ method: 'POST', url: '/api/v1/imports/confirm', headers, json: { filename: 'automation.csv', csv, mapping, ...(institution === 'MULTI' ? { multi_institution: true } : { institution_code: institution }) } });

const recordsFor = (db, name) => db.sourceRecords.filter(r => r.student_name === name).map(r => r.id);
const currentFor = (db, ids, rule) => db.findings.filter(f => isCurrent(f) && f.rule_code === rule && f.evidence.some(id => ids.includes(id)));

test('identity comparison records agreeing, conflicting and missing fields without values', () => {
  const r = (o, i) => normaliseRecord({ institution_code: 'NITM', programme: 'P', academic_session: '2026-27', enrolment_status: 'active', ...o }, i);
  const exact = compareRecords(r({ apaar_id: '791111111111', student_name: 'Asha Verma', date_of_birth: '2005-02-01' }, 1), r({ apaar_id: '791111111111', student_name: 'Asha  Verma', date_of_birth: '2005-02-01' }, 2));
  assert.deepEqual(exact.agreeing_fields, ['identifier', 'student_name', 'date_of_birth']);
  assert.equal(exact.score, 15);
  const conflict = compareRecords(r({ apaar_id: '791111111111', student_name: 'Asha Verma', date_of_birth: '2005-02-01' }, 1), r({ apaar_id: '791111111111', student_name: 'Asha Verma', date_of_birth: '2005-02-02' }, 2));
  assert.deepEqual(conflict.conflicting_fields, ['date_of_birth']);
  const noId = compareRecords(r({ student_name: 'Meena Iyer', date_of_birth: '2005-06-05' }, 1), r({ apaar_id: '793333333333', student_name: 'Meena Iyer', date_of_birth: '2005-06-05' }, 2));
  assert.deepEqual(noId.missing_fields, ['identifier']);
  assert.doesNotMatch(JSON.stringify([exact, conflict, noId]), /7911|Asha|2005/, 'comparisons carry field names, not values');
});

test('automatic matching applies only under the policy; conflicts and name-only matches stay exceptions', { concurrency: false }, async () => {
  resetDemo();
  const result = await importCsv(scenario);
  assert.equal(result.status, 201, result.text);
  const db = loadDemo();

  const asha = recordsFor(db, 'Asha Verma');
  const [dup] = currentFor(db, asha, 'DUPLICATE_IDENTIFIER');
  assert.ok(dup, 'the exact repeat produces a duplicate finding');
  assert.equal(dup.review_status, 'resolved');
  assert.equal(dup.decision.automated, true);
  assert.equal(dup.automation.outcome, 'safely_matched');
  assert.match(dup.automation.required_action, /^None: matched automatically under policy/);
  assert.ok(db.auditEvents.some(e => e.finding_id === dup.id && e.action === 'automatically_matched' && e.system));
  assert.ok(db.identityLinks.some(l => l.outcome === 'auto_linked' && l.policy_version === AUTO_LINK_POLICY.version && asha.every(id => l.records.includes(id))));

  const ravi = recordsFor(db, 'Ravi Kumar');
  const [conflict] = currentFor(db, ravi, 'IDENTIFIER_ATTRIBUTE_CONFLICT');
  assert.equal(conflict.review_status, 'pending');
  assert.equal(conflict.automation.outcome, 'needs_investigation');
  assert.ok(!db.identityLinks.some(l => l.outcome === 'auto_linked' && ravi.some(id => l.records.includes(id))), 'a conflicting date of birth is never linked automatically');

  const meena = recordsFor(db, 'Meena Iyer');
  const [candidate] = currentFor(db, meena, 'CANDIDATE_IDENTITY_MATCH');
  assert.equal(candidate.review_status, 'pending');
  assert.ok(db.identityLinks.some(l => l.outcome === 'candidate_for_review' && meena.every(id => l.records.includes(id))));
  assert.ok(!db.identityLinks.some(l => l.outcome === 'auto_linked' && meena.some(id => l.records.includes(id))), 'name similarity alone never links records');
  const [missing] = currentFor(db, meena, 'APAAR_MISSING');
  assert.equal(missing.automation.outcome, 'needs_institution_correction');

  const kiran = db.sourceRecords.find(r => r.student_name === 'Kiran Das');
  assert.match(kiran.processing.status, /^automatically_(processed|normalised)$/);
  assert.equal(kiran.processing.authoritative_verification, 'not_available', 'a well-formed identifier is never reported as verified');
  /* The seeded NITM programme is over its configured capacity, so every counted record is evidence for that one finding. */
  assert.equal(db.findings.filter(f => isCurrent(f) && f.rule_code !== 'DEMO_INTAKE_LIMIT_EXCEEDED' && f.evidence.includes(kiran.id)).length, 0, 'a clean record creates no review task');
});

test('re-importing the same file is idempotent and does not notify unchanged exceptions again', { concurrency: false }, async () => {
  resetDemo();
  await importCsv(scenario);
  const before = loadDemo();
  const openBefore = before.findings.filter(f => isCurrent(f) && f.review_status !== 'resolved').map(f => f.condition_key).sort();

  const capacityBefore = (await call({ url: '/api/v1/dashboard/summary', headers: reg })).json.data.capacity.map(c => c.observed_active);
  const again = await importCsv(scenario);
  assert.equal(again.status, 201);
  assert.equal(again.json.data.findings_superseded, 0);
  assert.equal(again.json.data.capacity_findings_superseded, 0, 'resubmitted rows are not counted as new students');
  assert.equal(again.json.data.automation.notified, 0);
  const db = loadDemo();
  const created = db.findings.filter(f => !before.findings.some(old => old.id === f.id));
  assert.ok(created.every(f => f.rule_code === 'DUPLICATE_IDENTIFIER' && f.review_status === 'resolved' && f.decision.automated), 'any new finding is a resubmission matched automatically');
  assert.deepEqual((await call({ url: '/api/v1/dashboard/summary', headers: reg })).json.data.capacity.map(c => c.observed_active), capacityBefore);
  const current = db.findings.filter(isCurrent);
  assert.equal(new Set(current.map(f => f.condition_key)).size, current.length, 'at most one current finding per condition');
  assert.deepEqual(current.filter(f => f.review_status !== 'resolved').map(f => f.condition_key).sort(), openBefore);
  assert.equal(db.notifications.length, before.notifications.length);

  const rerun = await call({ method: 'POST', url: '/api/v1/automation/revalidate', headers: reg });
  assert.equal(rerun.json.data.created + rerun.json.data.superseded + rerun.json.data.notified, 0);
  assert.equal((await call({ method: 'POST', url: '/api/v1/automation/revalidate', headers: nitm })).status, 403);
});

test('an automatic match is withdrawn when new evidence breaks the policy', { concurrency: false }, async () => {
  resetDemo();
  await importCsv(scenario);
  await importCsv([header, row('791111111111', 'Asha Verma', '09/02/2005')].join('\n'), 'NITM');
  const db = loadDemo();
  const asha = recordsFor(db, 'Asha Verma');
  assert.equal(asha.length, 3);
  const current = db.findings.filter(f => isCurrent(f) && f.evidence.some(id => asha.includes(id)) && ['DUPLICATE_IDENTIFIER', 'IDENTIFIER_ATTRIBUTE_CONFLICT'].includes(f.rule_code));
  assert.ok(current.length >= 1);
  assert.ok(current.every(f => !f.decision?.automated), 'no automatically closed finding survives a conflicting record');
  assert.ok(current.some(f => f.review_status === 'pending' && f.evidence.length === 3));
  assert.ok(!db.identityLinks.some(l => l.outcome === 'auto_linked' && asha.some(id => l.records.includes(id))));
});

test('notifications are grouped, scoped to the institution, and acknowledged only within scope', { concurrency: false }, async () => {
  resetDemo();
  await importCsv(scenario);
  await importCsv([header, row('', 'Other Student', '01/01/2006', 'RCA')].join('\n'), 'RCA');

  const all = (await call({ url: '/api/v1/notifications', headers: reg })).json;
  const own = (await call({ url: '/api/v1/notifications', headers: nitm })).json;
  assert.ok(all.data.some(n => n.institution_code === 'RCA'));
  assert.ok(own.data.length > 0);
  assert.ok(own.data.every(n => n.institution_code === 'NITM' || n.items.every(item => item.institutions.every(code => code === 'NITM'))));
  const item = own.data.flatMap(n => n.items).find(i => i.rule_code === 'APAAR_MISSING');
  assert.ok(item.required_action && item.affected[0].source_row && item.processing_status === 'needs_institution_correction');
  assert.ok(own.data.some(n => n.source_file === 'automation.csv'), 'a notification names the imported file');
  assert.doesNotMatch(JSON.stringify(own.data), /\b79\d{10}\b/, 'notifications never carry raw identifiers');

  const rca = all.data.find(n => n.institution_code === 'RCA');
  assert.equal((await call({ method: 'POST', url: `/api/v1/notifications/${rca.id}/acknowledge`, headers: nitm })).status, 404);
  const ack = await call({ method: 'POST', url: `/api/v1/notifications/${own.data[0].id}/acknowledge`, headers: nitm });
  assert.equal(ack.status, 200);
  assert.equal(ack.json.data.acknowledged.by, 'Demo NITM Reviewer');
  assert.equal((await call({ url: '/api/v1/notifications', headers: nitm })).json.unacknowledged, own.unacknowledged - 1);
});
