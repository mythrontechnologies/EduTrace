require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { server } = require('../server');
const { resetDemo, loadDemo } = require('../src/seed');
const { normaliseRecord, reconcile, syncCapacityFindings, capacityState, CAPACITY_RULE, SYSTEM_ACTOR } = require('../src/engine');

/* All identifiers and names below are synthetic. */
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

const RULE = { institution_code: 'A', programme: 'BTECH', academic_session: '2026-27', permitted_capacity: 3 };
let serial = 0;
function record(values = {}) {
  serial++;
  return { id: `CAP-${serial}`, source_row: serial + 1, source_file: 'capacity.csv', ...normaliseRecord({ student_name: `Capacity Student ${serial}`, date_of_birth: '01/01/2005', apaar_id: String(830000000000 + serial), institution_code: 'A', programme: 'BTECH', academic_session: '2026-27', enrolment_status: 'active', ...values }) };
}
function database(records, rules = [RULE]) {
  return { institutions: [], importBatches: [], auditEvents: [], findings: [], capacityRules: rules, sourceRecords: records };
}
const capacityFindings = db => db.findings.filter(f => f.rule_code === CAPACITY_RULE);
const current = db => capacityFindings(db).filter(f => f.lifecycle_status === 'current');

test('capacity below and exactly at the configured limit produces no finding', () => {
  const below = database([record(), record()]);
  assert.equal(capacityState(below.sourceRecords, RULE).observed_active, 2);
  assert.equal(capacityFindings({ findings: reconcile(below) }).length, 0);
  assert.equal(syncCapacityFindings(below).created.length, 0);

  const atLimit = database([record(), record(), record()]);
  assert.equal(capacityState(atLimit.sourceRecords, RULE).exceeded, false, 'at capacity is permitted');
  assert.equal(capacityFindings({ findings: reconcile(atLimit) }).length, 0);
  assert.equal(syncCapacityFindings(atLimit).created.length, 0);
});

test('capacity above the limit produces one current finding keyed to the configured rule', () => {
  const db = database([record(), record(), record(), record()]);
  const result = syncCapacityFindings(db, { at: '2026-10-25T10:00:00.000Z' });
  assert.equal(result.created.length, 1);
  const [finding] = current(db);
  assert.equal(finding.condition_key, 'A|BTECH|2026-27|*');
  assert.deepEqual([finding.capacity.observed_active, finding.capacity.permitted_capacity], [4, 3]);
  assert.equal(finding.evidence.length, 4);
  assert.match(finding.explanation, /configured prototype capacity 3/);
  assert.match(finding.explanation, /not an official regulatory interpretation/);
  assert.equal(db.auditEvents.length, 0, 'creating a finding is not a lifecycle transition');
});

test('a student is counted once, using the most recent source record for that identity', () => {
  const first = record();
  const repeat = { ...record({ apaar_id: first.apaar_id, student_name: first.student_name, date_of_birth: first.date_of_birth }), id: 'CAP-repeat' };
  const db = database([first, repeat, record(), record()]);
  assert.equal(capacityState(db.sourceRecords, RULE).observed_active, 3, 'a repeated submission is one enrolment');
  const withdrawn = record({ apaar_id: first.apaar_id, student_name: first.student_name, date_of_birth: first.date_of_birth, enrolment_status: 'withdrawn' });
  assert.equal(capacityState([...db.sourceRecords, withdrawn], RULE).observed_active, 2, 'a later withdrawal removes the student from the count');
  const conflicting = record({ apaar_id: first.apaar_id, student_name: 'Different Synthetic Person' });
  assert.equal(capacityState([...db.sourceRecords, conflicting], RULE).observed_active, 4, 'a shared identifier with conflicting attributes is not merged');
  const noIdentifier = [record({ apaar_id: '', student_name: 'Same Name' }), record({ apaar_id: '', student_name: 'Same Name' })];
  assert.equal(capacityState(noIdentifier, RULE).observed_active, 2, 'rows without an identifier are counted individually');
});

