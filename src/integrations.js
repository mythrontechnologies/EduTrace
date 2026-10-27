// External identity and credential services: APAAR, ABC (Academic Bank of Credits) and DigiLocker.
//
// None is connected. Live integration needs the services' documentation, authorisation and interface access,
// which this project does not have. Everything goes through one adapter so a real one can be added later
// without touching the rules.
//
//   none  (default) every check answers "not connected". The only check performed is the local format check
//         (12 digits after removing spaces and hyphens), which is not identity verification.
//   mock  development and demo only, for synthetic demonstrations. Every result is marked simulated and says
//         that no official service was called. Refused in production.
const crypto = require('node:crypto');
const { StartupError } = require('./mode');

const SERVICES = {
  apaar: { name: 'APAAR ID registry', purpose: 'Confirm that an APAAR ID exists and belongs to the student' },
  abc: { name: 'Academic Bank of Credits (ABC)', purpose: 'Confirm enrolment and credit records linked to the APAAR ID' },
  digilocker: { name: 'DigiLocker', purpose: 'Retrieve issuer-signed documents with the student\'s consent' }
};
const SIMULATED_LABEL = 'SIMULATED — mock adapter for synthetic demonstrations. No official service was called and nothing was verified.';
const formatCheck = r => (!r.apaar_id ? 'missing' : /^\d{12}$/.test(r.apaar_id) ? 'locally_well_formed' : 'malformed');

function noneAdapter() {
  return {
    kind: 'none',
    status: () => Object.entries(SERVICES).map(([key, s]) => ({ service: key, ...s, connected: false, simulated: false, note: 'Not connected. Live integration needs the service\'s documentation, authorisation and interface access.' })),
    verify: r => ({ service: 'apaar', status: 'not_connected', verified: false, simulated: false, format_check: formatCheck(r), detail: 'No authorised APAAR service is connected. Only a local format check was performed; it is not identity verification.' })
  };
}

// Deterministic synthetic answers, so a demonstration is repeatable. They never claim a real check.
function mockAdapter() {
  return {
    kind: 'mock',
    status: () => Object.entries(SERVICES).map(([key, s]) => ({ service: key, ...s, connected: false, simulated: true, note: SIMULATED_LABEL })),
    verify: r => {
      const check = formatCheck(r);
      const bucket = check === 'locally_well_formed' ? parseInt(crypto.createHash('sha256').update(`mock:${r.apaar_fingerprint}`).digest('hex').slice(0, 2), 16) % 4 : null;
      const status = check !== 'locally_well_formed' ? 'simulated_not_checkable' : bucket === 0 ? 'simulated_no_record' : 'simulated_record_found';
      return { service: 'apaar', status, verified: false, simulated: true, label: SIMULATED_LABEL, format_check: check, detail: status === 'simulated_not_checkable' ? 'The identifier is missing or malformed, so even a simulated lookup is not attempted.' : `The mock adapter returned "${status.replace('simulated_', '').replaceAll('_', ' ')}" from a fixed synthetic rule.` };
    }
  };
}

function integrationsFromEnv(env, mode) {
  const kind = env.EDUTRACE_INTEGRATIONS === undefined ? 'none' : env.EDUTRACE_INTEGRATIONS;
  if (kind === 'none') return noneAdapter();
  if (kind !== 'mock') throw new StartupError(`EDUTRACE_INTEGRATIONS="${String(kind).slice(0, 20)}" is not recognised.`, ['Supported values: none, mock.']);
  if (mode === 'production') throw new StartupError('the mock integration adapter is for synthetic demonstrations and is refused in production.');
  return mockAdapter();
}

module.exports = { SERVICES, SIMULATED_LABEL, noneAdapter, mockAdapter, integrationsFromEnv };
