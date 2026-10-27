require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { server, parseCsv, validMapping } = require('../server');
const { resetDemo, loadDemo } = require('../src/seed');
const { normaliseRecord, reconcile } = require('../src/engine');

function call({ method = 'GET', url, headers = {}, json, raw }) {
  return new Promise(resolve => {
    const request = Readable.from(raw === undefined ? (json === undefined ? [] : [JSON.stringify(json)]) : [raw]);
    request.method = method; request.url = url; request.headers = { host: 'localhost', 'x-demo-role': 'regulator', ...headers };
    const response = new EventEmitter(); let status = 200; let responseHeaders = {}; const chunks = [];
    response.writeHead = (code, values) => { status = code; responseHeaders = values; };
    response.end = value => { if (value) chunks.push(value); const text = chunks.join(''); resolve({ status, headers: responseHeaders, text, json: responseHeaders['Content-Type']?.includes('json') ? JSON.parse(text) : undefined }); };
    server.emit('request', request, response);
  });
}
const csv = 'Student ID,Full Name,DOB,College,Course,Session,Status\n799999999999,Imported Student,01/01/2005,NITM,BTECH CSE,2026-27,Active\n,Missing Identifier,01/01/2005,NITM,BTECH CSE,2026-27,Active\n700000000888,,01/01/2005,NITM,BTECH CSE,2026-27,Active';
const mapping = { apaar_id: 'Student ID', student_name: 'Full Name', date_of_birth: 'DOB', institution_code: 'College', programme: 'Course', academic_session: 'Session', enrolment_status: 'Status' };

test('CSV parser handles quoted commas, rows, and malformed input', () => {
  const parsed = parseCsv('Name,Note\n"A, Nair","a ""quoted"" value"\n\nB,ok');
  assert.equal(parsed.rows[0].Name, 'A, Nair'); assert.equal(parsed.rows[0].Note, 'a "quoted" value'); assert.deepEqual(parsed.row_numbers, [2, 4]);
  assert.throws(() => parseCsv('Name,Name\nA,B'), /unique/);
  assert.throws(() => parseCsv('Name\n"unclosed'), /unclosed/);
  assert.throws(() => parseCsv('Name,Note\n"A"tail,ok'), /unexpected character after a quoted field/);
  assert.throws(() => parseCsv('Name,Note\nA,ok,discarded'), /more fields than the header/);
  assert.throws(() => validMapping({ bogus: 'Name' }, ['Name']), /unsupported/);
});

test('semicolon and tab delimited imports fail clearly and leave the stored database unchanged', { concurrency: false }, async () => {
  resetDemo();
  const before = JSON.stringify(loadDemo());
  const cases = [
    ['semicolon', 'student_name;institution_code;programme;academic_session;enrolment_status\nSynthetic Check;NITM;BTECH CSE;2026-27;Active'],
    ['tab', 'student_name\tinstitution_code\tprogramme\tacademic_session\tenrolment_status\nSynthetic Check\tNITM\tBTECH CSE\t2026-27\tActive']
  ];
  for (const [name, input] of cases) {
    const preview = await call({ method: 'POST', url: '/api/v1/imports/preview', json: { filename: `${name}.csv`, csv: input } });
    assert.equal(preview.status, 400); assert.match(preview.json.error, /comma-separated CSV/);
    const confirmation = await call({ method: 'POST', url: '/api/v1/imports/confirm', json: { filename: `${name}.csv`, csv: input } });
    assert.equal(confirmation.status, 400); assert.match(confirmation.json.error, /comma-separated CSV/);
  }
  assert.equal(JSON.stringify(loadDemo()), before);
});

