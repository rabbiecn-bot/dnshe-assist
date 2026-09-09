# DNSHE 助力助手 (dnshe-assist)

DNSHE 永久升级中心（好友助力）自动化工具。填写好友助力码，自动使用多个 DNSHE 账号依次助力，让域名升级为永久（无需续期）。

## ✨ 功能

- 📊 **账号总览**：展示所有 DNSHE 账号及剩余可用助力次数
- 🌐 **域名管理**：展示所有账号下的域名（含**到期时间**），可对未永久域名一键生成助力码
- 🚀 **一键助力**：填写好友助力码，自动依次使用 5 个有剩余次数的账号通过 API 助力
- 📜 **助力记录**：展示最近助力成功记录（存储于 Cloudflare KV）
- 💾 **KV 缓存架构**：账号/域名/到期列表预先写入 KV，前端从 KV 缓存读取（0 次 DNSHE 请求），一键同步 DNSHE 权威

## 🏗️ 架构

```
GitHub 仓库 (本仓库)
  │  代码 + GitHub Actions 一键部署
  ▼
Cloudflare Pages (functions/api/[[path]].js 适配层 → src/worker.js)
  │  ┌─ /api/status  读 KV 缓存（0 次 DNSHE 请求）
  │  ├─ /api/sync    一键同步 DNSHE 权威 → 覆盖 KV 缓存
  │  ├─ /api/create  生成助力码（直连 DNSHE，成功后刷新缓存）
  │  └─ /api/assist  触发助力（直连 DNSHE，成功后刷新缓存）
  │                    ↑ 只有写操作才消耗 DNSHE 请求（30 次/分钟限制）
  ▼
DNSHE API (api005.dnshe.com)
```

- 前端：`public/index.html`（Pages 静态资源托管，手机适配）
- 后端：`src/worker.js` + `src/dnshe.js`（DNSHE API 客户端，含 525/5xx 自动重试），由 `functions/api/[[path]].js` 适配层接入 Pages Functions
- 存储：Cloudflare KV（`ASSIST_KV`：`status:cache` 快照 + `assist:history` 助力记录）

> **为什么用 Pages 而不是 Worker**：Cloudflare Workers 出口 IP 曾触发 DNSHE 的 TLS 临时防护（HTTP 525），而 Pages Functions 的出口 IP 池不同、可正常访问 DNSHE（参考 dnsmanage 同样采用 Pages 部署）。实测同一套代码 Worker 出口 sync 6/6 全 525、Pages 出口 6/6 全成功。

> **缓存策略**：DNSHE 限制 30 次请求/分钟。所有读操作（查看账号额度、域名、到期）都从 KV 缓存读取，0 消耗。只有「生成助力码」「触发助力」这类写操作才直连 DNSHE。手动点「🔄 同步 DNSHE」或首次访问无缓存时，才从权威拉取全量数据（6 账号 ≈ 12 次请求，串行 + 间隔执行）。

## 🚀 一键部署（GitHub Actions）

### 1. Fork 本仓库

### 2. 添加 Repository Secrets

在仓库 `Settings → Secrets and variables → Actions` 中添加：

| Secret 名称 | 说明 |
|---|---|
| `CF_API_TOKEN` | Cloudflare API Token（需权限：Workers Scripts Edit、Workers KV Storage Edit、Pages Edit、DNS Edit） |
| `CF_ACCOUNT_ID` | Cloudflare 账号 ID |
| `DNSHE_ACCOUNTS` | DNSHE 账号 JSON 数组（见下方格式） |

**DNSHE_ACCOUNTS 格式**：

```json
[
  {"name": "user1@example.com", "X-API-Key": "xxxxxxxx", "X-API-Secret": "yyyyyyyy"},
  {"name": "user2@example.com", "X-API-Key": "xxxxxxxx", "X-API-Secret": "yyyyyyyy"},
  {"name": "user3@example.com", "X-API-Key": "xxxxxxxx", "X-API-Secret": "yyyyyyyy"},
  {"name": "user4@example.com", "X-API-Key": "xxxxxxxx", "X-API-Secret": "yyyyyyyy"},
  {"name": "user5@example.com", "X-API-Key": "xxxxxxxx", "X-API-Secret": "yyyyyyyy"}
]
```

> DNSHE API Key 在 DNSHE 面板 → API 设置中获取。`name` 仅用于展示，可随意填写。

### 3. 触发部署

- push 到 `main` 分支自动部署，或
- `Actions → Deploy DNSHE Assist to Cloudflare Pages → Run workflow` 手动部署

### 4. 绑定自定义域名（可选）

```
wrangler pages project create dnshe-assist --production-branch=main
wrangler pages domain add dnshe-assist <your-domain>
```

## 🛠️ 手动部署（可选）

```bash
npm install -g wrangler

# 1. 创建 KV namespace
wrangler kv namespace create ASSIST_KV
# 将输出的 id 填入 wrangler.toml 的 kv_namespaces.id

# 2. 设置 secrets
wrangler pages secret put DNSHE_ACCOUNTS --project-name dnshe-assist

# 3. 部署
wrangler pages deploy public --project-name dnshe-assist --branch=main
```

## 📖 使用说明

### 为域名生成助力码

1. 打开网页，在「域名列表」中找到**未永久**的域名（标记为「可升级」）
2. 点击「生成助力码」按钮
3. 域名卡片会显示生成的助力码，同时该域名进入「升级中」状态

### 用助力码助力（好友助力）

1. 拿到好友的助力码（如 `AB12CD34`）
2. 在「触发助力」输入框粘贴助力码
3. 点击「🚀 触发助力」
4. 系统自动依次使用最多 5 个**有剩余次数**的账号调用 DNSHE API 助力
5. 每个账号助力成功 +1 进度，5/5 后域名永久升级（无需续期）

### 助力次数说明

- 每个 DNSHE 账号每期有 **15 次**帮助他人的助力次数（`helper_assist_limit`）
- 每个升级任务需要 **5 次**助力（`assist_required`）
- 一个账号对一个助力码只能助力一次
- 账号额度用完会显示「已达上限」，不会被自动使用

## 🔒 安全说明

- DNSHE 账号凭证只存在 GitHub Secrets 和 Cloudflare Pages 环境变量中，**不会**下发到前端
- 前端页面公开可访问（无需登录），任何拿到 URL 的人都可以消耗你的助力额度，请勿公开页面地址
- 如需加访问密码，可在 `src/worker.js` 中增加简单的校验逻辑

## 📁 项目结构

```
dnshe-assist/
├── functions/
│   └── api/
│       └── [[path]].js    # Pages Functions 适配层（转发 /api/* 给 worker.js）
├── public/
│   └── index.html        # 前端页面（Pages 静态资源）
├── src/
│   ├── worker.js         # 主入口（路由 /api/status /api/sync /api/create /api/assist）
│   └── dnshe.js          # DNSHE API 客户端
├── .github/workflows/
│   └── deploy.yml        # GitHub Actions 一键部署（wrangler pages deploy）
├── wrangler.toml         # Pages 配置（pages_build_output_dir + ASSIST_KV binding）
└── README.md
```

## ⚠️ 免责声明

本项目仅用于自动化 DNSHE 平台已有功能。请合理使用，遵守 DNSHE 服务条款。本项目与 DNSHE 官方无关。