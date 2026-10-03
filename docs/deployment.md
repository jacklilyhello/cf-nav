# Deployment / 部署指南

[English](#english) · [简体中文](#简体中文) · [README](../README.md) · [中文 README](../README_zh.md)

## English

This guide documents the current implementation. Upstream is an existing, owner-managed installation, not a generic one-click installer. A new site needs its own resources and a reviewed adaptation of the repository's deployment targets.

### GitHub configuration and token permissions

In **Repository → Settings → Secrets and variables → Actions**, add:

| Location  | Name                    | Source                                                                   |
| --------- | ----------------------- | ------------------------------------------------------------------------ |
| Secrets   | `CLOUDFLARE_API_TOKEN`  | Cloudflare → My Profile → API Tokens → Create Token → Custom token       |
| Variables | `CLOUDFLARE_ACCOUNT_ID` | Target account details / domain Overview API section                     |
| Variables | `CLOUDFLARE_ZONE_ID`    | Target domain Overview API section → Zone ID                             |
| Variables | `CF_WORKER_NAME`        | Your production Worker name; upstream guard accepts `cf-nav`             |
| Variables | `CF_PRODUCTION_DOMAIN`  | Your hostname without scheme/path; upstream guard accepts `nav.lily.lat` |

Choose a dedicated API token, restrict it to the account/zone in use, and copy its secret directly into GitHub. Do not put the token in Wrangler configuration, screenshots or a committed environment file. Cloudflare's token secret is shown only once.

| Scope   | Permission                                                 | Applies to                                                          |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| Account | Workers Scripts Edit/Write                                 | Deploy, Worker settings/assets/schedules and Workers metadata reads |
| Account | D1 Edit/Write                                              | Creating databases, migrations, seed and remote SQL                 |
| Account | Account Settings Read                                      | Wrangler account/subdomain discovery                                |
| Account | Access: Apps and Policies Edit/Write                       | Resource provisioning of login apps/policies                        |
| Account | Access: Organizations, Identity Providers, and Groups Read | Resource inspection of the Zero Trust organization                  |
| Zone    | Workers Routes Edit/Write                                  | Route reads and custom-domain changes                               |
| Zone    | Zone Read                                                  | Zone discovery for domain operations                                |

Dashboard **Edit** and API **Write** labels refer to write access. Ordinary Worker updates need fewer capabilities than provisioning plus domain operations. This app has no R2/KV dependency. The scripts use Workers custom-domain APIs, not direct DNS-record editing; add DNS permissions only for a separate DNS-management task.

Primary references: [create a token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [permission list](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), [Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/), [create D1](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/), [Zero Trust organization](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/list/).

### Existing upstream installation

1. Run **CI** on the proposed change and review the PR. Preserve the existing D1 IDs, Access owner and `websitenavigation` rollback Worker.
2. If resource verification is needed, dispatch **Cloudflare Resources → inspect**. It is read-only, but still verifies the expected existing domain binding. Use `provision` only when the named resources need provisioning and the current binding/owner checks are satisfied.
3. Inspect the `cloudflare-resources` artifact. Provisioning does not commit its returned IDs into `wrangler.jsonc`; reconcile bindings explicitly if necessary. It creates databases/Access apps, not Worker deployments or custom-domain cutover.
4. Merge the accepted change to `main`. The **Deploy** push trigger deploys staging. Manual dispatch with `environment=staging` also works.
5. Check the staging browser: catalog, category/search filters, both themes and Auto, actual Access sign-in and intended admin operations.
6. From `main`, dispatch **Deploy → production**. The workflow repeats checks, applies production migrations, seeds only an empty unmarked database, deploys and smokes the production workers.dev host.
7. If the hostname already points at the production Worker, it now serves the new deployment. Otherwise, dispatch **Production Domain → production** from `main`, with acceptance checked, after verifying the matching source SHA. Inspect the before/after binding artifacts and the actual domain in a browser.

| Upstream workflow                  | Trigger / boundary                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| CI                                 | Push to `main` or `codex/**`, and pull requests                                                          |
| Deploy                             | Push to `main` or legacy `codex/cloudflare-navigation` deploys staging; production is manual from `main` |
| Cloudflare Resources               | Manual inspect/provision; assumes the expected old/current domain and an established owner Access app    |
| Production Domain                  | Manual from `main` with acceptance; verifies source version and current binding                          |
| Temporary probe acceptance fixture | Optional isolated fixture; not a prerequisite for deployment                                             |

Remote writes in the supplied scripts run through Actions. Local Cloudflare credentials used in the upstream engineering workflow are read-only. Resource IDs and team configuration are not secrets, but they identify an installation and must not be reused blindly.

### New site or fork

Keep deployment workflows disabled until the fork's configuration and targets are ready. Enabling Actions and pushing `main` with the upstream configuration can deploy to the wrong resources when the token has access to the same Cloudflare account.

#### 1. Choose isolated names

For a hostname such as `links.example.com`, choose your own production/staging Worker names and **two separate D1 databases**. For example: `my-nav`, `my-nav-staging`, `my-nav-db`, `my-nav-staging-db`. Account/zone variables must describe your resources. Do not copy the upstream D1 UUIDs or owner identity.

#### 2. Create the initial resources

The current **Cloudflare Resources** script cannot bootstrap an unrelated fresh account unchanged: it first requires a `nav.lily.lat` binding to `websitenavigation` or `cf-nav`, and then obtains the owner from an existing Access application. Its fallback Access application ID is also specific to upstream.

A manual initial resource route avoids those assumptions:

1. In Cloudflare **Storage & databases → D1**, create the two databases and record each UUID. This creates empty databases; migrations and the initial catalog are applied by Deploy later.
2. Configure your Cloudflare Zero Trust team and note its team domain, such as `your-team.cloudflareaccess.com`. In Workers settings, obtain/choose your account's workers.dev subdomain.
3. In **Zero Trust → Access → Applications**, create a self-hosted application for each login hostname: `my-nav-staging.<subdomain>.workers.dev/admin/login`, `my-nav.<subdomain>.workers.dev/admin/login`, and `links.example.com/admin/login`.
4. Each application allows only the **same exact owner email**, not an email domain, Everyone, Bypass or Service Auth. Match the single-owner model. Set HttpOnly and SameSite=Lax cookies and an appropriate session lifetime; upstream uses eight hours. Record each application's AUD.
5. Configure the Worker variables and database bindings below. A Worker is created by its first successful deployment; an Access application can be configured for its planned hostname beforehand.

The Worker authenticates `/admin` and every `/api/admin/*` request itself. The host-specific Access application protects `/admin/login`, which issues the identity token used by that validation; do not protect the whole public catalog accidentally.

#### 3. Update installation configuration

| File / field                                   | Required adaptation                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `wrangler.jsonc` → environment `name`          | Your production/staging Worker names                                                                                        |
| Environment D1 `database_name` / `database_id` | Your two database names and UUIDs; retain `binding: DB` and migration directory                                             |
| `ACCESS_TEAM_DOMAIN`                           | Your Zero Trust team domain                                                                                                 |
| `ACCESS_AUD`                                   | Staging app AUD for staging; custom-domain and production workers.dev AUDs, comma-separated, for production                 |
| `ADMIN_EMAIL_HASH`                             | SHA-256 of the normalized exact owner email; same owner in both environments                                                |
| `APP_ENV` / `PUBLIC_ORIGIN`                    | Keep staging/production values; set the intended canonical production HTTPS origin                                          |
| `.github/workflows/deploy.yml`                 | Adapt workers.dev smoke hostnames/subdomain, deploy targets as needed and the legacy push branch trigger                    |
| `scripts/cloudflare.mjs`                       | If retaining provisioning, adapt fixed hostnames, names, binding checks and the established-owner lookup; it is not generic |
| `scripts/cutover.mjs`                          | Adapt hostname/Worker guards, health URL, accepted previous owner and rollback Worker for your installation                 |
| Domain workflow and variables                  | Reconcile `CF_WORKER_NAME` / `CF_PRODUCTION_DOMAIN` with the adapted domain script                                          |
| Branding, defaults and README demo links       | Review frontend title/branding and `src/api/settings.ts` default probe User-Agent if publishing your own branded site       |

Retain `global_fetch_strictly_public`, signature/audience/owner verification, CSRF checks and environment isolation. Replace safety checks with checks for your installation instead of deleting them.

Generate the owner hash locally using your intended login email; this placeholder must be replaced:

```sh
node --input-type=module -e "import { createHash } from 'node:crypto'; console.log(createHash('sha256').update('owner@example.com'.trim().toLowerCase()).digest('hex'))"
```

The hash is configuration, not a password. It must match the email actually returned by Access. No shared administrator credentials are provided.

#### 4. Prepare the starter catalog

`data/seed.json` contains the audited upstream starter catalog, not a live export of nav.lily.lat. If you want your own starter content, edit it before the first seed. The seed builder requires version 1, nonempty categories and links, unique IDs/slugs/URLs, valid category references, and bounded counts. Preserve its schema; do not replace it with an empty or malformed object.

After first seeding, use the administrator workspace to remove unwanted entries and maintain your collection. Redeployments detect the `seed-imported` marker and preserve edits. An unmarked nonempty database is rejected: investigate or back it up rather than forcing a reseed. Do not publish exports containing private notes.

#### 5. Deploy, verify and attach your hostname

1. Configure the GitHub Secret/Variables, enable the adapted workflows and run CI.
2. Dispatch **Deploy → staging**. Review migrations, first-use seed, deployment and the smoke target. Verify public behavior and the real Access login on the staging hostname.
3. Merge your installation adaptation to `main`, then dispatch **Deploy → production**. Verify its workers.dev output and source SHA before attaching the custom hostname.
4. For a fresh site, use Cloudflare **Workers & Pages → your production Worker → Settings → Domains & Routes → Add → Custom Domain** to attach your hostname. Resolve an existing DNS conflict deliberately; do not overwrite another service's binding blindly. This dashboard route does not require the upstream cutover script's existing legacy binding.
5. Verify the custom hostname, canonical origin, robots/sitemap, assets and its separate Access login. Keep staging noindex. Use an adapted domain workflow later only after its ownership/rollback checks are designed for your site.

This documentation change does not implement a generic fork installer. A new-site provisioning run was not performed as part of the documentation task.

### Recovery

Before bulk edits, keep an administrator JSON backup; it includes private notes. For application rollback, deploy a compatible known revision through the existing production workflow. For the upstream hostname rollback, **Production Domain → rollback** rebinds to the preserved `websitenavigation` Worker. That operation changes traffic routing; it does not restore D1 data.

Do not delete/recreate a production database to fix a failed release. Consult [operations](operations.md) for D1 recovery, import limits, migration compatibility and health-setting rollback constraints.

## 简体中文

本文说明当前实现。上游是已经运行的单管理员站点，并非通用的一键安装器。部署新站需要自己的资源，以及经过核对的仓库部署目标适配。

### GitHub 配置与 Token 权限

打开**仓库 → Settings → Secrets and variables → Actions**：

| 位置      | 名称                    | 来源                                                               |
| --------- | ----------------------- | ------------------------------------------------------------------ |
| Secrets   | `CLOUDFLARE_API_TOKEN`  | Cloudflare → My Profile → API Tokens → Create Token → 自定义 Token |
| Variables | `CLOUDFLARE_ACCOUNT_ID` | 目标账号详情 / 域名 Overview 的 API 区域                           |
| Variables | `CLOUDFLARE_ZONE_ID`    | 目标域名 Overview 的 API 区域 → Zone ID                            |
| Variables | `CF_WORKER_NAME`        | 生产 Worker 名；上游保护要求为 `cf-nav`                            |
| Variables | `CF_PRODUCTION_DOMAIN`  | 无协议和路径的域名；上游保护要求为 `nav.lily.lat`                  |

使用专用 Token，仅授权目标账号和 Zone，直接复制到 GitHub。不要写入 Wrangler 配置、截图或提交环境文件；Token 的值只显示一次。

| 范围    | 权限                                                       | 对应操作                                      |
| ------- | ---------------------------------------------------------- | --------------------------------------------- |
| Account | Workers Scripts Edit/Write                                 | 部署、设置、静态资源、Cron 和 Worker 信息读取 |
| Account | D1 Edit/Write                                              | 创建数据库、迁移、seed 和远程 SQL             |
| Account | Account Settings Read                                      | Wrangler 账号/子域名查询                      |
| Account | Access: Apps and Policies Edit/Write                       | 初始化登录应用与策略                          |
| Account | Access: Organizations, Identity Providers, and Groups Read | 资源检查读取 Zero Trust 组织                  |
| Zone    | Workers Routes Edit/Write                                  | 路由读取和自定义域名操作                      |
| Zone    | Zone Read                                                  | 域名操作需要的区域查询                        |

控制台的 **Edit** 与 API 的 **Write** 均指写权限。普通 Worker 更新所需能力少于资源初始化加域名操作。没有 R2/KV 依赖；仓库脚本调用 Workers 自定义域名接口，不直接编辑 DNS 记录。单独管理 DNS 时再考虑所需权限。

官方依据：[创建 Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)、[权限列表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)、[Workers 授权](https://developers.cloudflare.com/workers/authorization/workers/)、[创建 D1](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/)、[Zero Trust 组织](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/list/)。

### 更新现有上游站点

1. 先让修改通过 **CI** 并审查 PR，保留已有 D1 ID、Access 管理员和用于回退的 `websitenavigation`。
2. 需要核对资源时运行 **Cloudflare Resources → inspect**。它只读，但仍要求符合预期的旧/当前域名绑定。仅在资源需要初始化且绑定/管理员检查满足时使用 `provision`。
3. 检查 `cloudflare-resources` 附件。初始化返回的 ID 不会自动提交到 `wrangler.jsonc`；必要时人工核对绑定。它创建数据库和 Access 应用，不部署 Worker，也不切换域名。
4. 合并到 `main` 后，**Deploy** 自动发布测试环境；也可手动选择 `staging`。
5. 浏览测试站，验收分类、搜索、浅色/深色/自动主题，以及真实 Access 登录后的相关后台操作。
6. 从 `main` 手动运行 **Deploy → production**。重新检查、迁移生产 D1，仅在空且无标记时导入 seed，随后部署并检查生产 workers.dev。
7. 域名已绑定生产 Worker 时，立即提供新部署代码；否则确认源码 SHA 一致后，从 `main` 运行 **Production Domain → production** 并勾选验收。检查前后绑定附件和真实域名浏览器输出。

| 工作流                             | 触发与边界                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| CI                                 | `main` / `codex/**` 推送及 PR                                                      |
| Deploy                             | `main` 和旧 `codex/cloudflare-navigation` 推送发布测试；生产只能从 `main` 手动发布 |
| Cloudflare Resources               | 手动 inspect/provision，假设已有预期域名和管理员 Access 应用                       |
| Production Domain                  | 从 `main` 手动勾选验收，检查源码版本与现有绑定                                     |
| Temporary probe acceptance fixture | 可选的隔离验收工具，不是部署前置步骤                                               |

仓库远程写操作通过 Actions；上游工程流程中的本地 Cloudflare Token 只读。资源 ID 与团队配置不是密码，但标识具体安装，不能随意复用。

### 新站或 Fork 首次部署

在配置和目标准备好之前，保持 Fork 部署工作流关闭。若 Token 能访问同一 Cloudflare 账号，带上游配置推送 `main` 可能部署到错误的资源。

#### 1. 选择独立名称

例如部署到 `links.example.com`，可使用 `my-nav`、`my-nav-staging` 两个 Worker，以及 `my-nav-db`、`my-nav-staging-db` **两个独立 D1**。账号/Zone Variables 必须属于你的目标资源；不要复制上游 D1 UUID 或管理员身份。

#### 2. 手动建立初始资源

当前 **Cloudflare Resources** 无法原样初始化不相关新账号：它先要求 `nav.lily.lat` 绑定 `websitenavigation` 或 `cf-nav`，再从已有 Access 应用获取管理员，备用 Access 应用 ID 也属于原站。

可以使用以下手动路线：

1. Cloudflare **Storage & databases → D1** 创建两个数据库，记录各自 UUID。此时为空库，结构迁移和初始目录之后由 Deploy 应用。
2. 配置 Zero Trust 团队，记录团队域名，例如 `your-team.cloudflareaccess.com`。从 Workers 设置确认/选择账号的 workers.dev 子域名。
3. **Zero Trust → Access → Applications** 分别创建三个 self-hosted 应用：`my-nav-staging.<subdomain>.workers.dev/admin/login`、`my-nav.<subdomain>.workers.dev/admin/login`、`links.example.com/admin/login`。
4. 三个应用都只允许**同一个精确管理员邮箱**，不要使用邮箱域、Everyone、Bypass 或 Service Auth。配置 HttpOnly、SameSite=Lax 和合适的会话期限；上游使用八小时。记录三个 AUD。
5. 按下表填写 Worker Variables 和数据库绑定。首次成功部署会创建 Worker；Access 应用可以预先使用规划好的域名。

Worker 自己验证 `/admin` 及所有 `/api/admin/*`；Access 应用保护 `/admin/login` 并提供验证使用的身份 Token，避免误将整个公开目录设为私有。

#### 3. 替换安装配置

| 文件 / 字段                        | 需要修改                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `wrangler.jsonc` 各环境的 `name`   | 你的测试/生产 Worker 名称                                                   |
| D1 `database_name` / `database_id` | 两个数据库名与 UUID，保留 `binding: DB` 和迁移目录                          |
| `ACCESS_TEAM_DOMAIN`               | 自己的 Zero Trust 团队域名                                                  |
| `ACCESS_AUD`                       | 测试填写测试 AUD；生产填写正式域名与生产 workers.dev 的 AUD，英文逗号分隔   |
| `ADMIN_EMAIL_HASH`                 | 标准化后精确邮箱的 SHA-256；两个环境为同一管理员                            |
| `APP_ENV` / `PUBLIC_ORIGIN`        | 保留 staging/production 区分，origin 改为正式 HTTPS 地址                    |
| `.github/workflows/deploy.yml`     | workers.dev 冒烟地址/子域名、必要的部署目标和旧分支触发规则                 |
| `scripts/cloudflare.mjs`           | 保留初始化功能时，适配固定域名、名称、绑定检查和已有管理员查找              |
| `scripts/cutover.mjs`              | 适配域名/Worker 校验、健康地址、允许的旧绑定和回退 Worker                   |
| 域名工作流与 Variables             | 与适配后脚本统一 `CF_WORKER_NAME` / `CF_PRODUCTION_DOMAIN`                  |
| 品牌、默认值和 README 示例         | 发布自有品牌时检查标题/前端品牌及 `src/api/settings.ts` 默认探测 User-Agent |

保留 `global_fetch_strictly_public`、签名/AUD/管理员验证、CSRF 和环境隔离。把保护校验改为自己的目标，避免直接删除。

用计划登录的邮箱在本地计算哈希，下方占位邮箱必须替换：

```sh
node --input-type=module -e "import { createHash } from 'node:crypto'; console.log(createHash('sha256').update('owner@example.com'.trim().toLowerCase()).digest('hex'))"
```

哈希是配置，不是密码，必须对应 Access 实际返回的邮箱。项目不提供共用管理员凭据。

#### 4. 准备初始目录

`data/seed.json` 是审核后的上游初始目录，不是 nav.lily.lat 当前内容的导出。需要自己的初始内容时，在首次 seed 前修改。要求 version 1、非空分类和链接、唯一 ID/slug/URL、有效分类关联和受限数量；不要换成空对象或错误结构。

首次导入后，用后台移除不需要的条目并维护收藏。后续部署识别 `seed-imported` 标记并保留修改；无标记但已有内容时拒绝覆盖，应先调查或备份。不要公开包含私有备注的导出。

#### 5. 部署、验收和绑定新域名

1. 填写 GitHub Secret/Variables，启用适配后的工作流，运行 CI。
2. 手动运行 **Deploy → staging**，检查迁移、首次 seed、部署和冒烟地址，并使用真实 Access 登录验收。
3. 把安装适配合并到 `main`，运行 **Deploy → production**。绑定域名前确认生产 workers.dev 输出和源码 SHA。
4. 新站可通过 Cloudflare **Workers & Pages → 生产 Worker → Settings → Domains & Routes → Add → Custom Domain** 绑定自己的域名。发现已有 DNS 冲突时明确处理，不要盲目覆盖其他服务。此路线不依赖上游切换脚本的旧绑定。
5. 验证正式域名、canonical origin、robots/sitemap、静态资源和独立 Access 登录，测试站继续 noindex。之后只有完成归属/回退校验适配，才使用域名工作流。

本次文档修改没有实现通用 Fork 安装器，也没有实际为新账号执行初始化。

### 恢复与回退

批量编辑前导出后台 JSON，其中包含私有备注。应用回退通过生产工作流部署兼容旧版本；上游域名回退通过 **Production Domain → rollback** 重新绑定保留的 `websitenavigation`。域名回退改变流量目标，不会恢复 D1 数据。

不要为了修复发布删除或重建生产数据库。D1 恢复、导入限制、迁移兼容性及健康参数回退要求见[运维文档](operations.md)。