test('successful imports create PII-free, institution-scoped audit events', { concurrency: false }, async () => {
  resetDemo();
  const csvFor = (institution, name, identifier) => `institution_code,student_name,apaar_id,programme,academic_session,enrolment_status\n${institution},${name},${identifier},BTECH CSE,2026-27,Active`;
  const mapping = { institution_code: 'institution_code', student_name: 'student_name', apaar_id: 'apaar_id', programme: 'programme', academic_session: 'academic_session', enrolment_status: 'enrolment_status' };
  const importFile = async (institution, name, identifier, headers = {}) => call({
    method: 'POST', url: '/api/v1/imports/confirm', headers,
    json: { filename: `${institution.toLowerCase()}-synthetic.csv`, csv: csvFor(institution, name, identifier), mapping, institution_code: institution }
  });
  assert.equal((await importFile('NITM', 'Synthetic NITM Person', '799999999101', { 'x-demo-role': 'institution' })).status, 201);
  assert.equal((await importFile('RCA', 'Synthetic RCA Person', '799999999102')).status, 201);
  const nItmAudit = await call({ url: '/api/v1/audit', headers: { 'x-demo-role': 'institution' } });
  assert.equal(nItmAudit.status, 200);
  const nItmImports = nItmAudit.json.data.filter(event => event.action === 'import_batch_committed');
  assert.equal(nItmImports.length, 1);
  assert.equal(nItmImports[0].institution_code, 'NITM');
  assert.equal(nItmImports[0].actor, 'demo:institution:NITM');
  assert.match(nItmImports[0].note, /^1 imported, 0 rejected, 0 skipped\.$/);
  assert.doesNotMatch(JSON.stringify(nItmImports[0]), /Synthetic NITM Person|799999999101/);
  const allAudit = await call({ url: '/api/v1/audit', headers: { 'x-demo-role': 'regulator' } });
  assert.deepEqual(allAudit.json.data.filter(event => event.action === 'import_batch_committed').map(event => event.institution_code).sort(), ['NITM', 'RCA']);
  resetDemo();
});

