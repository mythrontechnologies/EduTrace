require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDemoDataset } = require('../src/demo-data');
const { byId, canAccess } = require('../src/engine');
const { identityHistory } = require('../src/history');
const { principalOf } = require('../src/auth');

// The read-path lookups replaced linear scans (docs/PERFORMANCE_RESULTS.md); these tests pin them to the scans.
test('byId returns exactly what a linear find returns, and follows appends and replaced arrays', () => {
  const db = buildDemoDataset();
  for (const list of [db.sourceRecords, db.findings, db.identityLinks]) {
    for (const item of list) assert.equal(byId(list, item.id), list.find(x => x.id === item.id));
    assert.equal(byId(list, 'NO-SUCH-ID'), undefined);
  }
  const dup = [{ id: 'A', n: 1 }, { id: 'A', n: 2 }];
  assert.equal(byId(dup, 'A').n, 1, 'first match wins, as with find');
  const added = { ...db.sourceRecords[0], id: 'SRC-APPENDED' };
  db.sourceRecords.push(added);
  assert.equal(byId(db.sourceRecords, 'SRC-APPENDED'), added, 'an appended record is found');
  const before = byId(db.identityLinks, db.identityLinks[0].id);
  db.identityLinks = db.identityLinks.slice(1);
  assert.equal(byId(db.identityLinks, before.id), undefined, 'a replaced link array is indexed afresh');
  db.sourceRecords[1].student_name = 'Changed In Place';
  assert.equal(byId(db.sourceRecords, db.sourceRecords[1].id).student_name, 'Changed In Place', 'in-place updates are seen');
  assert.equal(byId(undefined, 'x'), undefined);
});

test('history counts out-of-scope automatic links exactly as the original scan did, now and as of a past time', () => {
  const db = buildDemoDataset();
  // Add automatic links across institutions so the count is exercised, not just zero.
  const nitm = db.sourceRecords.filter(r => r.institution_code === 'NITM').slice(0, 6);
  const other = db.sourceRecords.filter(r => r.institution_code !== 'NITM').slice(0, 6);
  nitm.forEach((r, i) => db.identityLinks.push({ id: `TEST-LINK-${i}`, outcome: 'auto_linked', records: [r.id, other[i].id], group_key: `test:${i}` }));
  const p = principalOf({ name: 'NITM', subject: 'test', scope: 'institution', institutionCode: 'NITM', roles: ['reviewer'], method: 'test' });
  const original = (members, asOf) => db.sourceRecords.filter(r => !canAccess(p, r) && (!asOf || (r.imported_at && String(r.imported_at) <= asOf)) && [...members].some(m => db.identityLinks.some(l => l.outcome === 'auto_linked' && l.records.includes(m.id) && l.records.includes(r.id)))).length;
  let nonZero = 0;
  for (const asOf of [null, '2026-10-21T00:00:00.000Z']) {
    for (const r of db.sourceRecords.filter(x => x.institution_code === 'NITM')) {
      const h = identityHistory(db, p, r.id, { asOf });
      if (!h || h.not_yet_stored) continue;
      const members = h.records.map(x => db.sourceRecords.find(s => s.id === x.record_id));
      assert.equal(h.hidden_records, original(members, asOf), `${r.id} as of ${asOf}`);
      if (h.hidden_records) nonZero++;
    }
  }
  assert.ok(nonZero >= 6, 'the comparison covered records with hidden linked records');
});