test('seat-category rules count only records in that seat category', () => {
  const rule = { ...RULE, seat_category: 'sc', permitted_capacity: 1 };
  const records = [record({ seat_category: 'SC' }), record({ seat_category: 'General' }), record({ seat_category: 'General' })];
  assert.equal(capacityState(records, rule).observed_active, 1);
  assert.equal(capacityState(records, rule).key, 'A|BTECH|2026-27|SC');
  const db = database([...records, record({ seat_category: 'SC' })], [rule]);
  syncCapacityFindings(db);
  assert.equal(current(db).length, 1);
  assert.equal(current(db)[0].capacity.seat_category, 'SC');
});

test('a violation that persists across repeated validations keeps a single current finding', () => {
  const db = database([record(), record(), record(), record()]);
  syncCapacityFindings(db, { at: '2026-10-25T10:00:00.000Z' });
  const [original] = current(db);
  for (const at of ['2026-10-25T11:00:00.000Z', '2026-10-25T12:00:00.000Z']) {
    const result = syncCapacityFindings(db, { at });
    assert.deepEqual([result.created.length, result.superseded.length, result.cleared.length, result.unchanged.length], [0, 0, 0, 1]);
  }
  assert.equal(capacityFindings(db).length, 1);
  assert.equal(current(db)[0].id, original.id);
  assert.equal(current(db)[0].last_validated_at, '2026-10-25T12:00:00.000Z');
  assert.equal(db.auditEvents.length, 0, 'an unchanged condition writes no audit events');
});

test('a changed count supersedes the old finding, links both, and preserves the reviewer decision', () => {
  const db = database([record(), record(), record(), record()]);
  syncCapacityFindings(db);
  const [old] = current(db);
  Object.assign(old, { review_status: 'resolved', decision: { outcome: 'legitimate_exception', note: 'Synthetic approval reviewed.', reviewer: 'Demo Regulator Reviewer', at: '2026-10-25T10:30:00.000Z' } });
  db.sourceRecords.push(record());
  const result = syncCapacityFindings(db, { at: '2026-10-25T11:00:00.000Z', reason: 'after import TEST' });
  assert.deepEqual([result.created.length, result.superseded.length], [1, 1]);
  const [replacement] = current(db);
  assert.notEqual(replacement.id, old.id);
  assert.deepEqual(replacement.supersedes, [old.id]);
  assert.equal(replacement.review_status, 'pending', 'a materially changed condition needs a fresh review');
  assert.equal(old.lifecycle_status, 'superseded');
  assert.equal(old.superseded_by, replacement.id);
  assert.equal(old.review_status, 'resolved'); assert.equal(old.decision.outcome, 'legitimate_exception');
  assert.match(old.lifecycle_reason, /5 active enrolments now counted/);
  assert.equal(capacityFindings(db).length, 2, 'historical findings are never deleted');
  const [event] = db.auditEvents;
  assert.deepEqual([event.finding_id, event.action, event.actor, event.replacement_finding_id, event.system], [old.id, 'superseded', SYSTEM_ACTOR, replacement.id, true]);
});

test('a correction that brings the count back within the limit clears the condition', () => {
  const students = [record(), record(), record(), record()];
  const db = database([...students]);
  syncCapacityFindings(db);
  const [finding] = current(db);
  const s = students[0];
  db.sourceRecords.push(record({ apaar_id: s.apaar_id, student_name: s.student_name, date_of_birth: s.date_of_birth, enrolment_status: 'transferred' }));
  const result = syncCapacityFindings(db, { reason: 'after import FIX' });
  assert.deepEqual([result.created.length, result.cleared.length], [0, 1]);
  assert.equal(current(db).length, 0);
  assert.equal(finding.lifecycle_status, 'cleared');
  assert.equal(finding.superseded_by, undefined);
  assert.match(finding.lifecycle_reason, /no longer exceeded/);
  assert.equal(db.auditEvents.at(-1).action, 'condition_cleared');
});

