# 嗑瓜子 — 影视搜索播放站

基于 Cloudflare Pages 的影视搜索与在线播放站（开源版）。
后端全部逻辑在单文件 `_worker.js`（高级模式），前端为无框架 SPA，AES 密钥只存在 Worker 端。

> 免责声明：本项目仅为接口学习与技术演示，不存储任何影视资源，数据来自第三方公开接口，请于 24 小时内自行判断是否保留。

## 功能

-   关键词搜索（电影/剧集/动漫/综艺/短剧），海报网格 + 分页
-   在线播放（hls.js，m3u8 加密流经代理重写可播），全集合集列表（一次拉全 + 逐页兜底）
-   播放器工具条：倍速 0.5x~2.0x（localStorage 记忆，换集不丢）；多码率源自动出现清晰度菜单（当前上游为单码率时隐藏）
-   观看记录（浏览器本地 localStorage）：首页「继续观看」一键续播上次那集，支持单条删除 / 一键清空，最多 50 条
-   首页热搜词、播放页推荐、图片代理（防盗链绕过）
- 三层缓存：内存 30min 新鲜 / 6h 陈旧兜底+后台刷新，上游间歇限流时站点仍可用
- 自带 `debug.html` 一键诊断页（7 项检查）

## 部署到 Cloudflare Pages

### 方式 A: Dashboard 拖拽上传（最简单）

进入本仓库下载的文件夹（能看到 `index.html` 和 `_worker.js` 的那层），
拖进 Dashboard → Workers & Pages → Create → Pages → Upload assets。
`_worker.js` 是普通文件，拖拽同样生效。

### 方式 B: wrangler 直传

```bash
npm install -g wrangler
wrangler login
wrangler pages deploy . --project-name <你的项目名>
```

### 方式 C: Git 连接（推荐用本仓库，改完推上去自动重新部署）

