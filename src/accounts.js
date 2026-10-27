// Institution sign-in with local accounts and server-side sessions (EDUTRACE_AUTH=local, the development default).
//
// * Accounts live on the server: a JSON file (EDUTRACE_USERS_PATH, default data/users.json) with the JSON store, or
//   the app_users table with the PostgreSQL store. There are no default accounts; `npm run user -- add` creates one.
// * Passwords are kept only as scrypt hashes and compared in constant time. An unknown username costs the same work
//   as a wrong password, and both get the same answer.
// * A session is a random 256-bit id in an HttpOnly, SameSite=Strict cookie, held in this process, with idle and
//   absolute expiry. Every request that is not a read must also carry the session's CSRF token (x-csrf-token).
// * Role and institution come only from the account. Request headers never change them.
// * Repeated failures lock sign-in for that username and for that client address for 15 minutes.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { AuthError, ROLES, principalOf } = require('./auth');

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const COOKIE = 'edutrace_session';
const LIMITS = { idleMs: 30 * 60000, absoluteMs: 8 * 3600000, failures: 5, lockMs: 15 * 60000 };
const USERNAME = /^[a-z0-9._-]{3,64}$/;

function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('A password must be 12 to 256 characters.');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
const DUMMY = hashPassword('not-a-real-password-for-timing-only');
function verifyPassword(password, stored) {
  const parts = String(stored || DUMMY).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts; const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password ?? ''), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validateAccount(a) {
  if (!USERNAME.test(a.username || '')) throw new Error('A username is 3–64 lower-case letters, digits, dots, hyphens or underscores.');
  if (!ROLES[a.role]) throw new Error(`The role must be one of: ${Object.keys(ROLES).join(', ')}.`);
  if (a.institution_code !== null && !/^[A-Z0-9]{2,12}$/.test(a.institution_code || '')) throw new Error('institution_code is an institution code, or null for cross-institution (regulator) scope.');
  if (a.role === 'institution_admin' && a.institution_code === null) throw new Error('An institution administrator belongs to one institution.');
  if (!String(a.display_name || '').trim()) throw new Error('A display name is required.');
}

// Account directories. Both answer find(username) and add(account); neither ever creates a default account.
function fileDirectory(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).users || []; } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  return {
    kind: 'file',
    async find(username) { return read().find(u => u.username === username) || null; },
    async list() { return read().map(({ password_hash, ...u }) => u); },
    async add(account) {
      validateAccount(account); const users = read();
      if (users.some(u => u.username === account.username)) throw new Error('That username already exists.');
      const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify({ users: [...users, account] }, null, 2), { mode: 0o600 }); fs.renameSync(temp, file);
    },
    async setDisabled(username, disabled) {
      const users = read(); const u = users.find(x => x.username === username); if (!u) throw new Error('No such user.');
      u.disabled = disabled; const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify({ users }, null, 2), { mode: 0o600 }); fs.renameSync(temp, file);
    },
    async setPassword(username, passwordHash) {
      const users = read(); const u = users.find(x => x.username === username); if (!u) throw new Error('No such user.');
      u.password_hash = passwordHash; const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify({ users }, null, 2), { mode: 0o600 }); fs.renameSync(temp, file);
    }
  };
}
function postgresDirectory(pool) {
  const cols = 'username, display_name, password_hash, role, institution_code, disabled';
  return {
    kind: 'postgres',
    async find(username) { return (await pool.query(`SELECT ${cols} FROM app_users WHERE username = $1`, [username])).rows[0] || null; },
    async list() { return (await pool.query('SELECT username, display_name, role, institution_code, disabled FROM app_users ORDER BY username')).rows; },
    async add(a) { validateAccount(a); await pool.query('INSERT INTO app_users (username, display_name, password_hash, role, institution_code, disabled) VALUES ($1, $2, $3, $4, $5, $6)', [a.username, a.display_name, a.password_hash, a.role, a.institution_code, Boolean(a.disabled)]); },
    async setDisabled(username, disabled) { const r = await pool.query('UPDATE app_users SET disabled = $2 WHERE username = $1', [username, disabled]); if (!r.rowCount) throw new Error('No such user.'); },
    async setPassword(username, passwordHash) { const r = await pool.query('UPDATE app_users SET password_hash = $2 WHERE username = $1', [username, passwordHash]); if (!r.rowCount) throw new Error('No such user.'); }
  };
}