test('legacy duplicate capacity findings are consolidated without losing history', () => {
  const records = [record(), record(), record(), record(), record()];
  const db = database(records);
  const legacy = (evidence, extra = {}) => ({ id: `LEGACY-${evidence.length}`, rule_code: CAPACITY_RULE, category: 'capacity', severity: 'high', review_status: 'pending', title: 'Configured demonstration intake limit exceeded', explanation: 'Legacy synthetic finding.', evidence: evidence.map(r => r.id), ...extra });
  db.findings.push(legacy(records.slice(0, 4), { review_status: 'awaiting_verification' }), legacy(records));
  const result = syncCapacityFindings(db);
  assert.equal(result.created.length, 0, 'the legacy finding that matches current evidence is kept');
  assert.equal(current(db).length, 1);
  assert.equal(current(db)[0].id, 'LEGACY-5');
  assert.equal(current(db)[0].condition_key, 'A|BTECH|2026-27|*');
  const old = db.findings.find(f => f.id === 'LEGACY-4');
  assert.deepEqual([old.lifecycle_status, old.superseded_by, old.review_status], ['superseded', 'LEGACY-5', 'awaiting_verification']);
});

test('removing a capacity rule clears its current finding', () => {
  const db = database([record(), record(), record(), record()]);
  syncCapacityFindings(db);
  db.capacityRules = [];
  const result = syncCapacityFindings(db);
  assert.equal(result.cleared.length, 1);
  assert.match(result.cleared[0].lifecycle_reason, /no capacity rule is configured/);
});

