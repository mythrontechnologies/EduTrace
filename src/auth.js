// Authentication and authorisation.
//
// Every API request is authenticated before data is read, then checked against the capability its
// route requires (ROUTE_RULES). Object-level scoping (engine.canAccess) still applies inside each route.
//
// Authenticators:
//   demo_header  the read-only demo. The x-demo-role header names a simulated principal
//                (regulator lens or the NITM lens). It is a labelled simulation, not authentication: the
//                header is the claim. A request without a recognised header is anonymous and gets 401.
//   oidc         OpenID Connect bearer tokens (JWT, RS256 or ES256) verified against the identity
//                provider's JWKS: signature, issuer, audience, expiry, not-before and issued-at with a
//                bounded clock skew. Roles and institution memberships come only from the server-side
//                membership file, never from token claims or request headers.
// The browser sign-in flow (authorisation code with PKCE) needs a chosen identity provider and is not
// part of this build; production stays blocked (src/mode.js). Demo-local sessions are opt-in and only
// see the immutable synthetic in-memory dataset.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { StartupError } = require('./mode');

const CAPABILITIES = {
  'records.read': 'Read source records, findings, matches, graph, history and notifications in scope',
  'audit.read': 'Read the audit history in scope',
  'receipts.read': 'Read and verify decision receipts in scope',
  'reports.export': 'Export the findings report in scope',
  'findings.decide': 'Record review decisions on findings',
  'matches.decide': 'Record identity decisions on potential matches',
  'corrections.decide': 'Confirm or reject correction candidates',
  'notifications.acknowledge': 'Acknowledge exception notifications',
  'imports.write': 'Preview and import source files',
  'simulations.run': 'Run Evidence Impact Lab simulations (never saved)',
  'ai.assist': 'Request advisory model explanations',
  'ai.status': 'See model provider status',
  'ai.check': 'Send a synthetic test request to the model provider',
  'automation.revalidate': 'Re-run reconciliation for all data',
  'data.reset': 'Reset the synthetic development data',
  'data.initialize': 'Create a new empty import dataset while retaining the source database',
  'session.signout': 'End one\'s own session',
  'consent.record': 'Record the consent status of the institution\'s students',
  'pii.read': 'See full names and dates of birth on record-level views (identifiers stay masked)'
};
const ROLES = {
  reviewer: ['session.signout', 'pii.read', 'records.read', 'audit.read', 'receipts.read', 'reports.export', 'findings.decide', 'matches.decide', 'notifications.acknowledge', 'simulations.run', 'ai.assist', 'ai.status'],
  auditor: ['session.signout', 'records.read', 'audit.read', 'receipts.read', 'reports.export', 'ai.status'],
  institution_admin: ['session.signout', 'consent.record', 'pii.read', 'records.read', 'audit.read', 'receipts.read', 'reports.export', 'imports.write', 'corrections.decide', 'notifications.acknowledge', 'simulations.run', 'ai.status'],
  platform_admin: ['session.signout', 'ai.status', 'ai.check', 'automation.revalidate', 'data.reset', 'data.initialize']
};

