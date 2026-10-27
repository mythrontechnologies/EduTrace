// Starts EduTrace with model assistance from the local Ollama server (npm run start:local-ai).
// Settings already present in the environment win; otherwise the provider is ollama on
// http://localhost:11434 with the default local model chosen by the benchmark. Name sharing stays
// off unless EDUTRACE_AI_SHARE_NAMES=true is set explicitly. If Ollama is not running, the app
// still starts and every task uses its deterministic result.
// Development mode only, through the same start() as npm start: sign-in, store and checks are identical.
const { resolveMode, StartupError } = require('../src/mode');
try {
  const { mode } = resolveMode();
  if (mode !== 'development') throw new StartupError(`npm run start:local-ai runs development mode only (EDUTRACE_MODE=${mode}).`, ['Use npm start for the demo; it keeps model assistance off.']);
} catch (error) { if (!(error instanceof StartupError)) throw error; console.error(error.report()); process.exit(1); }
process.env.EDUTRACE_AI_PROVIDER = process.env.EDUTRACE_AI_PROVIDER || 'ollama';
const { start } = require('../server');
const { createProvider } = require('../src/ai-provider');
const status = createProvider().status();
try { start(); } catch (error) { if (!(error instanceof StartupError)) throw error; console.error(error.report()); process.exit(1); }
console.log(status.configured ? `Model assistance: ${status.provider_label}, model ${status.model}${status.local ? ` at ${status.settings.base_url}` : ''} (not contacted until first use).` : `Model assistance off: ${status.reason}`);
