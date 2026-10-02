# Architecture

cf-nav is an owner-managed navigation catalog. One Cloudflare Worker serves a Vite-built
TypeScript interface and JSON APIs; D1 stores categories, links, probe history and operational
metadata. A single administrator edits content. Anonymous visitors can read enabled entries.

## Deliberately small platform footprint

- Workers Static Assets: fingerprinted JavaScript/CSS and local SVG branding.
- D1: two isolated databases, `cf-nav-staging-db` and `cf-nav-db`.
- Cron: every ten minutes, at most three due links. The catalog is never automatically
  deleted or hidden because of a failed check.
- Cloudflare Access: existing owner identity, no additional application password.
- No KV, R2, Queue, Durable Object, VPS or persistent server is required.

The public API returns only enabled entries in enabled categories. Private notes and probe
analysis stay in the administrator API. Every database value is bound as a parameter;
SQL identifiers come exclusively from fixed internal field lists.

## Authentication and request boundaries

`/admin` serves the administration interface. `/admin/login` is protected by an Access
application covering the staging workers.dev, production workers.dev and production custom
domain. Access supplies an HttpOnly, SameSite=Lax application cookie. The Worker verifies
RS256 signatures against the configured team's JWKS, issuer, audience, expiry, application
type and SHA-256 of the exact existing administrator email. The email hash is configuration,
not an authentication credential. Other identities and unsigned headers fail closed.

Every `/api/admin/*` route authenticates independently, including export and session.
Mutations require a same-origin Origin header and a CSRF token derived from the authenticated
application token. No CORS permission is granted. D1 rate limits bound writes and per-link
manual checks. JSON bodies are streamed with byte limits. Errors omit internal details.
Security headers cover Worker and asset responses; scripts, styles and connections are
same-origin. Remote HTTPS site icons may be shown by the browser with no referrer.

## Health checking and SSRF

`src/health/` validates HTTP(S) URLs, rejects userinfo, unusual ports, local/reserved IPs,
metadata names and parser edge cases. Every redirect is handled manually and revalidated.
A/AAAA DNS answers are checked before each distinct host. All requests have bounded redirects,
a shared deadline, a maximum response-body size and no forwarded cookies or authorization.

DNS prechecking alone does **not** prevent rebinding. The deployment security boundary is
Cloudflare's global public-only fetch transport. `global_fetch_strictly_public` is mandatory;
VPC and internal-service bindings must not be added to the probe transport. Local tests inject
network stubs and are not proof that an arbitrary Node fetch is safe for untrusted targets.

HTTP status is only one signal. Title, metadata, original name/keywords, redirects, parking
and sale text, challenges and previous verified identity inform conservative classifications.
Uncertain identity is `needs_review`; a WAF response is not a dead site. Admin overrides affect
display while the raw measured status remains available. Ignored checks remain configurable.

Healthy links are checked daily. Transient failures use exponential backoff; bot restrictions
are checked less frequently. Probe leases avoid simultaneous Cron/manual work. Every link edit
invalidates in-flight results and their history insertion. A destination or identity-keyword
change clears stale observations. The last confirmed title is stored separately from the latest
observed title, so a challenge page cannot replace the identity baseline. D1 retains 90 days of health history
and 180 days of content mutation events, without request cookies, IP addresses or identities.

## Data lifecycle

Migrations are versioned SQL. Initial audited seed data is imported once, using a D1 metadata
marker. Later deployments never overwrite administrator edits with the repository seed.
JSON exports are versioned. JSON import is validated, bounded and merged transactionally.
`json_each` imports up to 1,000 links and 100 categories in three writes, within the JSON body
limit, without one D1 query per item. Imported observations are not trusted as fresh health
evidence; existing observations survive only when the destination and service identity match.
Navigation URL fragments are preserved for single-page applications, while probes omit them.
Navigation/category deletion is soft deletion; restore and backup import retain recovery paths.
Category deletion is rejected while it contains active links.

## Sources and design references

- [Workers Static Assets routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 JSON queries](https://developers.cloudflare.com/d1/sql-api/query-json/)
- [Workers Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Public-only global fetch](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)
- [Workers environment and SSRF boundaries](https://blog.cloudflare.com/workers-environment-live-object-bindings/)
- [Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

The interface uses the supplied palette: ink `#0B0F14`, dark blue `#1F2A3A`, muted blue
`#3A506B`, fog `#A7B4C2`, off-white `#EDEBE6`, teal `#2F6F73` / `#7FC0C6`, and restrained
sand `#D9C19A`. It is a modern navigation workspace with subtle landscape forms, not a
continuation of the legacy template.