const parseCookies = header => Object.fromEntries(String(header || '').split(';').map(c => c.trim().split('=')).filter(([k, v]) => k && v).map(([k, ...v]) => [k, v.join('=')]));

function localSessionAuthenticator({ directory, now = () => Date.now(), secureCookies = false, limits = LIMITS }) {
  const sessions = new Map(); const failures = new Map();
  const cookie = (id, maxAge) => `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  const failed = key => { const t = now(); const f = (failures.get(key) || []).filter(x => t - x < limits.lockMs); failures.set(key, f); return f; };
  function sessionOf(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    const s = id && sessions.get(id); const t = now();
    if (!s) return null;
    if (t - s.last > limits.idleMs || t - s.created > limits.absoluteMs) { sessions.delete(id); return null; }
    s.last = t; return { id, ...s };
  }
  return {
    kind: 'local',
    async registerReviewer({ username, display_name, institution_code, password }) {
      const account = { username, display_name, role: 'reviewer', institution_code, password_hash: hashPassword(password), disabled: false };
      await directory.add(account);
    },
    authenticate(req) {
      const s = sessionOf(req); if (!s) return null;
      if (!['GET', 'HEAD'].includes(req.method)) {
        const token = String(req.headers['x-csrf-token'] || '');
        if (token.length !== s.csrf.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(s.csrf))) throw new AuthError(403, 'The request is missing its session security token. Reload the page and try again.', 'csrf_failed');
      }
      return s.principal;
    },
    // Returns { status, body, setCookie }.
    async login(req, input = {}) {
      const username = String(input.username || '').trim().toLowerCase(); const client = req.socket?.remoteAddress || 'local';
      if (failed(`u:${username}`).length >= limits.failures || failed(`c:${client}`).length >= limits.failures * 4) return { status: 429, body: { error: 'Too many failed sign-in attempts. Try again in 15 minutes.', code: 'locked' } };
      const user = USERNAME.test(username) ? await directory.find(username) : null;
      const ok = verifyPassword(input.password, user?.password_hash) && user && !user.disabled;
      if (!ok) { [`u:${username}`, `c:${client}`].forEach(k => failures.set(k, [...failed(k), now()])); return { status: 401, body: { error: 'The username or password is not correct.', code: 'invalid_credentials' } }; }
      failures.delete(`u:${username}`);
      const id = crypto.randomBytes(32).toString('base64url'); const csrf = crypto.randomBytes(24).toString('base64url');
      const principal = principalOf({ name: user.display_name, subject: `local|${user.username}`, scope: user.institution_code ? 'institution' : 'all', institutionCode: user.institution_code, roles: [user.role], method: 'local_session' });
      sessions.set(id, { principal, csrf, created: now(), last: now(), username: user.username });
      return { status: 200, body: { data: { user: { username: user.username, display_name: user.display_name, role: user.role, institution_code: user.institution_code }, csrf_token: csrf } }, setCookie: cookie(id, Math.floor(limits.absoluteMs / 1000)) };
    },
    session(req) { const s = sessionOf(req); return s ? { user: { username: s.username, display_name: s.principal.name, role: s.principal.roles[0], institution_code: s.principal.institution_code }, csrf_token: s.csrf } : null; },
    logout(req) { const s = sessionOf(req); if (s) sessions.delete(s.id); return cookie('', 0); },
    sessionCount: () => sessions.size
  };
}

module.exports = { COOKIE, LIMITS, hashPassword, verifyPassword, validateAccount, fileDirectory, postgresDirectory, localSessionAuthenticator, parseCookies };
