# Operations

## Prerequisites

Node.js 22.22 or newer (22 LTS is used in CI), npm, and the repository's existing GitHub
Cloudflare deployment secret. Never place a token, password, private key or real `.env`
file in Git. Local Cloudflare credentials are read-only; remote mutations run through Actions.

## Local development

```sh
npm ci
npm run build
npm run db:local
npm run seed:local
npm run dev
```

Wrangler serves the application at its printed localhost address. Local D1 contents live in
`.wrangler/`; do not indiscriminately clean this directory. Local public browsing works without
Cloudflare credentials. Authentication remains enabled; use unit/integration tests for
administrator behavior locally and the real Access login in staging. There is no development
password or remote authentication bypass.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run check
npm audit --omit=dev
```

## Resource setup

`Cloudflare Resources` is manually dispatched with `inspect` or `provision`.
It reads existing bindings before creating only the two named cf-nav databases and the
three single-host, single-owner Access applications (staging, production domain and production
workers.dev). Separate applications avoid login callbacks depending on another environment.
It does not change the production custom domain. The production Worker accepts only its two
production application audiences; staging has a separate audience.
Resource IDs are in `wrangler.jsonc`, not a growing collection of GitHub variables.
The Actions artifact contains non-secret resource IDs and the previous domain binding.

Existing variables: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CF_WORKER_NAME`,
`CF_PRODUCTION_DOMAIN`. Existing secret: `CLOUDFLARE_API_TOKEN`.

## Deployment

`CI` runs install, lint, typecheck, unit/integration tests, build, dependency audit, Worker
bundle verification, local migrations and seed validation. `Deploy` repeats application checks,
applies the target environment's migrations, imports the seed only on first use, deploys the
Worker/assets and checks workers.dev health, source version, catalog, assets, authorization,
headers and 404 behavior.

Pushes to main deploy staging. Production is explicit dispatch from main. Production deployment
does not by itself move the custom domain. Validate staging in the browser before dispatching
production, and validate the production workers.dev build before the separate domain operation.

- Staging: <https://cf-nav-staging.lilyya.workers.dev/>
- Production Worker: <https://cf-nav.lilyya.workers.dev/>
- Production domain: <https://nav.lily.lat/>
- Administrator: append `/admin` to the appropriate origin.

## Administrator

Open `/admin`, follow Access login and use the already configured owner's identity.
Without a valid session, `/admin` and `/admin/` redirect to the fixed same-origin
`/admin/login` before loading the management application. Access and any browser security
verification therefore run as document navigations, not inside a JSON request.
If a session expires or Cloudflare returns an HTML challenge during use, follow the visible
login/reverification link. Failed requests are not treated as saved changes or automatically
replayed. Do not disable Access or WAF protection to resolve a login error.
The app has no registration. Manage categories, sort positions, enabled state, links,
descriptions, recommendation, icon, notes and health settings. A missing icon renders a
local initial tile. Search covers the name, domain, description and category.

A manual recheck is limited to once per link per minute. Inspect the measured status, HTTP code,
final URL, last check, failure count and error. A human override does not destroy the measured
status. Ignore checking only when intentional. Bot restrictions require review, not deletion.

## Backup and restore

Use administrator JSON Export before bulk edits and import its version-1 JSON to merge records
back by ID. Export includes private notes: treat it as owner data. Import does not execute SQL,
HTML or scripts. A changed destination is rechecked. Do not import an unreviewed third-party dump.

Each import is limited to 8 MiB, 1,000 links and 100 categories. This body limit keeps parsing
and validation within Worker memory limits; it does not promise that 1,000 records with every
field at its maximum length fit in one file. The administrator export interface splits larger
backups into downloadable parts, each retaining the complete `categories` array and original
IDs. Download every part and import them in order. A single file is applied atomically; separate
files are separate transactions. Export contains editable settings, not automatic health observations or history.

For full disaster recovery, use D1 Time Travel within the plan's retention period or an explicit
D1 SQL export. Perform remote exports/restores through an authorized Actions job and preserve
an export before restoration. Never point a staging restore at the production database.

The schema is in `migrations/`; apply migrations through `Deploy`, not ad hoc production SQL.
A rollback of application code must remain compatible with the already-applied schema.

## Custom-domain cutover and rollback

`Production Domain` is explicit dispatch on main. `production` requires the acceptance flag
and verifies that production workers.dev serves the same source SHA before changing only
`nav.lily.lat` to `cf-nav`. It checks the current binding and refuses an unexpected owner or
conflicting navigation route. Before/after records are retained as Actions artifacts.

The historical custom-domain service is `websitenavigation`, environment `production`, zone
`9c2a663ae602ff4ac1a73e97a98f2bf1`. The legacy Worker is preserved unchanged. To roll back,
dispatch `Production Domain` with `rollback` and the acceptance flag; it rebinds this hostname
to the old Worker. It does not delete cf-nav data. Check actual browser output after either
operation; a successful API or workflow alone is not acceptance.

## Monitoring and known detection limits

`/api/health` reports Worker identity, source version, environment and last successful Cron batch.
Investigate an old Cron timestamp using Workers logs and schedules. Use D1 health history to
review repeated failures. Provider WAFs, geographic restrictions and JavaScript-only pages may
remain uncertain; the system never equates a 200 response with proof of the original service.
A proxy/network-level access block can make command-line smoke differ from browser behavior;
inspect real evidence without weakening site protection.