// The capability each API route needs. Paths and methods mirror server.js; a test checks every route has a rule.
const ROUTE_RULES = [
  ['GET', /^\/api\/v1\/dashboard\/summary$/, 'records.read'], ['GET', /^\/api\/v1\/audit$/, 'audit.read'], ['GET', /^\/api\/v1\/imports$/, 'records.read'],
  ['GET', /^\/api\/v1\/ai\/status$/, 'ai.status'], ['POST', /^\/api\/v1\/ai\/check$/, 'ai.check'], ['GET', /^\/api\/v1\/automation$/, 'records.read'],
  ['GET', /^\/api\/v1\/matches$/, 'records.read'], ['POST', /^\/api\/v1\/matches\/[^/]+\/decision$/, 'matches.decide'], ['POST', /^\/api\/v1\/matches\/[^/]+\/explain$/, 'ai.assist'],
  ['GET', /^\/api\/v1\/matches\/[^/]+$/, 'records.read'], ['GET', /^\/api\/v1\/records$/, 'records.read'], ['GET', /^\/api\/v1\/identities\/[^/]+\/history$/, 'records.read'],
  ['GET', /^\/api\/v1\/records\/[^/]+\/lineage$/, 'records.read'], ['GET', /^\/api\/v1\/corrections$/, 'records.read'], ['POST', /^\/api\/v1\/corrections\/[^/]+\/decision$/, 'corrections.decide'],
  ['GET', /^\/api\/v1\/records\/[^/]+$/, 'records.read'], ['GET', /^\/api\/v1\/profiles\/[^/]+$/, 'records.read'], ['GET', /^\/api\/v1\/notifications$/, 'records.read'],
  ['POST', /^\/api\/v1\/notifications\/[^/]+\/acknowledge$/, 'notifications.acknowledge'], ['POST', /^\/api\/v1\/automation\/revalidate$/, 'automation.revalidate'],
  ['GET', /^\/api\/v1\/findings\/[^/]+\/explanation$/, 'records.read'], ['POST', /^\/api\/v1\/findings\/[^/]+\/assist$/, 'ai.assist'], ['GET', /^\/api\/v1\/graph$/, 'records.read'],
  ['GET', /^\/api\/v1\/evidence\/checklist$/, 'records.read'], ['POST', /^\/api\/v1\/simulations\/correction$/, 'simulations.run'], ['GET', /^\/api\/v1\/receipts\/[^/]+$/, 'receipts.read'],
  ['GET', /^\/api\/v1\/findings$/, 'records.read'], ['GET', /^\/api\/v1\/findings\/[^/]+$/, 'records.read'], ['POST', /^\/api\/v1\/findings\/[^/]+\/decision$/, 'findings.decide'],
  ['POST', /^\/api\/v1\/imports\/preview$/, 'imports.write'], ['POST', /^\/api\/v1\/imports\/confirm$/, 'imports.write'], ['GET', /^\/api\/v1\/reports\/findings\.csv$/, 'reports.export'],
  ['POST', /^\/api\/v1\/demo\/reset$/, 'data.reset'], ['POST', /^\/api\/v1\/admin\/initialize-empty-import$/, 'data.initialize'], ['GET', /^\/api\/v1\/integrations$/, 'records.read'], ['POST', /^\/api\/v1\/auth\/logout$/, 'session.signout'], ['POST', /^\/api\/v1\/records\/[^/]+\/consent$/, 'consent.record'], ['GET', /^\/api\/v1\/records\/[^/]+\/verification$/, 'records.read']
];
const PUBLIC_API = new Set(['/api/v1/runtime', '/api/v1/institutions', '/api/v1/auth/login', '/api/v1/auth/session', '/api/v1/auth/register']);
function routeRule(method, pathname) {
  if (!pathname.startsWith('/api/') || PUBLIC_API.has(pathname)) return { public: true, capability: null };
  const rule = ROUTE_RULES.find(([m, re]) => m === method && re.test(pathname));
  return { public: false, capability: rule ? rule[2] : null };
}

class AuthError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

function principalOf({ name, subject, scope, institutionCode, roles, method }) {
  const capabilities = [...new Set(roles.flatMap(role => ROLES[role] || []))].sort();
  return { role: scope === 'all' ? 'regulator' : 'institution', institution_code: scope === 'all' ? null : institutionCode, name, subject, roles: [...roles].sort(), capabilities, authenticated: true, method };
}

// ── demo_header ──────────────────────────────────────────────────────────────────
const DEMO_PRINCIPALS = {
  regulator: () => principalOf({ name: 'Demo Regulator Reviewer', subject: 'demo:regulator', scope: 'all', roles: ['reviewer', 'auditor', 'institution_admin', 'platform_admin'], method: 'demo_header' }),
  institution: () => principalOf({ name: 'Demo NITM Reviewer', subject: 'demo:institution:NITM', scope: 'institution', institutionCode: 'NITM', roles: ['reviewer', 'institution_admin'], method: 'demo_header' })
};
function demoHeaderAuthenticator() {
  return { kind: 'demo_header', authenticate(req) { const role = req.headers['x-demo-role']; return DEMO_PRINCIPALS[role] ? DEMO_PRINCIPALS[role]() : null; } };
}

