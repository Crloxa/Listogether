# Listogether · 朋友的音乐房间

Listogether 是一个**自托管**的浏览器音乐共享空间：一个人当"房主"，用自己电脑上的音乐开房间；朋友点开链接就能加入，一起听、一起点歌、一起聊天。所有音乐从房主的电脑实时流向朋友（WebRTC），**不经过任何第三方云服务，音频不上传、不保存**。

```text
房主的电脑 ──音频(WebRTC 点对点)──► 朋友的浏览器
     │                                 │
     └────控制消息(经你部署的 Relay 中转)────┘
```

- **房主**：创建房间、导入本地音乐、控制播放、邀请和管理朋友。
- **成员**：点开邀请链接加入，点歌、投票跳过、发聊天，调节自己的音量。
- **Relay**：你自己部署的一个小服务，只转发控制消息和文字聊天，**接触不到音频**。

当前状态：Phase 4 完成——平台链接识别、官方 OAuth（Authorization Code + PKCE）、封面/歌词全员共享、安全加固与 Docker 一键部署。

---

## 目录

- [快速开始（Docker 一键部署）](#快速开始docker-一键部署)
- [使用手册](#使用手册)：[房主开房](#房主开一场音乐房)、[成员加入](#成员加入朋友的房间)、[一起玩](#大家一起玩点歌聊天投票)
- [常见问题 FAQ](#常见问题-faq)
- [隐私与数据边界](#隐私与数据边界)
- [部署进阶](#部署进阶)：手动部署、公网发布、配置参考
- [开发者指南](#开发者指南)

---

## 快速开始（Docker 一键部署）

### 你需要准备

- 安装了 **Docker**（含 Docker Compose）的电脑 —— 房主的音乐也从这台电脑播出，所以它最好就是放音乐的那台机器。
- 浏览器：Chrome / Edge / Firefox 现代版本（房主与成员都用浏览器，无需安装任何 App）。

### 三步启动

```bash
# 1. 在项目根目录（docker-compose.yml 所在目录）执行：
docker compose up -d --build

# 2. 等待构建完成（首次约 2~5 分钟），确认两个容器都在运行：
docker compose ps

# 3. 打开浏览器访问：
#    http://localhost:9000
```

看到首页显示 **"Relay 已连接"** 就说明部署成功了。

### 日常运维命令

| 命令 | 作用 |
| --- | --- |
| `docker compose up -d --build` | 构建（或重建后）启动 |
| `docker compose logs -f relay` | 查看 Relay 日志（JSON 格式，敏感字段已脱敏） |
| `docker compose ps` | 查看运行状态（两个容器都应显示 healthy） |
| `docker compose stop` / `start` | 暂停 / 恢复 |
| `docker compose down` | 停止并移除容器（**房间是内存态，停止即清空**，重新 up 后大家重新进房即可） |
| `git pull && docker compose up -d --build` | 升级到新版本 |

> 部署架构：`web` 容器用 nginx 托管网页，并把 `/api`（REST）和 `/ws`（WebSocket）**同源反代**给 `relay` 容器——浏览器只访问 9000 一个端口，没有跨域问题，Relay 也不必暴露到公网。

---

## 使用手册

### 房主：开一场音乐房

**第 1 步：创建房间**
打开 `http://localhost:9000`，输入你的昵称（可选设置房间密码），点 **"创建房间"**。创建成功后自动进入房间页。

**第 2 步：导入你的音乐**
在房间页的 **"房间曲库（房主）"** 卡片，把音乐文件（或整个文件夹）**拖进去**，也可以点"选择文件/选择文件夹"。支持浏览器能解码的格式（mp3 / wav / ogg / flac / m4a 等）。

- 导入时浏览器会自动读取歌名、歌手、封面（mp3 的 ID3 标签）；同名 `.lrc` / `.txt` 歌词文件会和歌曲一起导入并自动同步。
- **音乐文件只在你自己的电脑里解码播放，不会被上传**——进入房间的只有"歌名/歌手/时长"这类文字信息。
- 曲库保存在你的浏览器本地：下次开房不用重新导入，刷新后点"重新加载"再选一次同名文件即可恢复绑定。

**第 3 步：邀请朋友**
在 **"房主管理"** 卡片复制 **邀请链接**，通过微信/QQ/任何方式发给朋友。链接形如：

```text
http://你的地址/join?room=<房间ID>#i=<邀请凭证>
```

- 链接可反复使用（同一链接可以来多个人）。
- 房间设了密码的话，朋友加入时需要输入。
- 想让链接作废？锁房或关闭房间即可。

**第 4 步：开始播放**
在曲库里对一首歌点 **"下一首播放"**。所有在线成员会先进入"准备"状态，全员就绪后**在同一时间点**开始播放（保证大家听到的是同步的）。

- 之后想换歌：再点任意歌的"下一首播放"；**暂停/拖动进度**即时生效，不会让朋友干等。
- 歌播完了怎么办：开启队列后按播放模式自动衔接下一首；队列空了会自动暂停并提示。

**第 5 步：管理房间（可选）**
| 操作 | 说明 |
| --- | --- |
| 锁房 | 停止新成员加入，已在房间的人不受影响 |
| 踢出 | 把某个成员请出房间（对方需重新拿邀请链接才能进） |
| 设为共同 DJ | 让朋友也能审批点歌、管理队列、切歌 |
| 关闭房间 | 所有人被请出，房间消失，不可恢复 |

### 成员：加入朋友的房间

1. **点开房主发的邀请链接** → 输入昵称（有密码则输入密码）→ 点 **"加入房间"**。
2. **点一次"启用声音"**。浏览器默认阻止网页自动出声，这是正常现象，点一次即可（之后音量/静音随你调）。
3. 等"下一首"开始：全员就绪后音乐会**同时**响起，不需要你做任何操作。

**成员能做什么：**

- **点歌**：在"从曲库点歌"区选一首 → 进入待审批区 → 房主（或共同 DJ）批准后进入队列自动播放。每人同时最多 2 首未播放的点歌，30 秒内不能连点。
- **投票跳过**：不喜欢当前的歌？点"投票跳过当前歌曲"，超过一半在线成员同意就自动跳过。
- **重新同步**：如果你听到的进度和大家讨论的对不上（比如中途卡过），点 **"重新同步（只影响自己）"**，只调整你一个人的播放，不影响别人。
- **聊天**：右下聊天框发文字和表情，最近 50 条会在重连后恢复。
- **自己的音量/静音**：纯本地控制，别人听不到你的调整。

### 大家一起玩：点歌、聊天、投票

```text
点歌 ──► 待审批（房主/共同DJ 批准）──► 队列 ──► 自动按序播放
  │                                        │
  └─ 房主/共同DJ 点歌免审批直接入队          └─ 播完/跳过自动取下一首
```

- **播放模式**（房主可切）：顺序 / 单曲循环 / 随机。
- **歌词**：房主导入同名 `.lrc` 歌词后，所有人看到逐行高亮跟着进度走；纯文本 `.txt` 整段显示；没有歌词显示占位。
- **封面**：房主歌曲的封面会实时传给所有成员显示。
- **平台链接（实验性）**：房主粘贴网易云 / QQ 音乐 / Spotify / YouTube Music 的**单曲链接**可以识别歌名、歌手、时长并加入曲库——但**播放仍然需要房主电脑上有对应音频文件**（本应用不做平台音频转发，不绕过会员/版权限制）。播放到没有文件的平台条目时会明确提示并自动跳过，不影响房间。
- **平台账号（可选）**：房间页"平台账号"卡片可登录已配置的平台（OAuth 官方授权）。未配置时显示"未配置"，完全不影响其他功能。

---

## 常见问题 FAQ

**加入了但没有声音？**
点成员卡片里的 **"启用声音"**。这是浏览器的自动播放限制，每次刚进房间（或长时间未交互后）可能需要点一次。之后仍无声就点 **"重新同步"**。

**画面显示"正在重连/连接中断"？**
短暂断网或切后台导致的，通常几秒内自动恢复，身份和进度都会接上。长时间无法恢复时刷新页面即可；刷新会走同样的恢复流程。

**房主关了网页，音乐会停吗？**
房主意外掉线有约 45 秒宽限期，期间回来无缝恢复；超时未回来，**房主身份会自动转移**给最早加入的成员——但注意：音乐文件在新房主的电脑上不存在，需要新房主导入对应文件才能继续出声（应用会明确提示）。

**平台链接识别失败 / Spotify 显示"平台不可达"？**
平台识别走你部署的服务器所在网络。网易云音乐、QQ 音乐在中国大陆网络可直接用；Spotify / YouTube Music 在无法访问其服务的网络里会明确报"平台暂时不可达"（约 5 秒内），不影响房间其他功能。

**邀请链接可以发到群里让大家自己进吗？**
可以，链接可重复使用。想要"一场一链接"，用完锁房或关房即可。

**朋友在外网/不同网络能加入吗？**
能。控制消息经你部署的 Relay 中转（需要朋友能访问你部署的地址）；音频走浏览器点对点直连，直连不通时会尝试 TURN 中继（需要按[部署进阶](#部署进阶)配置 TURN）。在家里局域网或同一网络下体验最简单。

**重启 Docker 后房间还在吗？**
房间、队列、聊天都是内存态，`docker compose down` / 重启后会清空。重新建房、重新邀请即可（房主浏览器里的曲库还在，不用重新导入文件）。

---

## 隐私与数据边界

应用**不含任何第三方统计或遥测**。每类数据的去向：

| 数据 | 去向 | 说明 |
| --- | --- | --- |
| 音频 | 房主 → 成员，浏览器点对点（WebRTC） | Relay 与磁盘都不接触音频 |
| 封面 | 房主 → 成员，点对点数据通道 | 单张 ≤512KB，超限自动压缩 |
| 控制消息（播放/队列/歌词/聊天） | 经 Relay 内存转发 | 不落盘；Relay 重启即清空 |
| 房主曲库/歌词缓存 | 房主自己浏览器的 localStorage | 音频文件字节永不上传 |
| 平台链接解析 | Relay → 平台公开接口 | 只发送你粘贴的链接本身 |
| OAuth 令牌（如启用） | 仅 Relay 进程内存 | 绝不进房间消息、链接、日志；断开或重启即失效 |
| 邀请/会话凭证 | Relay 内存中只存哈希 | 邀请凭证在链接的 `#` 之后，不会进服务器日志 |

---

## 部署进阶

### 更换端口 / 绑定域名

改 `docker-compose.yml` 里两处：

1. `ports: "9000:80"` → 想要的宿主端口，如 `"8080:80"`；
2. `LISTO_RELAY_ALLOWED_ORIGINS` 与 `LISTO_RELAY_PUBLIC_BASE_URL` → 新的对外来源（如 `http://192.168.1.10:8080` 或 `https://music.example.com`）。

然后 `docker compose up -d --build` 重建。

### 公网发布（让外网朋友加入）

- **必须上 HTTPS**：最简单的方式是在 Docker 外再放一层 Caddy/Nginx 反代并自动签证书，把流量转给 `web` 容器的 80 端口。WebSocket 的 `Upgrade` 头需要透传（Caddy 默认支持）。
- **配置 TURN**（跨运营商/严格 NAT 环境音频直连失败时的中继兜底）：部署 [coturn](https://github.com/coturn/coturn) 并开启 `use-auth-secret`，然后在 compose 里取消注释：

```yaml
LISTO_TURN_URLS: "turn:turn.example.com:3478?transport=udp"
LISTO_TURN_SECRET: "<与 coturn static-auth-secret 相同的高熵密钥>"
```

Relay 会自动向每个进房用户下发**短期凭据**（默认 1 小时有效、自动轮换），无需在前端保存任何长期密码。

### 启用平台账号登录（可选）

以 Spotify 为例，在 [Spotify Developer](https://developer.spotify.com/dashboard) 创建应用（Redirect URI 填 `https://你的域名/api/oauth/spotify/callback`），然后在 compose 的 relay 环境变量里填：

```yaml
LISTO_OAUTH_SPOTIFY_CLIENT_ID: "<应用 Client ID>"
LISTO_OAUTH_SPOTIFY_CLIENT_SECRET: "<应用 Client Secret>"
LISTO_OAUTH_SPOTIFY_SCOPES: "user-read-private"
LISTO_OAUTH_SPOTIFY_AUTHORIZE_URL: "https://accounts.spotify.com/authorize"
LISTO_OAUTH_SPOTIFY_TOKEN_URL: "https://accounts.spotify.com/api/token"
LISTO_OAUTH_SPOTIFY_USERINFO_URL: "https://api.spotify.com/v1/me"
```

**不配置任何账号登录，应用的所有核心功能都可用**——登录只增强平台链接的可用性判断。本地联调可用自带的标准 mock 授权服务器：`node scripts/mock-oauth-provider.mjs`。

### 环境变量参考（relay）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LISTO_RELAY_ADDR` | `:8080` | 监听地址 |
| `LISTO_RELAY_ALLOWED_ORIGINS` | 本地开发来源 | 允许的浏览器来源（逗号分隔） |
| `LISTO_RELAY_PUBLIC_BASE_URL` | 空 | 对外基址；OAuth 回调用，空则登录不可用 |
| `LISTO_RELAY_MAX_MEMBERS` | `16` | 新房间默认人数上限（2..256） |
| `LISTO_RELAY_OFFLINE_TTL_SECONDS` | `45` | 掉线宽限期 |
| `LISTO_RELAY_TLS_CERT` / `_KEY` | 空 | 直连 HTTPS/WSS 证书（一般用反代替代） |
| `LISTO_TURN_URLS` / `LISTO_TURN_SECRET` / `LISTO_TURN_TTL_SECONDS` | 空 / 空 / 3600 | TURN 短期凭据（D-018） |
| `LISTO_PROVIDERS_NETEASE_API_BASE` 等 | 内置默认 | 平台接口地址覆盖（接口变更时应急切换） |
| `LISTO_OAUTH_<平台>_*` | 空 | OAuth 凭证（见 `.env.example`） |

完整占位示例见 [`apps/relay/.env.example`](apps/relay/.env.example)。

### 不用 Docker（手动部署 / 开发）

```bash
npm install          # 安装前端依赖
npm run dev:relay    # Go Relay（:8080）
npm run dev:web      # Vite 开发服务器（:5173）
# 浏览器访问 http://localhost:5173
```

生产手动部署：`npm run build:relay` 产出 Go 二进制；`npm run build` 产出 `apps/web/dist` 静态文件，用任意静态服务器托管并按上面的 nginx.conf 反代 `/api` 与 `/ws`。

---

## 开发者指南

| 命令 | 作用 |
| --- | --- |
| `npm run smoke` | 一键冒烟（构建 relay + 双 WS 房间流程 + Phase 2/3/4 全部协议路径，46 项 PASS） |
| `npm test` / `npm run test:relay` | TS 测试（vitest，151 例）/ Go 测试（11 包） |
| `npm run typecheck` / `npm run vet:relay` | TS 类型检查（TypeScript 7）/ go vet |
| `npm run build` / `npm run build:relay` | 前端构建 / relay 二进制 |
| `node scripts/stress-relay.mjs` | Relay 压测基线（默认 100 房间 × 1000 连接 + 延迟采样；`--rooms/--members/--soak/--samples` 可调，需先启动 relay） |

- 技术栈：TypeScript + React + Vite（前端）· Go + Gorilla WebSocket（Relay）· WebRTC + Web Audio（音频）· JSON Schema 单一来源协议（`packages/protocol/schema/`）。
- 项目结构、架构决策（D-001~D-019）、阶段 checklist 与测试证据都在 [`docs/`](docs/)：从 [`docs/00-product-overview.md`](docs/00-product-overview.md)、[`docs/01-architecture.md`](docs/01-architecture.md)、[`docs/03-technical-design.md`](docs/03-technical-design.md) 读起。
- 环境要求：Node ≥ 20、Go ≥ 1.27（`go` 不在 PATH 时脚本会探测 `D:\Golang\go\bin`，详见 `scripts/go.mjs`）；中国大陆网络建议 `GOPROXY=https://goproxy.cn,direct`。

## 文档索引

- 产品范围：[docs/00-product-overview.md](docs/00-product-overview.md)
- 架构与同步模型：[docs/01-architecture.md](docs/01-architecture.md)
- 技术设计：[docs/03-technical-design.md](docs/03-technical-design.md)
- 阶段总览与任务：[docs/02-roadmap.md](docs/02-roadmap.md) · [docs/phases/](docs/phases/)
- 决策记录：[docs/DECISIONS.md](docs/DECISIONS.md)
- 平台接入实测与失败经验：[docs/PROVIDERS.md](docs/PROVIDERS.md)
- 测试证据：[docs/TEST_EVIDENCE.md](docs/TEST_EVIDENCE.md)
- 交接记录：[docs/HANDOFF.md](docs/HANDOFF.md)
