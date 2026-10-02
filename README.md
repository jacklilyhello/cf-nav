# Lily · 寻迹 / cf-nav

An owner-managed Cloudflare navigation system: a quiet, responsive catalog with structured
content, a single-administrator workspace and conservative active link-health checks.

- Website: <https://nav.lily.lat/>
- Staging: <https://cf-nav-staging.lilyya.workers.dev/>
- Administrator: <https://nav.lily.lat/admin>

## Stack

TypeScript + Vite, Cloudflare Workers Static Assets, D1, Cron Triggers and Cloudflare Access.
No VPS, registration, third-party analytics or legacy navigation template.

## Development

```sh
npm ci
npm run build
npm run db:local
npm run seed:local
npm run dev
```

Use Node.js 22.22+ and npm. `npm run check` runs lint, both TypeScript targets, unit/integration
tests and the frontend build. Real Access authentication stays enabled in deployed environments.

## Repository

| Path                 | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `src/frontend/`      | Public catalog, search, categories and responsive design          |
| `src/admin/`         | Single-owner content and health management                        |
| `src/api/`           | Authenticated CRUD, validation, CSRF, export/import               |
| `src/health/`        | Public URL validation, bounded probes and evidence classification |
| `src/worker/`        | Routing, security headers and Cron scheduling                     |
| `migrations/`        | Versioned D1 schema                                               |
| `data/`              | Legacy extraction, audit decisions and curated initial catalog    |
| `scripts/`           | Audit, deployment, seeding and smoke tools                        |
| `.github/workflows/` | CI, resource setup, deployment and reversible domain binding      |
| `tests/`             | Security, probe behavior and D1 integration tests                 |

See [architecture](docs/architecture.md), [operations and rollback](docs/operations.md), and
[project instructions](CODEX.md). Deployment credentials remain in GitHub Secrets. Staging and
production use separate D1 databases; the initial seed never overwrites later administrator edits.

## Navigation controls

Administrator → **站点设置** controls search indexing and the probe User-Agent, interval and
per-site deadline. Production uses the configured `PUBLIC_ORIGIN` for its canonical URL;
staging and alternate hostnames remain noindex. Navigation editing supports automatic site
icons, manual HTTPS/text overrides and maintained expected titles, keywords and purposes.
The health view combines HTTP status, redirect chain, content similarity and recent execution
settings. See operations for defaults, limits and interpretation.

## Appearance

The public catalog and administrator workspace offer **自动 / 浅色 / 深色** from the header,
including on mobile. Auto follows the device's `prefers-color-scheme` and updates when it
changes. A manual choice is stored locally and survives reloads; choosing Auto returns control
to the device. Light uses warm mist, pale jade and ivory surfaces; Dark retains the ink and
muted teal palette. The theme is resolved before the application stylesheet is painted.
