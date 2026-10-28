const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('Render defines one fixed-viewer Docker web service with a health check and no external services', () => {
  const blueprint = read('render.yaml');
  assert.equal((blueprint.match(/^  - type: web$/gm) || []).length, 1);
  assert.match(blueprint, /runtime: docker/);
  assert.match(blueprint, /dockerfilePath: \.\/Dockerfile/);
  assert.match(blueprint, /dockerContext: \./);
  assert.match(blueprint, /dockerCommand: npm start/);
  assert.match(blueprint, /healthCheckPath: \/healthz/);
  assert.match(blueprint, /key: NODE_ENV\s+value: production/);
  assert.match(blueprint, /key: EDUTRACE_MODE\s+value: demo/);
  assert.match(blueprint, /key: EDUTRACE_AUTH\s+value: hosted_demo/);
  assert.match(blueprint, /key: EDUTRACE_HOSTED_DEMO_PASSWORD_HASH\s+sync: false/);
  assert.match(blueprint, /minInstances: 1[\s\S]*maxInstances: 1/);
  assert.doesNotMatch(blueprint, /databases:|ANTHROPIC_API_KEY|EDUTRACE_DATABASE_URL|EDUTRACE_AI_PROVIDER|EDUTRACE_INTEGRATIONS/);
});

test('the image pins Node, installs only production dependencies, and copies only runtime files', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^FROM node:24\.22\.1-bookworm-slim$/m);
  assert.match(dockerfile, /RUN npm ci --omit=dev/);

  assert.match(dockerfile, /EDUTRACE_MODE=demo/);
  assert.doesNotMatch(dockerfile, /EDUTRACE_AUTH/);
  assert.match(dockerfile, /CMD \["npm", "start"\]/);

  const blueprint = read('render.yaml');
  assert.match(blueprint, /key: EDUTRACE_AUTH\s+value: hosted_demo/);
  assert.match(blueprint, /key: EDUTRACE_HOSTED_DEMO_PASSWORD_HASH\s+sync: false/);
  assert.match(blueprint, /minInstances: 1[\s\S]*maxInstances: 1/);

  assert.match(dockerfile, /COPY package\.json package-lock\.json/);
  assert.match(dockerfile, /COPY server\.js/);
  assert.match(dockerfile, /COPY public\//);
  assert.match(dockerfile, /COPY src\//);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s/);

  const ignore = read('.dockerignore');
  for (const excluded of ['**', '**/.env*', '**/key.txt', '**/users.json', 'data/', 'backups/', 'bench/', 'docs/', 'test/', 'test-support/', 'public/judge-entry.html', 'src/identity-benchmark.js', 'src/identity-baseline.js']) {
    assert.ok(ignore.split(/\r?\n/).includes(excluded), `${excluded} stays outside the image context`);
  }
  assert.match(ignore, /^!package\.json$/m);
  assert.match(ignore, /^!package-lock\.json$/m);
  assert.match(ignore, /^!server\.js$/m);
  assert.match(ignore, /^!public\/\*\*$/m);
  assert.match(ignore, /^!src\/\*\*$/m);
});

test('deployment documentation describes password setup, one-instance operation and hosted verification', () => {
  const doc = read('docs/RENDER_DEPLOYMENT.md');
  assert.match(doc, /shared password/);
  assert.match(doc, /EDUTRACE_HOSTED_DEMO_PASSWORD_HASH/);
  assert.match(doc, /Sessions and failed-login counters live in process memory/);
  assert.match(doc, /maximum at one/);
  assert.match(doc, /GET \/healthz/);
  assert.match(doc, /data_source: synthetic_in_memory/);
  assert.match(doc, /deployment requires a separate explicit approval/);
  assert.match(doc, /\.dockerignore/);
  assert.match(doc, /docker run --rm -e PORT=10000 -p 127\.0\.0\.1:10000:10000/);
  assert.match(doc, /without it, the application defaults to port 3000/);
  assert.doesNotMatch(doc, /Continue to Demo Login|Choose your workspace/);
});

test('password hash generator reads hidden input, confirms it, and never embeds or writes a credential', () => {
  const script = read('scripts/generate-hosted-demo-password-hash.js');
  assert.match(script, /setRawMode\(true\)/);
  assert.match(script, /first !== second/);
  assert.match(script, /hashPassword\(first\)/);
  assert.doesNotMatch(script, /writeFileSync|appendFileSync|HOSTED_DEMO_PASSWORD\s*=/);
});