test('API workflow validates input, preserves scope, persists review, and exports CSV', { concurrency: false }, async () => {
  resetDemo();
  const reg = { 'x-demo-role': 'regulator' };
  const institution = { 'x-demo-role': 'institution', 'x-demo-institution': 'RCA' };

  let result = await call({ method: 'POST', url: '/api/v1/imports/preview', json: { filename: 'students.xlsx', csv } });
  assert.equal(result.status, 415); assert.match(result.json.error, /\.csv/);
  result = await call({ method: 'POST', url: '/api/v1/imports/preview', raw: '{not json' });
  assert.equal(result.status, 400); assert.match(result.json.error, /valid JSON/);
  result = await call({ method: 'POST', url: '/api/v1/imports/preview', raw: JSON.stringify({ filename: 'students.csv', csv: 'A'.repeat(2 * 1024 * 1024) }) });
  assert.equal(result.status, 400); assert.match(result.json.error, /2 MB/);
  result = await call({ method: 'POST', url: '/api/v1/imports/preview', json: { filename: 'students.csv', csv: 'Name\n"bad' } });
  assert.equal(result.status, 400); assert.match(result.json.error, /Malformed CSV/);
  result = await call({ method: 'POST', url: '/api/v1/imports/preview', json: { filename: 'students.csv', csv: 'Name,Note\n"A"tail,ok' } });
  assert.equal(result.status, 400); assert.match(result.json.error, /unexpected character after a quoted field/);
  result = await call({ method: 'POST', url: '/api/v1/imports/preview', json: { filename: 'students.csv', csv: 'Name,Note\nA,ok,discarded' } });
  assert.equal(result.status, 400); assert.match(result.json.error, /more fields than the header/);
  result = await call({ method: 'POST', url: '/api/v1/imports/preview', json: { filename: 'students.csv', csv } });
  assert.equal(result.status, 200); assert.equal(result.json.data.total_rows, 3); assert.equal(result.json.data.sample[0].apaar, '•••• •••• 9999');

  result = await call({ method: 'POST', url: '/api/v1/imports/confirm', headers: institution, json: { filename: '../../unsafe name.csv', institution_code: 'RCA', mapping, csv } });
  assert.equal(result.status, 403, 'institution principal cannot switch its batch institution');
  result = await call({ method: 'POST', url: '/api/v1/imports/confirm', headers: institution, json: { filename: 'students.csv', institution_code: 'NITM', mapping: { unexpected: 'Full Name' }, csv } });
  assert.equal(result.status, 400); assert.match(result.json.error, /mapping/);
  result = await call({ method: 'POST', url: '/api/v1/imports/confirm', headers: institution, json: { filename: '../../unsafe name.csv', institution_code: 'NITM', mapping, csv } });
  assert.equal(result.status, 201); assert.equal(result.json.data.imported, 2); assert.equal(result.json.data.rejected, 1);
  assert.equal(loadDemo().sourceRecords.at(-1).source_file, 'unsafe_name.csv');

  const scopedList = await call({ url: '/api/v1/findings?institution=NITM', headers: institution });
  assert.equal(scopedList.status, 200); assert.ok(scopedList.json.data.every(f => f.records.every(r => r.institution_code === 'NITM')));
  const forgedInstitutionFilter = await call({ url: '/api/v1/findings?institution=RCA', headers: institution }); assert.equal(forgedInstitutionFilter.json.total, 0); assert.deepEqual(forgedInstitutionFilter.json.filter_options.institutions.map(item => item.code), ['NITM']);
  const foreign = (await call({ url: '/api/v1/findings', headers: reg })).json.data.find(f => f.records.some(r => r.institution_code === 'RCA') && !f.records.some(r => r.institution_code === 'NITM'));
  result = await call({ url: `/api/v1/findings/${foreign.id}`, headers: institution });
  assert.equal(result.status, 404, 'manipulated URL cannot reveal foreign finding');
  result = await call({ method: 'POST', url: `/api/v1/findings/${foreign.id}/decision`, headers: institution, json: { outcome: 'dismissed', note: 'Attempted cross-tenant action.' } });
  assert.equal(result.status, 404);

  const accessible = scopedList.json.data.find(f => f.review_status === 'pending');
  result = await call({ method: 'POST', url: `/api/v1/findings/${accessible.id}/decision`, headers: institution, json: { outcome: 'dismissed', note: '' } });
  assert.equal(result.status, 400); assert.match(result.json.error, /note/);
  result = await call({ method: 'POST', url: `/api/v1/findings/${accessible.id}/decision`, headers: institution, json: { outcome: 'legitimate_exception', note: 'Synthetic transfer evidence reviewed.' } });
  assert.equal(result.status, 200); assert.equal(result.json.data.review_status, 'resolved');
  result = await call({ url: `/api/v1/findings/${accessible.id}`, headers: institution });
  assert.equal(result.status, 200); assert.equal(result.json.audit.length, 1); assert.equal(result.json.audit[0].note, 'Synthetic transfer evidence reviewed.');

  const before = await call({ url: '/api/v1/dashboard/summary', headers: institution });
  assert.equal(before.json.data.imported_records, 122); assert.ok(before.json.data.pending_decisions < 9);
  const report = await call({ url: '/api/v1/reports/findings.csv', headers: institution });
  assert.equal(report.status, 200); assert.match(report.headers['Content-Type'], /text\/csv/); assert.match(report.text, /finding_id,rule_code/); assert.doesNotMatch(report.text, /70000000000/);
});

test('candidate, transfer, and capacity boundary rules remain conservative', () => {
  const base = { institutions: [], importBatches: [], auditEvents: [], findings: [], capacityRules: [{ institution_code: 'A', programme: 'BTECH', academic_session: '2026-27', permitted_capacity: 2 }] };
  const record = (id, values) => ({ id, source_row: 2, source_file: 'test.csv', ...normaliseRecord({ student_name: 'A Nair', institution_code: 'A', programme: 'BTECH', academic_session: '2026-27', enrolment_status: 'active', ...values }) });
  let db = { ...base, sourceRecords: [record('1', { apaar_id: '700000000101' }), record('2', { apaar_id: '700000000102' })] };
  assert.ok(!reconcile(db).some(f => f.rule_code === 'DEMO_INTAKE_LIMIT_EXCEEDED'), 'at capacity is permitted');
  db = { ...base, sourceRecords: [...db.sourceRecords, record('3', { apaar_id: '700000000103' })] };
  assert.ok(reconcile(db).some(f => f.rule_code === 'DEMO_INTAKE_LIMIT_EXCEEDED'), 'one above capacity is flagged');
  const similar = { ...base, sourceRecords: [record('4', { apaar_id: '', student_name: 'A Nair', date_of_birth: '01/01/2004' }), record('5', { apaar_id: '', student_name: 'A Nair', date_of_birth: '02/01/2004', institution_code: 'B' })] };
  assert.ok(!reconcile(similar).some(f => f.rule_code === 'CANDIDATE_IDENTITY_MATCH'), 'same name alone is inconclusive');
  const transferred = { ...base, sourceRecords: [record('6', { apaar_id: '700000000106', institution_code: 'A', enrolment_status: 'transferred', academic_session: '2025-26' }), record('7', { apaar_id: '700000000106', institution_code: 'B', enrolment_status: 'active' })] };
  assert.ok(!reconcile(transferred).some(f => f.rule_code === 'POTENTIAL_CONCURRENT_ENROLMENT'), 'historical transfer is not concurrent enrolment');
});