// ── oidc ─────────────────────────────────────────────────────────────────────────
const b64url = s => Buffer.from(s, 'base64url');
const ALGS = { RS256: { kty: 'RSA', verify: (data, key, sig) => crypto.verify('sha256', data, key, sig) }, ES256: { kty: 'EC', verify: (data, key, sig) => crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig) } };
const MAX_TOKEN = 8192;

function verifyJwt(token, { issuer, audience, keys, now = Date.now(), skewSeconds = 60 }) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN) throw new AuthError(401, 'The bearer token is missing or too long.', 'invalid_token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError(401, 'The bearer token is not a JWT.', 'invalid_token');
  let header; let claims;
  try { header = JSON.parse(b64url(parts[0]).toString('utf8')); claims = JSON.parse(b64url(parts[1]).toString('utf8')); } catch { throw new AuthError(401, 'The bearer token cannot be decoded.', 'invalid_token'); }
  const alg = ALGS[header.alg];
  if (!alg) throw new AuthError(401, 'The token algorithm is not accepted.', 'invalid_token'); // rejects none and HS*
  const jwk = keys.find(k => k.kid === header.kid && k.kty === alg.kty && (!k.alg || k.alg === header.alg) && (!k.use || k.use === 'sig'));
  if (!jwk) throw new AuthError(401, 'The token was not signed by a known key.', 'invalid_token');
  let ok = false;
  try { ok = alg.verify(Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), b64url(parts[2])); } catch { ok = false; }
  if (!ok) throw new AuthError(401, 'The token signature is not valid.', 'invalid_token');
  const t = Math.floor(now / 1000);
  if (claims.iss !== issuer) throw new AuthError(401, 'The token was issued by another issuer.', 'invalid_token');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) throw new AuthError(401, 'The token is not intended for this service.', 'invalid_token');
  if (!Number.isFinite(claims.exp) || claims.exp <= t - skewSeconds) throw new AuthError(401, 'The token has expired.', 'invalid_token');
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > t + skewSeconds)) throw new AuthError(401, 'The token is not valid yet.', 'invalid_token');
  if (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > t + skewSeconds)) throw new AuthError(401, 'The token was issued in the future.', 'invalid_token');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new AuthError(401, 'The token has no subject.', 'invalid_token');
  return claims;
}

// Memberships are trusted server-side configuration: { memberships: [{ issuer, subject, display_name, roles, institution_code|null }] }.
function parseMemberships(doc, issuer) {
  if (!doc || !Array.isArray(doc.memberships)) throw new StartupError('the membership file must contain a "memberships" array.');
  const bySubject = new Map();
  for (const m of doc.memberships) {
    if (m.issuer !== issuer || typeof m.subject !== 'string' || !m.subject) throw new StartupError('every membership needs the configured issuer and a subject.');
    if (!Array.isArray(m.roles) || !m.roles.length || m.roles.some(r => !ROLES[r])) throw new StartupError(`membership roles must be some of: ${Object.keys(ROLES).join(', ')}.`);
    if (m.institution_code !== null && (typeof m.institution_code !== 'string' || !/^[A-Z0-9]{2,12}$/.test(m.institution_code))) throw new StartupError('institution_code must be an institution code or null for cross-institution (regulator) scope.');
    const list = [...(bySubject.get(m.subject) || []), m];
    if (new Set(list.map(x => x.institution_code)).size > 1) throw new StartupError(`subject ${m.subject.slice(0, 40)} has memberships in more than one scope; this build supports one scope per person.`);
    bySubject.set(m.subject, list);
  }
  return bySubject;
}

