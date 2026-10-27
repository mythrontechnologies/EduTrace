// Operating modes. EDUTRACE_MODE is read once, before the server listens or touches any data.
//
//   development  The local prototype: the JSON file store (data/demo-db.json or EDUTRACE_DB_PATH),
//                or PostgreSQL with EDUTRACE_STORE=postgres; sign-in with local accounts (or OIDC
//                bearer tokens); every route; AI as configured.
//   demo         A public, read-only walkthrough: a deterministic synthetic dataset built in memory
//                at startup, application writes rejected with 403, AI forced off. It never reads or
//                writes a database file. Optional local judge accounts use the separate users store.
//   synthetic-test A localhost-only, ephemeral test harness with generated in-memory data.
//   production   Refuses to start until real production prerequisites exist in code (see
//                PRODUCTION_REQUIREMENTS). Nothing in this file can be switched on by an env flag.
//
// An unset mode means development only on a local machine. When NODE_ENV=production or a hosting
// platform is detected, the mode must be explicit and development is refused, so a misconfigured
// host can never expose the writable development routes.
const MODES = Object.freeze(['development', 'demo', 'synthetic-test', 'production']);

// Variables that hosting platforms set on every process they run. Their presence means "this is
// not a developer's machine".
const HOSTING_MARKERS = Object.freeze(['RENDER', 'FLY_APP_NAME', 'K_SERVICE', 'RAILWAY_ENVIRONMENT', 'DYNO', 'WEBSITE_SITE_NAME', 'VERCEL', 'AWS_EXECUTION_ENV', 'KUBERNETES_SERVICE_HOST']);

class StartupError extends Error {
  constructor(message, details = []) { super(message); this.name = 'StartupError'; this.details = details; }
  report() { return [`EduTrace did not start: ${this.message}`, ...this.details.map(line => `  - ${line}`)].join('\n'); }
}

function hostedEnvironment(env) {
  const markers = HOSTING_MARKERS.filter(key => env[key] !== undefined && env[key] !== '');
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') markers.unshift('NODE_ENV=production');
  return markers;
}

// Returns { mode, explicit, hosted }. Throws StartupError for anything else.
function resolveMode(env = process.env) {
  const hosted = hostedEnvironment(env);
  const raw = env.EDUTRACE_MODE;
  if (raw === undefined) {
    if (hosted.length) throw new StartupError(`EDUTRACE_MODE must be set explicitly in a production or hosted environment (detected: ${hosted.join(', ')}).`, [`Supported values: ${MODES.join(', ')}.`, 'Use EDUTRACE_MODE=demo for the read-only synthetic demo.']);
    return { mode: 'development', explicit: false, hosted };
  }
  if (!MODES.includes(raw)) throw new StartupError(`EDUTRACE_MODE="${String(raw).slice(0, 40)}" is not a recognised mode.`, [`Supported values (exact, lower case): ${MODES.join(', ')}.`]);
  if (raw === 'development' && hosted.length) throw new StartupError(`development mode is for a local machine only and is refused here (detected: ${hosted.join(', ')}).`, ['Development mode has no authentication and lets any request change or reset the data.', 'Use EDUTRACE_MODE=demo for the read-only synthetic demo.']);
  if (raw === 'synthetic-test' && hosted.length) throw new StartupError(`synthetic-test mode is localhost-only and is refused in a hosted or production environment (detected: ${hosted.join(', ')}).`, ['Run synthetic-test mode only on a local developer machine.']);
  return { mode: raw, explicit: true, hosted };
}

// What production needs before it may serve a single request. Each requirement is met only by a
// capability that exists in code and is passed in here; none of them is implemented yet, so
// production always refuses to start. Do not add environment flags that report readiness.
const PRODUCTION_CAPABILITIES = Object.freeze({ database: null, authentication: null, authorization: null, tenantScoping: null, safeguards: null });
const PRODUCTION_REQUIREMENTS = Object.freeze([
  { id: 'durable_database', met: c => Boolean(c.database?.durable), missing: 'No durable production database is wired. The PostgreSQL store (src/pg-store.js) is implemented and tested in development mode only; production needs an approved, managed PostgreSQL server with backups, and the store wired for production. The JSON file store is never used in production.' },
  { id: 'database_connection', met: (c, env) => Boolean(c.database?.connectionVerified && env.EDUTRACE_DATABASE_URL), missing: 'No database connection or schema validation has been performed (EDUTRACE_DATABASE_URL and an adapter that verifies it are both required).' },
  { id: 'no_seed_on_missing_storage', met: c => c.database?.seedsWhenMissing === false, missing: 'Missing storage must never be recreated from the synthetic seed. The PostgreSQL store never seeds, but production does not use it yet; the development file store recreates a missing file from the seed.' },
  { id: 'authentication', met: c => Boolean(c.authentication), missing: 'No production identity provider is configured and verified for authentication. OIDC bearer-token verification exists (src/auth.js) but needs a chosen provider, its signing keys and the browser sign-in flow; local accounts are development sign-in, and the x-demo-role header is a simulation for the read-only demo.' },
  { id: 'server_side_authorization', met: c => Boolean(c.authorization?.denyAnonymous), missing: 'Authorisation is enforced per route and per record, but memberships live in a local file; production needs them in the durable store with administration and audit.' },
  { id: 'tenant_scoping', met: c => Boolean(c.tenantScoping), missing: 'Institution scope comes from the signed-in account or the OIDC membership file, but production has no verified identity provider or durable membership store to derive it from.' },
  { id: 'server_side_secrets', met: (c, env) => !env.EDUTRACE_AI_PROVIDER || (env.EDUTRACE_AI_PROVIDER === 'anthropic' ? Boolean(env.ANTHROPIC_API_KEY) : true), missing: 'EDUTRACE_AI_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set in the server environment.' },
  { id: 'production_safeguards', met: c => Boolean(c.safeguards), missing: 'Generic errors, security headers, rate limiting and audit with authenticated actors are implemented and tested locally, but not verified on a production host; rate limits and sessions are held per process, so several instances need a shared store.' }
]);

function productionBlockers(env = process.env, capabilities = PRODUCTION_CAPABILITIES) {
  return PRODUCTION_REQUIREMENTS.filter(r => !r.met(capabilities, env)).map(r => ({ id: r.id, missing: r.missing }));
}

function assertProductionReady(env = process.env) {
  const blockers = productionBlockers(env);
  if (blockers.length) throw new StartupError('production mode is not available: its prerequisites are not implemented.', [...blockers.map(b => b.missing), 'Use EDUTRACE_MODE=demo for the read-only synthetic demo, or development on a local machine.']);
  // Unreachable until the capabilities above exist; kept so a partial implementation cannot fall through.
  throw new StartupError('production mode has no runtime yet.');
}

module.exports = { MODES, HOSTING_MARKERS, StartupError, hostedEnvironment, resolveMode, PRODUCTION_CAPABILITIES, PRODUCTION_REQUIREMENTS, productionBlockers, assertProductionReady };
