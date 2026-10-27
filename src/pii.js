// Masking of personal data at the API boundary. Every JSON response passes through maskPII before it is sent, so a
// value hidden here is never in the browser at all. The stored data is not changed.
//
// Policy
//   APAAR identifiers   always masked to the last four characters, in every response, including raw source values,
//                       lineage changes, simulations and receipts. Never returned in full.
//   names, dates of birth  masked (initials; year only) in every list, overview, graph, audit, simulation and receipt
//                       response. Shown in full only on record-level decision views (REVEAL_ROUTES), and only to roles
//                       with the pii.read capability (reviewer, institution administrator). Auditors and platform
//                       administrators always see masked values.
// A value is recognised by its key (student_name, date_of_birth, apaar_id, ...) or, for objects that describe one
// field ({ key|field: 'student_name', value, original_value, from, to, before, after }), by that field.
// Free text written by people (reviewer notes, consent references) is not rewritten; the UI asks for no identifiers.
const { mask } = require('./engine');

const KINDS = { student_name: 'name', normalized_name: 'name', name_a: 'name', name_b: 'name', date_of_birth: 'dob', apaar_id: 'id', apaar: 'id' };
const VALUE_KEYS = new Set(['value', 'original_value', 'from', 'to', 'before', 'after']);
const REVEAL_ROUTES = [
  /^\/api\/v1\/records\/[^/]+$/, /^\/api\/v1\/records\/[^/]+\/lineage$/, /^\/api\/v1\/identities\/[^/]+\/history$/, /^\/api\/v1\/profiles\/[^/]+$/,
  /^\/api\/v1\/matches\/[^/]+$/, /^\/api\/v1\/matches\/[^/]+\/decision$/, /^\/api\/v1\/findings\/[^/]+$/, /^\/api\/v1\/findings\/[^/]+\/decision$/
];

const maskName = s => s.split(/\s+/).filter(Boolean).map(t => `${[...t][0].toUpperCase()}${'•'.repeat(Math.min(Math.max([...t].length - 1, 2), 5))}`).join(' ') || '•••';
function maskDob(s) { const year = s.match(/(?:19|20)\d{2}/); const out = s.replace(/\d/g, '•'); return year ? out.slice(0, year.index) + year[0] + out.slice(year.index + 4) : out; }
const isMasked = s => s.includes('•') || s === 'Not provided';
function maskValue(kind, value, reveal) {
  if (typeof value !== 'string' || !value || isMasked(value)) return value;
  if (kind === 'id') return mask(value.replace(/[\s-]/g, ''));
  if (reveal) return value;
  return kind === 'name' ? maskName(value) : maskDob(value);
}

// Configuration keyed by field name (column mappings) holds header names, not personal data.
const SKIP = new Set(['mapping', 'mapping_sources']);
function walk(value, ctx, reveal) {
  if (Array.isArray(value)) return value.map(v => walk(v, ctx, reveal));
  if (!value || typeof value !== 'object') return value;
  const own = typeof value.key === 'string' || typeof value.field === 'string' ? KINDS[value.key] || KINDS[value.field] || null : ctx;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SKIP.has(k)) out[k] = v;
    // Student-history timeline events report the values they saw as { values: { name, date_of_birth, ... } }.
    else if (k === 'values' && v && typeof v === 'object' && !Array.isArray(v)) out[k] = Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, typeof vv === 'string' && (kk === 'name' || KINDS[kk]) ? maskValue(kk === 'name' ? 'name' : KINDS[kk], vv, reveal) : walk(vv, null, reveal)]));
    else if (KINDS[k] && typeof v === 'string') out[k] = maskValue(KINDS[k], v, reveal);
    else if (own && VALUE_KEYS.has(k) && typeof v === 'string') out[k] = maskValue(own, v, reveal);
    else out[k] = walk(v, own, reveal);
  }
  return out;
}

const maskPII = (body, { reveal = false } = {}) => walk(body, null, reveal);
const revealsPII = (p, pathname) => Boolean(p?.capabilities?.includes('pii.read') && REVEAL_ROUTES.some(re => re.test(pathname)));

module.exports = { REVEAL_ROUTES, maskPII, revealsPII, maskName, maskDob, maskValue };
