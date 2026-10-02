# cf-nav — 长期项目说明

本文件是以后所有本地 Codex 任务的项目上下文与工作边界。开始任务时先阅读本文件，并遵守用户当前指令。这里记录的未来目标不代表已经授权开始开发或执行生产操作。

## 当前阶段：Initialization / Bootstrap

当前仅完成仓库初始化：目录骨架、项目文档、通用基础配置和 GitHub Actions 初始化检查。

- 新 cf-nav 的正式业务实现尚未开始，技术栈尚未确定。
- 本阶段不实现前端、Worker、后台、API、数据库、SQL migration 或链接检测。
- 不创建 React、Vue、Svelte、Vite、Hono 或其他正式应用；不运行 create-cloudflare，不安装完整技术栈或大量依赖。
- 不创建 D1、KV、R2、Cron 或 Worker；不部署 workers.dev 或生产站点。
- 不抓取旧站全部链接，不开始链接审计或 UI 设计。
- 不创建 wrangler 生产配置，不验证或使用 Cloudflare Token。
- 初始化文件检查完成后，以正常工程粒度提交并 push main，核实 GitHub 仓库与工作流识别情况，然后立即停止，等待用户下一步开发指令。
- 后续只有收到用户明确的新阶段指令，才能开始对应开发；不能以“顺便完成”为理由扩大任务范围。

## 项目定位

- 项目名称：`cf-nav`。
- GitHub：<https://github.com/jacklilyhello/cf-nav>。
- 本地目录：`/Users/bao/Desktop/codex.nosync/cf-nav`。
- 默认分支：`main`。
- 目标：重新制作一套完全属于站点所有者的 Cloudflare Native Navigation System。
- 旧网站：<https://nav.lily.lat/>。
- 旧站只能作为旧导航数据来源与历史参考，不继续继承旧模板。新项目的架构、界面与实现需在正式开发阶段独立研究和设计。

## 未来正式架构方向

整个系统尽可能运行于 Cloudflare 原生能力：

- Cloudflare Workers。
- Workers Static Assets。
- D1。
- KV。
- R2。
- Cron Triggers。
- 其他适合本项目的 Cloudflare 原生能力。

禁止依赖 VPS 或传统服务器。具体语言、框架、依赖、构建方式、各服务职责和存储模型留到未来开发阶段确定。上述服务是候选方向，不要求为了凑齐架构而创建所有资源。本次初始化不提前实现任何架构或资源。

## 未来功能目标

以下均为未来开发需求，本阶段只记录：

- 前台导航系统。
- 后台单管理员管理。
- 分类管理。
- 链接新增、删除、修改和排序。
- 导航链接结构化存储。
- 链接主动健康检测。
- 定时 Cron 检测。
- 链接状态历史。
- HTTP 状态检测。
- Redirect 检测。
- DNS、TLS 与 Timeout 检测。
- 域名停放检测。
- 网站用途改变检测。
- 人工 Review。
- 对旧网站约 150+ 个链接进行完整审计。
- JSON Import / Export。
- 基本安全机制。
- SSRF 防护。

单管理员身份、会话、写入权限和导入校验需要在正式设计时明确。未来链接检测必须考虑 SSRF，包括访问目标校验、私有与保留地址、DNS 解析结果、重定向后的目标，以及请求超时和资源限制。检测结论应保留可供人工 Review 的依据。具体方案先研究、再设计，不在初始化阶段编写检测代码或数据库结构。

## 设计要求

整体视觉偏好：现代科技感、高级、简洁、留白、轻量动画，融合少量现代东方美学。

色彩与氛围偏好：低饱和、柔和、雅致、雾感。

- 主色可以考虑：黛青、青绿、青灰、墨色、雾灰、米白。
- 少量点缀可以考虑：金色、朱砂、暖色。
- 可以带有抽象的科技山水、云雾、远山、东方幻想感觉。

避免过度古风、赛博朋克泛滥、RGB 光污染、霓虹泛滥、复杂粒子、廉价 Dashboard、过度玻璃拟态。

这些是未来设计方向，不代表本阶段已开始 UI 设计，也不提前生成页面、组件或视觉资产。

## 生产保护：必须遵守

| 对象 | 当前状态与边界 |
| --- | --- |
| 旧 Worker `websitenavigation` | 继续运行，维持现有生产服务；不得自行修改、覆盖、重命名或删除。 |
| 生产域名 `nav.lily.lat` | 目前由旧 Worker 提供服务；当前禁止修改。 |
| 新项目 Worker 名称 `cf-nav` | 未来开发阶段使用的名称，本阶段不创建或部署。 |
| 新项目未来首个部署目标 | 仅 `workers.dev`，且须属于用户授权的后续开发任务。 |
| 生产切换 | 只有用户明确批准切换 `nav.lily.lat` 后才能执行。 |