1. Fork/推送到你的 GitHub 仓库
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
3. 构建设置：Framework preset **None**，Build command **留空**，Build output directory **/**
4. 之后每次 `git push`，Pages 自动重新部署

### 部署后自检

打开 `https://你的域名/debug.html` → 开始诊断，7 项全绿即可用。
最常见问题：部署根选错（站点挂在子路径下）——必须部署含 index.html 的文件夹本身。

## 本地开发

```bash
npm install -g wrangler
wrangler pages dev . --port 8788   # http://localhost:8788
```

## 文件结构与职责（改哪里看这张表）

| 文件 | 职责 | 什么时候动它 |
|---|---|---|
| `_worker.js` | 全部后端：AES 加解密、白名单、缓存、m3u8 重写、静态资源服务 | **换源改顶部配置区**；改缓存/代理逻辑 |
| `app.js` | 前端 SPA：路由、搜索页/结果页/播放页、hls.js 播放 | 上游接口路径/字段名变了才需要改 |
| `index.html` | SPA 入口 + 顶栏 | 基本不动；改样式引用后要升 `?v=` |
| `style.css` | 全部样式 | 调布局/配色 |
| `version.js` | 构建标记 `APP_BUILD`，诊断页用来识别前端版本 | 每次改前端后同步升版本号 |
| `debug.html` | 7 项自动诊断页 | 一般不动 |
| `wrangler.toml` | 声明部署根为 `./` | 不动 |
| `.assetsignore` | 部署时排除元文件（README 等） | 不动 |

## 换源指南（上游网站失效时看这里）

### 什么时候需要换源

- 首页热搜/搜索一直报「上游接口繁忙」且持续数小时
- `debug.html` 第④项（上游连通性）或第⑤项（搜索）变红
- 用 curl 直接打旧网关也超时/404（确认不是限流）

```bash
# 先确认旧网关是否真挂了（超时/拒连=挂了，慢=只是限流）
curl -m 15 -X POST "https://<旧网关域名>/gz/Pc/Search/ShowHots" \
  -H "Content-Type: application/json" -d '{"params":"..."}'
```

### 换源三步

**第 1 步：扒新上游的三个参数**

对新源头站（网页版）按 F12 → Network → XHR，随便触发一次搜索，观察请求：

1. **网关地址**：请求的 host（如 `https://xxx.com`）
2. **请求格式**：body 形如 `{"params":"<hex密文>"}` → AES-128-CBC，密文 hex 编码
3. **密钥和 IV**：在源头站前端 JS 里搜 `CryptoJS` / `AES` / `enc.Hex` 附近，找到 32 位 hex 字符串的 key 和 iv（也可能在请求拦截器里拼接）

验证方法（本地 node）：

```js
const crypto = require("crypto");
const d = crypto.createDecipheriv("aes-128-cbc",
  Buffer.from("新KEY_HEX"), Buffer.from("新IV_HEX"));
console.log(Buffer.concat([d.update(Buffer.from("响应data字段的hex","hex")), d.final()]).toString());
```

**第 2 步：只改 `_worker.js` 顶部配置区**

打开 `_worker.js`，顶部有醒目的「换源配置区」注释框，只改这一块：

```js
const UPSTREAM = "https://新网关域名";        // [1] 网关
const AES_KEY  = "新32位hex";                 // [2] 密钥
const AES_IV   = "新32位hex";                 // [2] IV
const ALLOW = new Set([ ... ]);              // [3] 白名单路径（新站路径不同就同步换）
```

其余代码（缓存/代理/静态服务）**不用动**——AES 参数和网关都是配置注入的。

**第 3 步：验证 + 部署**

```bash
wrangler pages dev . --port 8788
# 打开 http://localhost:8788/debug.html → 7 项全绿
wrangler pages deploy .
```

### 上游接口路径也变了怎么办

新站的路径/字段名若不同（如 `/Pc/Search/...` 变成 `/Api/Search/...`）：

1. `_worker.js` 配置区：更新 `ALLOW` 白名单
2. `app.js`：全局搜索旧路径名（如 `GetConditionList`），替换为新路径；字段名变化同样映射
3. `debug.html`：第④⑤项测试用的路径同步换
4. 版本号：`index.html` 里 `?v=bN` +1，`version.js` 和 `app.js` 头部 `APP_BUILD` 同步升

## 用 AI 工具更新（提示词模板直接抄）

仓库文件少、职责单一，任何 AI（Claude/ChatGPT/Copilot）都能改。两种场景：

### 场景 1：只换网关域名/密钥（最常见）

> 我的影视站在 `_worker.js`。源头站更换了，新参数：
> 网关=`https://xxxx.com`，AES key=`xxxx`，AES iv=`xxxx`，接口路径不变。
> 请只修改 `_worker.js` 顶部「换源配置区」的三个常量，其余代码不要动。改完告诉我怎么本地验证和部署。

### 场景 2：新站协议全变（路径/加密方式/字段都不同）

> 我的影视站需要更换数据源。旧实现见 `_worker.js`（后端代理）和 `app.js`（前端）。
> 新源头站信息：
> - 网关：`https://xxxx.com`
> - 加密：`（如 AES-128-CBC key=xxx iv=xxx，请求 {"params":"hex"}，响应 data 字段 hex 密文；或明文 JSON 等）`
> - 接口：搜索=`POST /xxx`（参数...）、详情=`...`、全集列表=`...`、热搜=`...`
> - 关键响应字段：`（贴一段新站的真实响应 JSON）`
> 请更新：① `_worker.js` 配置区与加密/转发逻辑 ② `app.js` 里的接口路径与字段映射 ③ `debug.html` 测试路径 ④ 版本号全部升一档（index.html 的 ?v=、version.js、app.js 头部 APP_BUILD）。改完给出 wrangler 本地验证步骤。

### 更新后必做清单（AI 与人都照此核对）

- [ ] `_worker.js` 本地 `wrangler pages dev` 起来后 `/debug.html` 7 项全绿
- [ ] `index.html` 的 `?v=bN` 已 +1（浏览器不缓存旧前端）
- [ ] `version.js` 与 `app.js` 头部 `APP_BUILD` 同步升
- [ ] 部署后线上 `/debug.html` 再跑一遍

## 常见问题

- **搜索报 `Unexpected end of JSON input`**：`_worker.js` 没部署上（检查部署根，跑 `/debug.html`）
- **报「上游接口繁忙」**：上游间歇限流，等几分钟；缓存层会在 6 小时内兜底旧数据
- **视频黑屏有声音/无声音**：视频 CDN 与 API 网关独立，API 挂了不影响已拿到 m3u8 的播放
- **改了前端没变化**：`?v=` 没升，浏览器还在用缓存

## License

MIT