test('underscore aliases, manual mapping, required mappings, and multi-institution scope work', { concurrency: false }, async () => {
  resetDemo();
  const regulator = { 'x-demo-role': 'regulator' };
  const institution = { 'x-demo-role': 'institution' };
  const sample = 'institution_code,institution_name,student_name,apaar_id,date_of_birth,programme,academic_session,admission_year,enrolment_status,seat_category\nNITM,Northbridge,Student One,799999999901,01/01/2005,BTECH CSE,2026-27,2026,Active,General\nRCA,Riverview,Student Two,,02/01/2005,BBA,2026-27,2026,Active,OBC\nSVU,Suryavardhan,Student Three,799999999903,03/01/2005,BSC DATA,2026-27,2026,Active,SC';
  let result = await call({ method: 'POST', url: '/api/v1/imports/preview', headers: regulator, json: { filename: 'three-institutions.csv', csv: sample } });
  assert.equal(result.status, 200); assert.equal(result.json.data.total_rows, 3);
  assert.equal(result.json.data.unmapped_required_fields.length, 0);
  for (const field of ['institution_code', 'institution_name', 'student_name', 'apaar_id', 'date_of_birth', 'academic_session', 'admission_year', 'enrolment_status', 'seat_category']) assert.equal(result.json.data.mapping[field], field);
  assert.ok(result.json.data.sample[1].issues.some(issue => issue.code === 'APAAR_MISSING'), 'missing identifiers are validation findings');

  const manualCsv = 'code,nm,course,session,status,id\nNITM,Manual Student,BTECH CSE,2026-27,Active,';
  const partialMapping = { institution_code: 'code', student_name: 'nm' };
  result = await call({ method: 'POST', url: '/api/v1/imports/preview', headers: institution, json: { filename: 'manual.csv', csv: manualCsv, mapping: partialMapping } });
  assert.deepEqual(result.json.data.unmapped_required_fields.sort(), ['academic_session', 'enrolment_status', 'programme']);
  result = await call({ method: 'POST', url: '/api/v1/imports/confirm', headers: institution, json: { filename: 'manual.csv', csv: manualCsv, mapping: partialMapping, institution_code: 'NITM' } });
  assert.equal(result.status, 400); assert.match(result.json.error, /Map all required columns/);
  const manualMapping = { ...partialMapping, programme: 'course', academic_session: 'session', enrolment_status: 'status', apaar_id: 'id' };
  result = await call({ method: 'POST', url: '/api/v1/imports/confirm', headers: institution, json: { filename: 'manual.csv', csv: manualCsv, mapping: manualMapping, institution_code: 'NITM' } });
  assert.equal(result.status, 201); assert.equal(result.json.data.imported, 1); assert.equal(result.json.data.rejected, 0);
  assert.ok(loadDemo().findings.some(finding => finding.rule_code === 'APAAR_MISSING' && finding.evidence.some(id => id.startsWith('SRC-UP-'))));

  result = await call({ method: 'POST', url: '/api/v1/imports/confirm', headers: institution, json: { filename: 'three-institutions.csv', csv: sample, institution_code: 'NITM', multi_institution: true } });
  assert.equal(result.status, 403, 'institution users cannot request multi-institution imports');
  result = await call({ method: 'POST', url: '/api/v1/imports/confirm', headers: institution, json: { filename: 'three-institutions.csv', csv: sample, institution_code: 'NITM' } });
  assert.equal(result.status, 201); assert.equal(result.json.data.imported, 1); assert.equal(result.json.data.skipped, 2, 'single-institution import skips foreign rows without crossing scope');
  result = await call({ method: 'POST', url: '/api/v1/imports/confirm', headers: regulator, json: { filename: 'three-institutions.csv', csv: sample, multi_institution: true } });
  assert.equal(result.status, 201); assert.equal(result.json.data.imported, 3); assert.equal(result.json.data.rejected, 0);
  resetDemo();
});

