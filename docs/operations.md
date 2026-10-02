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

## Indexing, icons and probe settings

Open **站点设置** in the administrator menu. `allowIndexing` is persisted in D1 and read on
requests without a stale settings cache. On the configured production `PUBLIC_ORIGIN`, the
switch controls `X-Robots-Tag`, server-rendered robots meta, sitemap contents and the sitemap
reference in robots.txt. Canonical points to the configured production origin. Staging and
workers.dev alternatives always remain noindex; administrator/API/error responses are noindex.
The public homepage includes a no-JavaScript catalog fallback. Only the real homepage is listed
in the sitemap; category filters and external destinations are not invented local pages.

When indexing is off, robots.txt still permits the public page to be crawled so crawlers can
read `noindex`; a blanket Disallow would prevent that. Search engines act after their next crawl,
not immediately when Save is clicked. See [Google's noindex documentation](https://developers.google.com/search/docs/crawling-indexing/block-indexing).

New links default to automatic icon discovery: bounded HTTPS apple-touch/icon declarations,
manifest icons, then favicon.ico. Candidates must actually return an image with a matching MIME
and signature. The request budget is 20 including DNS, the deadline 8 seconds, metadata 128 KiB,
manifest 32 KiB and images 256 KiB. URLs are persisted in D1; image bytes are served by their
owners with no referrer. Automatic discovery runs on creation, URL/mode changes or explicit
refresh, not on every visitor request or health check. Failed discovery/load renders the local
initial fallback. Select manual mode to enter an HTTPS image URL or up to 16 text characters;
manual and fallback-only choices are never overwritten by health or icon discovery.

Migration 0002 preserves existing icons as manual except exact bootstrap placeholders whose
ID/URL/icon and original seed timestamp still match and have no import/edit evidence. Those
untouched placeholders become automatic. **补齐自动图标** processes only automatic links without
a prior discovery timestamp, sequentially; stop is supported between requests. Imported automatic
icons are preserved as editable data and can be explicitly refreshed. No image upload/storage
service is added; manual URLs and text provide the supported override workflow.

Probe defaults and accepted limits:

| Setting          | Default                                      | Accepted range                   |
| ---------------- | -------------------------------------------- | -------------------------------- |
| User-Agent       | `cf-nav-health/1.0 (+https://nav.lily.lat/)` | 3–256 printable ASCII characters |
| Request interval | 2 seconds                                    | 1–10 whole seconds               |
| Per-site timeout | 12 seconds                                   | 2–20 whole seconds               |

Manual and Cron checks share the same settings and a global D1 execution lease. At most three
links are processed sequentially per Cron tick, never a concurrent sweep. The interval applies
between target requests including redirects and across runs; initial pacing occurs before the
per-site deadline. That deadline covers DNS, headers, body and redirect waits. A long interval
can exhaust the deadline during a redirect chain; the measured result is Timeout, not healthy.
The history panel records the actual configured UA, interval and timeout used by each run.

Edit a link's expected title, keywords and purpose to maintain its identity baseline. A successful
HTTP response alone is insufficient. A lightweight score combines expected identity in title/meta,
keyword coverage, visible content, purpose and the first confirmed title. Scores 80–100 are a
match, 45–79 partial, and lower scores indicate potential change; a clear baseline with score below
20 is a mismatch. Explicit domain-sale/parking pages are mismatches; blocked, challenged, non-HTML
or insufficient evidence is unknown. This is a heuristic score, not a calibrated probability.
Human baselines are never rewritten by probes. Explicitly adopting an observed title is an
administrator action. Editing baseline fields invalidates old current observations and schedules
a new check while retaining history. Export/import includes the editable baseline and icon mode;
site-wide settings remain separate and imports do not change them.

## Upgrade and rollback

Migration 0002 only adds columns and converts guarded original icon placeholders; it does not
remove records, clear D1, reseed the catalog or change Access. The previous application remains
compatible with the added columns. Keep the release SHA in Actions and deploy a known compatible
revision through the existing production workflow if application rollback is needed. Do not reverse
schema by deleting data. The legacy Worker/domain rollback remains a separate option above.

## Isolated probe acceptance fixture

`Temporary probe acceptance fixture` deploys or removes only `cf-nav-acceptance`. It is a
separate temporary Worker with no application bindings, database, production routes or request
logging. Its fixed test responses let an administrator verify automatic icons, received UA,
redirect interval, a five-second delay and a replaced/parked page using ordinary navigation CRUD.
Run the remove action after acceptance and soft-delete the temporary navigation records. Never
use the fixture workflow to change the production Worker or database.
