# EduTrace public demo on Render

This Blueprint configures one hosted read-only Demo Mode behind a shared password. After login, every visitor uses the same fixed `hosted_demo_viewer` identity with only `records.read`. Data is synthetic and in memory. Registration, account creation, AI, integrations, exports, audit history, and data changes are unavailable.

## Required service configuration

[`render.yaml`](../render.yaml) defines one Docker web service. [`Dockerfile`](../Dockerfile) pins Node 24.22.1, installs production dependencies with `npm ci --omit=dev`, and starts the existing `npm start` command. The process binds to `0.0.0.0:$PORT` in hosted Demo Mode. Render requires this host/port contract ([web services](https://render.com/docs/web-services)).

The required environment is:

| Variable | Value | Configuration |
| --- | --- | --- |
| `NODE_ENV` | `production` | Blueprint value. |
| `EDUTRACE_MODE` | `demo` | Blueprint value. |
| `EDUTRACE_AUTH` | `hosted_demo` | Blueprint value. |
| `EDUTRACE_HOSTED_DEMO_PASSWORD_HASH` | Scrypt hash | Required secret; enter it in Render's environment settings when prompted. Never add the hash or password to YAML, source, logs, or repository files. |
| `PORT` | Supplied by Render | Do not set a fixed application port in Render. |

Generate a hash locally in an interactive terminal. The script hides both password entries, requires at least 20 characters, prints only the scrypt hash, and does not save either value:

```powershell
node scripts/generate-hosted-demo-password-hash.js
```

Set the printed hash as the secret value for `EDUTRACE_HOSTED_DEMO_PASSWORD_HASH`. Distribute the original password separately to intended demo visitors. Startup fails if the hash is absent or malformed. Startup and request logs never print the password or hash.

Do not set database, account-store, AI-provider, or integration variables. Hosted startup rejects incompatible storage, account, AI, integration, and auth settings. Runtime data uses the synthetic in-memory store; the AI provider receives an empty environment and is disabled.

## Single-instance requirement

Sessions and failed-login counters live in process memory. The Blueprint fixes autoscaling to a minimum and maximum of one instance. This Render autoscaling configuration requires a plan that supports autoscaling; use a plan that supports this configuration and keep the maximum at one. Do not manually scale the service, enable a higher maximum, or deploy it behind multiple application processes. If Render cannot apply the one-instance cap, do not deploy this configuration. Render's [scaling documentation](https://render.com/docs/scaling) describes plan requirements and load balancing across scaled instances.

The failed-login limit allows five incorrect passwords per observed client address in a rolling 15-minute window. The counter is process-local: a restart clears it, and it cannot coordinate across instances. Requests behind a reverse proxy can share the same socket peer address and therefore share a limit; the service deliberately does not trust a client-supplied forwarding header as the rate-limit identity. This limit slows repeated attempts but is not a distributed abuse-control system.

Sessions use random 256-bit identifiers held only in that same process, with 30-minute idle and 8-hour absolute expiry. The cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` in hosted deployments. Authenticated logout requires the session CSRF token and removes the in-memory session. A restart invalidates all existing sessions.

## Public and protected endpoints

- `GET /healthz` is public and returns only `{"status":"ok"}` without reading application data or configuration.
- `GET /api/v1/runtime` is public because the browser needs the fixed login configuration. In hosted mode it returns only `mode: demo`, `read_only: true`, `registration_enabled: false`, `data_source: synthetic_in_memory`, `auth: hosted_demo`, and `ai_enabled: false`; it omits the dataset fingerprint and other runtime details.
- `POST /api/v1/auth/login` and `GET /api/v1/auth/session` are public. Login accepts only a password, returns a generic failure, and sets the session cookie on success.
- All other API routes require a valid hosted session before authorization and data access. `/api/v1/institutions` also requires authentication.
- The hosted role grants only `records.read`. The server rejects writes before reading their bodies or loading data. Login and authenticated logout are the only POST exceptions; account registration remains unavailable.

## Release contents

Render builds from the Docker context, so `.gitignore` is not a release filter. [`.dockerignore`](../.dockerignore) excludes environment files, keys, user stores, local data and backups, tests, local tooling, benchmark results, holdout/evaluation code, and internal documentation. The Dockerfile copies only package manifests, `server.js`, `public/`, and `src/`; it does not use `COPY . .`. These exclusions do not delete local files.

## Setup and verification

1. Review the single web service in the Blueprint and provide the password-hash secret in Render's environment settings. Keep the single-instance autoscaling cap at one.
2. Ensure only `EDUTRACE_MODE=demo` and `EDUTRACE_AUTH=hosted_demo` select the hosted mode. Keep account, database, model, and integration settings unset.
3. After an approved deployment, verify `GET /healthz` returns 200 and `GET /api/v1/runtime` returns the minimal hosted configuration.
4. Without a cookie, `GET /api/v1/dashboard/summary`, `/api/v1/records`, `/api/v1/institutions`, and other protected API routes must return 401. A wrong password returns 401; the sixth failed attempt within the window returns 429.
5. After login, verify the session can read the dashboard and synthetic records. A POST to `/api/v1/demo/reset` remains 403. Registration remains unavailable, audit and export requests return 403, and AI remains disabled.
6. Sign out, then verify the session endpoint reports unauthenticated and protected reads return 401. Do not deploy from this task; deployment requires a separate explicit approval.

For a local image check after Docker is available, run `docker build -t edutrace-demo .` and pass a matching container port explicitly: `docker run --rm -e PORT=10000 -p 127.0.0.1:10000:10000 edutrace-demo`. Render supplies `PORT` at runtime; without it, the application defaults to port 3000, so a local mapping to container port 10000 will not reach the listener. Supply the password-hash environment variable securely at run time. The image has no default password and intentionally fails startup when the required hash is missing. Never place a real password or hash in a command line, shell history, or repository file.