function oidcAuthenticator({ issuer, audience, keys, memberships, now = () => Date.now(), skewSeconds = 60 }) {
  if (!issuer || !audience || !Array.isArray(keys) || !keys.length) throw new StartupError('OIDC needs an issuer, an audience and at least one signing key.');
  const bySubject = memberships instanceof Map ? memberships : parseMemberships(memberships, issuer);
  return {
    kind: 'oidc',
    authenticate(req) {
      const header = String(req.headers.authorization || '');
      if (!header) return null;
      const match = header.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/);
      if (!match) throw new AuthError(401, 'Use an Authorization: Bearer token.', 'invalid_token');
      const claims = verifyJwt(match[1], { issuer, audience, keys, now: now(), skewSeconds });
      const list = bySubject.get(claims.sub);
      if (!list) throw new AuthError(403, 'This identity has no EduTrace membership.', 'no_membership');
      const scope = list[0].institution_code === null ? 'all' : 'institution';
      return principalOf({ name: list[0].display_name || claims.sub, subject: `${issuer}|${claims.sub}`, scope, institutionCode: list[0].institution_code, roles: [...new Set(list.flatMap(m => m.roles))], method: 'oidc' });
    }
  };
}

// EDUTRACE_AUTH selects the authenticator. Read once at startup; an invalid configuration stops the process.
// Development signs people in with local accounts by default. The x-demo-role header is accepted only by the read-only
// synthetic demo, where it chooses a viewing scope and can change nothing.
function authFromEnv(env, mode, { pool = null, usersPath = null } = {}) {
  const kind = env.EDUTRACE_AUTH === undefined ? (mode === 'demo' ? 'demo_header' : 'local') : env.EDUTRACE_AUTH;
  if (kind === 'demo_header') {
    if (mode !== 'demo') throw new StartupError('EDUTRACE_AUTH=demo_header is only for the read-only demo (EDUTRACE_MODE=demo); a role header cannot authorise anything that writes.');
    return demoHeaderAuthenticator();
  }
  if (kind === 'local') {
    if (!['development', 'demo'].includes(mode)) throw new StartupError('Local account sign-in is available only in development or the read-only demo.');
    const { localSessionAuthenticator, fileDirectory, postgresDirectory } = require('./accounts');
    return localSessionAuthenticator({ directory: pool ? postgresDirectory(pool) : fileDirectory(usersPath), secureCookies: String(env.EDUTRACE_COOKIE_SECURE || '').toLowerCase() === 'true' });
  }
  if (mode === 'demo') throw new StartupError('The read-only demo supports simulated viewing or opt-in local accounts only.');
  if (kind !== 'oidc') throw new StartupError(`EDUTRACE_AUTH="${String(kind).slice(0, 20)}" is not recognised.`, ['Supported values: local or oidc (development); local or demo_header (demo).']);
  if (mode !== 'development') throw new StartupError(`EDUTRACE_AUTH=oidc is available in development mode only in this build (mode: ${mode}).`);
  const missing = ['EDUTRACE_OIDC_ISSUER', 'EDUTRACE_OIDC_AUDIENCE', 'EDUTRACE_OIDC_JWKS_PATH', 'EDUTRACE_MEMBERSHIPS_PATH'].filter(k => !env[k]);
  if (missing.length) throw new StartupError(`EDUTRACE_AUTH=oidc is missing ${missing.join(', ')}.`);
  let jwks; let members;
  try { jwks = JSON.parse(fs.readFileSync(env.EDUTRACE_OIDC_JWKS_PATH, 'utf8')); members = JSON.parse(fs.readFileSync(env.EDUTRACE_MEMBERSHIPS_PATH, 'utf8')); } catch { throw new StartupError('the JWKS or membership file could not be read as JSON.'); }
  return oidcAuthenticator({ issuer: env.EDUTRACE_OIDC_ISSUER, audience: env.EDUTRACE_OIDC_AUDIENCE, keys: jwks.keys, memberships: members });
}

module.exports = { CAPABILITIES, ROLES, ROUTE_RULES, routeRule, AuthError, principalOf, verifyJwt, parseMemberships, demoHeaderAuthenticator, oidcAuthenticator, authFromEnv };
