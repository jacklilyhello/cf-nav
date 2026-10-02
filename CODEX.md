# cf-nav project context

## Scope and ownership

cf-nav is Lily's Cloudflare-native navigation system. Repository:
<https://github.com/jacklilyhello/cf-nav>. Production hostname: `nav.lily.lat`.

The owner's 2026-10-02 request explicitly superseded bootstrap-only restrictions and authorized
full investigation, old-link audit/cleanup, development, resource creation through Actions,
staging acceptance and production cutover after successful tests and browser checks.
This does not grant future unrelated production changes. Respect the current user's scope.

Legacy Worker `websitenavigation` must remain unchanged and undeleted as the rollback target.
Do not alter unrelated account resources. Local Cloudflare token is READ ONLY. Remote writes
must use GitHub Actions with existing `CLOUDFLARE_API_TOKEN` and repository variables. Never
print credentials, cookies, JWTs, email addresses or private data in logs or commits.

## Architecture

TypeScript + Vite frontend; Workers Static Assets; Worker JSON APIs; isolated staging/production
D1 databases; Cloudflare Access single administrator; bounded Cron checks. See
[architecture](docs/architecture.md) and [operations](docs/operations.md).

- Public-only fetch compatibility flag `global_fetch_strictly_public` is mandatory.
- Do not add private VPC or origin/service fetch paths to health probes.
- D1 migrations belong in `migrations/`. Never recreate a production database to fix a bug.
- Initial seed is a one-time bootstrap. Preserve all subsequent admin changes.
- Public catalog must omit private notes and expose only enabled links/categories.
- Every admin API verifies Access JWT signature, issuer, audience, expiry and exact owner.
- Mutations require same-origin CSRF protection; bound SQL and validated URLs are mandatory.
- Health is evidence-based. 200 is not automatically healthy; WAF/403/429 are not dead.
- No failed check automatically deletes or permanently hides a resource.

## Engineering workflow

Read requirements and current code before editing. Inspect branch, remote and status. Use
focused commits and review staged diffs for secrets, security and correctness. Do not overwrite
user changes, rewrite history, or force-push. Use `codex/` branches and reviewable PRs.

Run `npm run check`, appropriate D1 integration checks and `npm audit --omit=dev` before release.
CI and deployment success do not replace browser acceptance. Check public search/category/links,
authentication, real admin CRUD persistence, health, responsive sizes, 404s and resource errors.
Fix ordinary failures autonomously within the authorized scope.

Production release is explicit from main. Domain cutover is a separate guarded workflow.
Record the previous binding, preserve the old Worker and independently inspect domain readback,
HTTP and actual browser output. Use rollback if a severe production regression cannot be fixed
promptly. Never weaken authentication, CSP, WAF or SSRF protection to make a test pass.

## Documentation and audit data

`data/` intentionally tracks legacy navigation inventory, public-site probe evidence, editorial
cleanup and initial catalog. Keep each decision traceable; retain uncertainties as review items.
This is product data, not an AI work log. Do not commit page source containing secrets or private
owner information. Avoid carrying template author attribution, advertising or referral links
into the public catalog.

Update README and operations for actual implementation. Verification reports, security review,
work logs and final summaries belong in PR descriptions/comments, never `codex_log.md` or a
replacement repository work-log file. Do not broadly clean `.wrangler/`; it holds local data.