test('18 row accounting reconciles and missing or malformed identifiers persist as findings', { concurrency: false }, async () => {
  resetDemo();
  const headers='institution_code,student_name,apaar_id,programme,academic_session,enrolment_status';
  const rows=Array.from({length:18},(_,index)=>{const institution=index<9?'NITM':'RCA';const id=index===0?'':index===1?'bad-value':String(810000000000+index);const name=index===8?'':`Synthetic ${index+1}`;return `${institution},${name},${id},BBA,2026-27,Active`;});
  const response=await call({method:'POST',url:'/api/v1/imports/confirm',headers:{'x-demo-role':'regulator'},json:{filename:'sample-18.csv',csv:[headers,...rows].join('\n'),institution_code:'NITM'}});
  assert.equal(response.status,201);const batch=response.json.data;
  assert.deepEqual([batch.rows_detected,batch.imported,batch.rejected,batch.skipped],[18,8,1,9]);
  assert.equal(batch.rows_detected,batch.imported+batch.rejected+batch.skipped);
  assert.deepEqual(batch.row_outcomes.filter(row=>row.outcome==='skipped').map(row=>row.source_row),Array.from({length:9},(_,index)=>index+11));
  assert.deepEqual(batch.row_outcomes.find(row=>row.outcome==='rejected'),{source_row:10,outcome:'rejected',reason:'Required values missing: student_name.'});
  assert.match(batch.row_outcomes.find(row=>row.outcome==='skipped').reason,/does not match selected source institution NITM/);
  assert.ok(batch.row_outcomes.some(row=>row.source_row===2&&row.validation_issues.includes('APAAR_MISSING')));
  assert.ok(batch.row_outcomes.some(row=>row.source_row===3&&row.validation_issues.includes('APAAR_MALFORMED')));
  assert.equal(batch.validation_findings_created,2);
  const db=loadDemo();assert.equal(db.sourceRecords.length,368);
  assert.equal(db.findings.filter(f=>f.rule_code==='APAAR_MISSING'&&f.evidence.some(id=>id.startsWith('SRC-UP-'))).length,1);
  assert.equal(db.findings.filter(f=>f.rule_code==='APAAR_MALFORMED'&&f.evidence.some(id=>id.startsWith('SRC-UP-'))).length,1);
  resetDemo();
});