任何 Codex 任务如果没有得到用户明确的生产切换指令，不得自行修改：

- `nav.lily.lat` 或其 DNS。
- 旧 Worker `websitenavigation`。
- 生产 Workers Route。
- 生产 Custom Domain。

不要把开发、测试、修复、CI 通过或 workers.dev 部署授权解释为生产切换授权。初始化阶段所有 Cloudflare 写入与部署均被禁止，不创建 D1、KV、R2、Cron、Worker 或任何其他资源。

## 已有 GitHub 配置

用户已经提前配置以下参数。这里只记录名称及公开的项目标识，不保存任何凭据值。

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| Repository Secret | `CLOUDFLARE_API_TOKEN` | 已存在；本阶段不读取、验证、引用或调用。 |
| Repository Variable | `CLOUDFLARE_ACCOUNT_ID` | 已存在。 |
| Repository Variable | `CLOUDFLARE_ZONE_ID` | 已存在。 |
| Repository Variable | `CF_WORKER_NAME` | 已存在，值为 `cf-nav`。 |
| Repository Variable | `CF_PRODUCTION_DOMAIN` | 已存在，值为 `nav.lily.lat`。 |

- 不修改、删除、重建这些 Secret / Variables，不要求用户再次配置。
- 后续优先复用这些现有参数，不无意义地增加大量 Repository Variables。
- Cloudflare Resource ID 如果适合写入未来的 wrangler 配置，优先放入配置文件；凭据不得写入配置文件或 Git。
- Token、Secret、密码、API Key、私钥和包含真实凭据的本地环境文件不得进入 repository、日志或提交。
- 本阶段不通过 API 请求测试 Cloudflare 凭据，不通过创建、修改资源或上传 Worker 验证 Token。

## 目录骨架与预期职责

| 路径 | 未来用途 |
| --- | --- |
| `.github/workflows/` | GitHub Actions；当前仅有手动 Bootstrap Check。 |
| `docs/` | 研究、设计与工程文档。 |
| `src/frontend/` | 未来前台导航界面。 |
| `src/worker/` | 未来 Worker 入口与平台整合。 |
| `src/admin/` | 未来单管理员后台。 |
| `src/api/` | 未来 API。 |
| `src/health/` | 未来链接健康检测与调度相关实现。 |
| `src/shared/` | 未来共享类型与工具。 |
| `migrations/` | 未来数据库 migration；当前无 SQL。 |
| `scripts/` | 未来工程辅助脚本。 |
| `tests/` | 未来测试。 |
| `data/` | 未来经审查的导入、导出或审计数据；当前无旧站数据。 |
| `public/` | 未来静态资源；当前无 HTML 页面或视觉资产。 |

当前空目录通过 `.gitkeep` 跟踪。此结构为可调整的职责边界，不预先锁定技术栈、路由或业务实现。

## 基础配置与初始化 Actions

- `.editorconfig`、`.gitattributes`、`.gitignore`、`.prettierrc.json`、`.prettierignore` 仅提供通用编辑、换行、忽略和格式约定。
- 当前不创建 package.json、依赖锁文件、Node 版本锁定或 wrangler 配置；待正式技术选型时再确定。
- `.github/workflows/bootstrap-check.yml` 名称为 `Repository Bootstrap Check`。
- 唯一触发方式是 `workflow_dispatch`；没有 push、pull_request 或 schedule 自动触发。
- 工作流只 checkout 并验证必要文件和目录占位，使用只读仓库权限，不安装应用依赖。
- 工作流不引用 Cloudflare Secret / Variables，不执行 wrangler，不部署、不创建资源、不修改 DNS、Routes 或 Custom Domains。
- 后续 CI/CD 必须按用户明确授权的阶段设计；不得自行加入 main push 到生产的流程。

## 后续正式开发原则

按以下顺序推进：先研究，再设计，再实现，再测试，再部署。每一步都应符合当前任务授权与生产保护边界。

- 先确认现状和需求；出现问题先复现、读取日志并定位真正原因。
- 遇到普通工程错误，Codex 应自行读取日志、排查并修复，不要立即停下来要求用户人工解决。
- 需要用户决定的需求或权限边界与普通工程错误应明确区分；未经授权不得执行生产切换。
- 保持正常工程提交粒度，不要每改一行就 commit；提交前检查 diff 和工作区状态。
- 测试与检查应与实际变更对应，报告清楚本地验证、GitHub Actions 验证与线上验证的实际范围。
- 研究、实现、测试和部署不能因便利而跳步；本文件中的未来需求不能用来扩大当前任务。

## 初始化完成后的停止条件

确认 main 已包含初始化文件、CODEX.md 与 README.md，GitHub Actions 能识别手动检查工作流；确认没有触发 Cloudflare 部署、没有修改旧 Worker 或生产域名、没有开始正式业务代码。然后停止，等待下一步开发指令。