test('API: capacity lifecycle across import, review, audit, dashboard and export', { concurrency: false }, async () => {
  resetDemo();
  const reg = { 'x-demo-role': 'regulator' };
  const capacityList = async (lifecycle = '') => (await call({ url: `/api/v1/findings?category=${CAPACITY_RULE}${lifecycle ? `&lifecycle=${lifecycle}` : ''}`, headers: reg })).json;
  const importCsv = (filename, rows, institution_code = 'NITM') => call({ method: 'POST', url: '/api/v1/imports/confirm', headers: reg, json: { filename, institution_code, csv: ['apaar_id,student_name,date_of_birth,institution_code,programme,academic_session,enrolment_status', ...rows].join('\n') } });
  const consistent = async () => {
    const summary = (await call({ url: '/api/v1/dashboard/summary', headers: reg })).json.data;
    const list = (await call({ url: '/api/v1/findings', headers: reg })).json;
    assert.equal(summary.accessible_findings, list.total);
    assert.equal(summary.pending_decisions, list.data.filter(f => f.review_status === 'pending').length);
    assert.equal(summary.severity_total, summary.accessible_findings);
    assert.equal(summary.historical_findings, list.lifecycle_counts.historical);
    return summary;
  };

  /* Seeded: 40 NITM BTECH CSE rows, of which two are the same student → 39 against 35 */
  let list = await capacityList();
  assert.equal(list.total, 1);
  const seeded = list.data[0];
  assert.equal(seeded.capacity.observed_active, 39);
  let summary = await consistent();
  assert.deepEqual([summary.capacity[0].observed_active, summary.capacity[0].current_finding_id, summary.historical_findings], [39, seeded.id, 0]);

  /* Review, then an import that raises the count */
  let res = await call({ method: 'POST', url: `/api/v1/findings/${seeded.id}/decision`, headers: reg, json: { outcome: 'legitimate_exception', note: 'Synthetic: approved supernumerary seats reviewed.' } });
  assert.equal(res.status, 200);
  res = await importCsv('capacity-up.csv', ['899999990001,Capacity Extra One,01/01/2005,NITM,BTECH CSE,2026-27,Active']);
  assert.equal(res.status, 201);
  assert.deepEqual([res.json.data.capacity_findings_created, res.json.data.capacity_findings_superseded], [1, 1]);
  list = await capacityList();
  assert.equal(list.total, 1, 'only one current finding for the condition');
  const raised = list.data[0];
  assert.notEqual(raised.id, seeded.id);
  assert.deepEqual([raised.capacity.observed_active, raised.review_status, raised.supersedes[0]], [40, 'pending', seeded.id]);
  const oldDetail = (await call({ url: `/api/v1/findings/${seeded.id}`, headers: reg })).json;
  assert.deepEqual([oldDetail.data.lifecycle_status, oldDetail.data.superseded_by, oldDetail.data.review_status, oldDetail.data.decision.outcome], ['superseded', raised.id, 'resolved', 'legitimate_exception']);
  assert.deepEqual(oldDetail.audit.map(a => a.action), ['legitimate_exception', 'superseded'], 'decision and lifecycle are both in the audit trail');
  res = await call({ method: 'POST', url: `/api/v1/findings/${seeded.id}/decision`, headers: reg, json: { outcome: 'awaiting_verification', note: 'Attempt on historical finding.' } });
  assert.equal(res.status, 409); assert.equal(res.json.superseded_by, raised.id);
  summary = await consistent();
  assert.deepEqual([summary.capacity[0].observed_active, summary.capacity[0].current_finding_id, summary.historical_findings], [40, raised.id, 1]);

  /* Repeated validation: an unrelated import leaves the condition and its finding unchanged */
  const systemEvents = () => loadDemo().auditEvents.filter(a => a.system).length;
  const eventsBefore = systemEvents();
  res = await importCsv('unrelated.csv', ['899999990002,Capacity Unrelated,02/02/2005,RCA,BBA,2026-27,Active'], 'RCA');
  assert.deepEqual([res.json.data.capacity_findings_created, res.json.data.capacity_findings_superseded, res.json.data.capacity_findings_cleared], [0, 0, 0]);
  list = await capacityList();
  assert.deepEqual(list.data.map(f => f.id), [raised.id]);
  assert.equal(systemEvents(), eventsBefore);

  /* Historical findings are separated in the list and the export */
  const historical = await capacityList('historical');
  assert.deepEqual(historical.data.map(f => f.id), [seeded.id]);
  assert.equal((await capacityList('all')).total, 2);
  const csvDefault = (await call({ url: '/api/v1/reports/findings.csv', headers: reg })).text;
  assert.match(csvDefault.split('\n')[0], /lifecycle_status,superseded_by$/);
  assert.doesNotMatch(csvDefault, new RegExp(seeded.id));
  const csvAll = (await call({ url: '/api/v1/reports/findings.csv?lifecycle=all', headers: reg })).text;
  assert.ok(csvAll.split('\n').some(line => line.startsWith(seeded.id) && line.endsWith(`,superseded,${raised.id}`)));

  /* Correction by a subsequent import: five counted students are withdrawn → 35, exactly at the limit */
  const db = loadDemo();
  const counted = raised.records.filter(r => /^•/.test(r.apaar_id)).slice(-5).map(r => db.sourceRecords.find(s => s.id === r.id));
  res = await importCsv('capacity-fix.csv', counted.map(r => `${r.apaar_id},${r.student_name},${r.date_of_birth},NITM,BTECH CSE,2026-27,Withdrawn`));
  assert.equal(res.status, 201);
  assert.deepEqual([res.json.data.imported, res.json.data.capacity_findings_created, res.json.data.capacity_findings_cleared], [5, 0, 1]);
  assert.match(res.json.message, /1 cleared/);
  assert.equal((await capacityList()).total, 0);
  const cleared = (await call({ url: `/api/v1/findings/${raised.id}`, headers: reg })).json;
  assert.deepEqual([cleared.data.lifecycle_status, cleared.data.superseded_by, cleared.audit.at(-1).action], ['cleared', undefined, 'condition_cleared']);
  summary = await consistent();
  assert.deepEqual([summary.capacity[0].observed_active, summary.capacity[0].exceeded, summary.capacity[0].current_finding_id, summary.historical_findings], [35, false, null, 2]);
  const feed = (await call({ url: '/api/v1/audit', headers: reg })).json.data;
  assert.equal(feed[0].action, 'condition_cleared'); assert.equal(feed[0].actor, SYSTEM_ACTOR);
  assert.doesNotMatch(JSON.stringify(feed), /89999999000\d|7000000000\d\d/, 'audit feed never exposes raw identifiers');

  /* Institution scope still applies to historical findings */
  const institutionHistorical = (await call({ url: `/api/v1/findings?lifecycle=historical`, headers: { 'x-demo-role': 'institution' } })).json;
  assert.ok(institutionHistorical.data.every(f => f.records.every(r => r.institution_code === 'NITM')));
  resetDemo();
});