test('graph data is generated from persisted findings, scoped, and masks identifiers', { concurrency: false }, async () => {
  resetDemo();
  const all=await call({url:'/api/v1/graph'});assert.equal(all.status,200);
  const data=all.json.data;assert.ok(data.nodes.some(node=>node.type==='institution'));assert.ok(data.nodes.some(node=>node.type==='record'));
  assert.ok(data.edges.some(edge=>edge.type==='source'));for(const type of ['exact','candidate','conflict'])assert.ok(data.edges.some(edge=>edge.type===type),`${type} edge is present in the seeded evidence`);
  const records=data.nodes.filter(node=>node.type==='record');assert.ok(records.every(node=>node.label.startsWith(`${node.institution_code} · Row ${node.detail.source_row} · `)));assert.equal(new Set(records.map(node=>node.label)).size,records.length,'record labels include institution, row, and a stable unique suffix');assert.ok(records.every(node=>node.detail.source_batch));
  const persistedFindings=new Map(loadDemo().findings.map(finding=>[finding.id,finding]));for(const edge of data.edges){if(edge.type==='source'){assert.ok(records.some(node=>`record:${node.detail.id}`===edge.target),'source edge points to a persisted source record');assert.ok(edge.evidence?.source_row&&edge.evidence?.source_batch);}else{assert.ok(persistedFindings.has(edge.finding_id),'match edge is backed by a persisted finding');assert.equal(edge.evidence?.rule_code,persistedFindings.get(edge.finding_id).rule_code);}}
  for(const type of ['exact','candidate','conflict']){const edge=data.edges.find(item=>item.type===type);const source=data.nodes.find(node=>node.id===edge.source);const target=data.nodes.find(node=>node.id===edge.target);assert.ok([...source.detail.findings,...target.detail.findings].some(finding=>finding.id===edge.finding_id),'relationship evidence is present on its source record nodes');}
  const record=data.nodes.find(node=>node.type==='record');assert.match(record.detail.apaar_id,/••••|Not provided/);assert.doesNotMatch(JSON.stringify(data),/7000000000\d{2}/);
  assert.ok(record.detail.findings.some(finding=>finding.records.length>0&&Array.isArray(finding.matched_fields)&&Array.isArray(finding.conflicting_fields)));
  const institution=await call({url:'/api/v1/graph?institution=RCA&relationship=conflict&status=pending',headers:{'x-demo-role':'institution','x-demo-institution':'SVU'}});
  assert.ok(institution.json.data.nodes.every(node=>node.institution_code==='NITM'));
  assert.ok(institution.json.data.filters.institutions.includes('NITM'));
  const empty=await call({url:'/api/v1/graph?relationship=candidate&status=resolved'});assert.equal(empty.json.data.nodes.length,0);
  const dashboard=await call({url:'/api/v1/dashboard/summary'});assert.equal(dashboard.json.data.severity_total,dashboard.json.data.accessible_findings);assert.ok(dashboard.json.data.metric_definitions.validation_issues.includes('regardless of review status'));
  const institutionHeaders={'x-demo-role':'institution','x-demo-institution':'SVU'};const scopedDashboard=await call({url:'/api/v1/dashboard/summary',headers:institutionHeaders});assert.equal(scopedDashboard.json.data.imported_records,120);assert.equal(scopedDashboard.json.data.severity_total,scopedDashboard.json.data.accessible_findings);const scopedFindings=await call({url:'/api/v1/findings',headers:institutionHeaders});assert.equal(scopedDashboard.json.data.pending_decisions,scopedFindings.json.data.filter(finding=>finding.review_status==='pending').length);
  resetDemo();
});

test('finding search supports partial fields, combinable scoped filters, masked suffixes, counts, and clear', { concurrency: false }, async () => {
  resetDemo();
  const all=await call({url:'/api/v1/findings'});const baseline=all.json;assert.equal(baseline.total,baseline.accessible_total);
  const mixedCase=await call({url:'/api/v1/findings?q=student%20nitm%201'});assert.ok(mixedCase.json.total>0);const stored=id=>loadDemo().sourceRecords.find(x=>x.id===id);assert.ok(mixedCase.json.data.some(f=>f.records.some(r=>stored(r.id).student_name.toLocaleLowerCase().includes('student nitm 1'))));assert.ok(mixedCase.json.data.every(f=>f.records.every(r=>r.student_name.includes('•'))),'the findings list returns masked names; search still runs on stored values');
  const institutionName=await call({url:'/api/v1/findings?q=northbridge'});assert.ok(institutionName.json.total>0);assert.ok(institutionName.json.data.every(f=>f.records.some(r=>r.institution_code==='NITM')));
  const programme=await call({url:'/api/v1/findings?q=btech'});assert.ok(programme.json.total>0);assert.ok(programme.json.data.every(f=>f.records.some(r=>r.programme.includes('BTECH'))));
  const target=baseline.data[0],record=target.records[0],firstName=stored(record.id).student_name.split(' ')[0];const combined=new URLSearchParams({q:firstName,institution:record.institution_code,category:target.category,severity:target.severity,status:target.review_status,session:record.academic_session,batch:loadDemo().sourceRecords.find(r=>r.id===record.id).import_id});const filtered=await call({url:'/api/v1/findings?'+combined});assert.ok(filtered.json.total>0);assert.ok(filtered.json.data.every(f=>f.category===target.category&&f.severity===target.severity&&f.review_status===target.review_status&&f.records.some(r=>r.institution_code===record.institution_code&&r.academic_session===record.academic_session&&stored(r.id).student_name.toLocaleLowerCase().includes(firstName.toLocaleLowerCase()))));assert.equal(filtered.json.by_severity.reduce((sum,item)=>sum+item.count,0),filtered.json.total);
  const idSearch=await call({url:'/api/v1/findings?q='+encodeURIComponent(target.id.slice(0,12))});assert.ok(idSearch.json.data.some(f=>f.id===target.id));
  const maskedSuffix=record.apaar_id.slice(-4);const suffixSearch=await call({url:'/api/v1/findings?q='+maskedSuffix});assert.ok(suffixSearch.json.total>0);assert.doesNotMatch(JSON.stringify(suffixSearch.json),/7000000000\d{2}/);
  const empty=await call({url:'/api/v1/findings?q='+encodeURIComponent('<script>alert(1)</script>')});assert.equal(empty.json.total,0);assert.equal(empty.json.accessible_total,baseline.accessible_total);assert.equal(empty.json.by_severity.reduce((sum,item)=>sum+item.count,0),0);assert.doesNotMatch(JSON.stringify(empty.json),/<script>/);
  const scoped=await call({url:'/api/v1/findings?q=student%20rca&institution=RCA',headers:{'x-demo-role':'institution','x-demo-institution':'SVU'}});assert.equal(scoped.json.total,0);assert.ok(scoped.json.data.every(f=>f.records.every(r=>r.institution_code==='NITM')));assert.deepEqual(scoped.json.filter_options.institutions.map(i=>i.code),['NITM']);
  const clear=await call({url:'/api/v1/findings'});assert.equal(clear.json.total,baseline.accessible_total);assert.deepEqual(clear.json.by_severity,baseline.accessible_by_severity);
  resetDemo();
});

test('preview dry run matches confirmed row accounting and masks header samples', { concurrency: false }, async () => {
  resetDemo();
  const headers = { 'x-demo-role': 'regulator' };
  const body = { filename: 'dry-run.csv', csv: 'Learner,College,Course,Session,Status,ID\nAsha,NITM,BBA,2026-27,Active,812345678901\nRohan,NITM,BBA,2026-27,Active,\n,NITM,BBA,2026-27,Active,812345678903\nKabir,RCA,BBA,2026-27,Active,812345678904', mapping: { student_name: 'Learner', institution_code: 'College', programme: 'Course', academic_session: 'Session', enrolment_status: 'Status', apaar_id: 'ID' }, institution_code: 'NITM' };
  const preview = await call({ method: 'POST', url: '/api/v1/imports/preview', headers, json: body });
  assert.equal(preview.status, 200);
  const dry = preview.json.data.dry_run;
  assert.deepEqual([dry.ready, dry.with_warnings, dry.rejected, dry.skipped], [1, 1, 1, 1]);
  assert.equal(preview.json.data.header_samples.ID, '•••• •••• 8901', 'identifier-shaped samples are masked');
  assert.equal(preview.json.data.sample[1].outcome.validation_issues[0], 'APAAR_MISSING');
  assert.doesNotMatch(JSON.stringify(preview.json), /812345678901/);
  assert.equal(loadDemo().sourceRecords.length, 360, 'preview never persists records');
  const confirmed = await call({ method: 'POST', url: '/api/v1/imports/confirm', headers, json: body });
  assert.equal(confirmed.status, 201);
  assert.deepEqual([confirmed.json.data.imported, confirmed.json.data.rejected, confirmed.json.data.skipped], [dry.ready + dry.with_warnings, dry.rejected, dry.skipped]);
  const unmapped = await call({ method: 'POST', url: '/api/v1/imports/preview', headers, json: { ...body, mapping: { student_name: 'Learner' } } });
  assert.equal(unmapped.json.data.dry_run, null, 'no dry run until required fields are mapped');
  const forged = await call({ method: 'POST', url: '/api/v1/imports/preview', headers: { 'x-demo-role': 'institution' }, json: { ...body, institution_code: 'RCA', multi_institution: true } });
  assert.equal(forged.json.data.dry_run.batch_institution, 'NITM'); assert.equal(forged.json.data.dry_run.multi_institution, false);
  resetDemo();
});

test('audit feed, import history, summary breakdowns, and filtered export respect scope', { concurrency: false }, async () => {
  resetDemo();
  const reg = { 'x-demo-role': 'regulator' };
  const inst = { 'x-demo-role': 'institution' };
  const all = (await call({ url: '/api/v1/findings', headers: reg })).json.data;
  const foreign = all.find(f => f.records.every(r => r.institution_code !== 'NITM'));
  const own = all.find(f => f.records.every(r => r.institution_code === 'NITM'));
  await call({ method: 'POST', url: `/api/v1/findings/${foreign.id}/decision`, headers: reg, json: { outcome: 'awaiting_verification', note: 'Regulator note on a non-NITM finding.' } });
  await call({ method: 'POST', url: `/api/v1/findings/${own.id}/decision`, headers: reg, json: { outcome: 'record_corrected', note: 'NITM corrected the record.' } });
  /* The seeded data also carries one system event (the automatically matched repeated
     submission); reviewer decisions are the non-system events. */
  const regFeed = (await call({ url: '/api/v1/audit', headers: reg })).json;
  const reviewerEvents = feed => feed.data.filter(e => !e.system);
  assert.equal(reviewerEvents(regFeed).length, 2); assert.equal(regFeed.data[0].finding_id, own.id, 'newest first'); assert.ok(regFeed.data[0].finding_title && regFeed.data[0].record_context.length);
  assert.ok(regFeed.data.filter(e => e.system).every(e => e.action === 'automatically_matched'));
  const instFeed = (await call({ url: '/api/v1/audit', headers: inst })).json;
  assert.deepEqual(reviewerEvents(instFeed).map(e => e.finding_id), [own.id], 'institution feed hides foreign findings');
  assert.ok(instFeed.data.every(e => e.record_context.every(r => r.institution_code === 'NITM')));
  const resolvedAgain = await call({ method: 'POST', url: `/api/v1/findings/${own.id}/decision`, headers: reg, json: { outcome: 'dismissed', note: 'Attempt to re-resolve.' } });
  assert.equal(resolvedAgain.status, 400, 'invalid transition is a client error'); assert.match(resolvedAgain.json.error, /reopened/);

  const regImports = (await call({ url: '/api/v1/imports', headers: reg })).json;
  assert.equal(regImports.data.length, 3); assert.equal(regImports.institutions.length, 3); assert.ok(regImports.data.every(b => !('row_outcomes' in b)));
  const instImports = (await call({ url: '/api/v1/imports', headers: inst })).json;
  assert.deepEqual(instImports.data.map(b => b.institution_code), ['NITM']); assert.deepEqual(instImports.institutions.map(i => i.code), ['NITM']);

  const summary = (await call({ url: '/api/v1/dashboard/summary', headers: reg })).json.data;
  assert.equal(summary.by_status.reduce((n, s) => n + s.count, 0), summary.accessible_findings);
  assert.equal(summary.by_rule.reduce((n, r) => n + r.count, 0), summary.accessible_findings);
  assert.deepEqual(summary.capacity.map(c => [c.institution_code, c.permitted_capacity, c.observed_active]), [['NITM', 35, 39]]);
  const instSummary = (await call({ url: '/api/v1/dashboard/summary', headers: { 'x-demo-role': 'institution', 'x-demo-institution': 'RCA' } })).json.data;
  assert.ok(instSummary.capacity.every(c => c.institution_code === 'NITM'));

  const fullCsv = (await call({ url: '/api/v1/reports/findings.csv', headers: reg })).text.trim().split('\n');
  assert.equal(fullCsv.length - 1, all.length, 'unfiltered export is unchanged');
  const highCsv = (await call({ url: '/api/v1/reports/findings.csv?severity=high', headers: reg })).text.trim().split('\n');
  assert.equal(highCsv.length - 1, all.filter(f => f.severity === 'high').length);
  const instCsv = (await call({ url: '/api/v1/reports/findings.csv', headers: inst })).text.trim().split('\n');
  assert.ok(instCsv.length - 1 < all.length, 'institution export is scoped');
  resetDemo();
});

test('static assets are served from an allow-list only', async () => {
  for (const asset of ['/', '/styles.css', '/app.js', '/reconciliation.js', '/import.js', '/graph.js']) assert.equal((await call({ url: asset })).status, 200, asset);
  for (const blocked of ['/server.js', '/../server.js', '/data/demo-db.json', '/public/app.js']) assert.equal((await call({ url: blocked })).status, 404, blocked);
});
