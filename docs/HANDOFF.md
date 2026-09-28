# 统一交接文档

本文件是当前任务的交接入口。每位 agent 完成工作前更新“当前交接记录”；历史记录按日期追加，不覆盖已有记录。

## 交接模板

```markdown
## YYYY-MM-DD / agent 名称

### 任务
- 阶段：Phase X
- 目标：
- 对应 checklist：

### 已完成
- 

### 修改文件
- `path/to/file`: 修改目的

### 验证与证据
- 命令：`...`
- 结果：通过/失败（退出码）
- 证据：`docs/evidence/...` 或截图/日志路径
- 手工场景：步骤和实际结果

### 未完成与风险
- 

### 下一步
- 

### 敏感信息检查
- [ ] 没有提交密码、token、Cookie、真实本地路径或个人音频
```

## 当前交接记录

## 2026-09-19 / 压测基线（技术设计容量目标首次验证）

### 任务

- 阶段：Phase 4 后续（用户指令：Docker 已就绪，执行压测）
- 目标：验证"1,000 空闲连接 + 100 活跃房间"与"控制事件 P95 < 300ms"两项从未验证的设计承诺。

### 已完成

- [x] 新增 `scripts/stress-relay.mjs`（Node 22 内置 WebSocket，无第三方依赖）：建房/入房会话预建 → 全量 WS 接入（worker 池限并发 + 20s 单连接超时）→ 空闲浸泡 → 房主 PLAY→成员广播延迟采样 → 容器内存/CPU 采样 → JSON 报告。
- [x] 全量基线实测（Docker 容器 relay，同机回环）：**1000/1000 连接 0 失败（1.0s）、60s 浸泡 0 掉线、延迟 P50=13ms / P95=24ms / P99=26ms / max=27ms（目标的 1/12）、内存 2.4→48MiB（≈45KB/连接）、CPU <3%**。
- [x] 修复压测脚本两个自身 bug（状态对象被展开拷贝导致 revision 跟踪失效；连接 worker 池只启动一次导致挂起）——详见 TEST_EVIDENCE PH4-011。

### 修改文件

- `scripts/stress-relay.mjs`（新增）、`docs/TEST_EVIDENCE.md`（PH4-011）。

### 验证与证据

- `node scripts/stress-relay.mjs --report scripts/tmp/stress-full.json`（EXIT=0）；小规模试跑 + 全量各一轮；容器日志 0 error/panic。

### 未完成与风险

- 结果为同机回环基线（含 docker-proxy 一跳），真实网络 RTT 未含；万级连接未测（超出设计承诺）；多实例/Redis 属后续项。

### 敏感信息检查

- [x] 没有提交密码、token、Cookie、真实本地路径或个人音频（压测会话 token 为一次性随机值且不写入报告）。

## 2026-09-18 / Phase 4.5 收尾包（D-020）

### 任务

- 阶段：Phase 4.5（用户指令："除了公网外把没完成的功能做掉"的优先项）
- 目标：上一首、房主上行带宽提示、致命断线重试、共同 DJ 缺文件引导、flac/m4a 标签解析。
- 对应 checklist：不新增阶段项；决策记录 D-020。

### 已完成

- [x] **上一首**（产品概览 MVP 边界明确要求，此前完全缺失）：零协议面——从快照 history 取最近 played/skipped 条目复用既有屏障；房主控制区新增按钮（无历史禁用）。开发中修正语义：不排除与当前曲目相同的条目（刚结束的歌重播正是预期）。
- [x] **房主上行带宽提示**（技术设计容量目标落地）：状态行显示"预计上行 ≈ X"（文件大小×8÷时长×连接成员数）；超 10 Mbps 显示警告横幅。
- [x] **致命断线重试**：RoomStore 增加 fatalKind（session_invalid/room_closed/retry_exhausted）；仅 retry_exhausted 显示"重试连接"按钮。
- [x] **共同 DJ 缺文件引导**：屏障超时且 0 人就绪时显示提示（补齐房主/共同 DJ 信息不对称）。
- [x] **flac/m4a 标签解析**：readAudioTags 按魔数分派（fLaC/ftyp/ID3），手写解析器（8MB 预算，不引入依赖）；flac 取 VORBIS_COMMENT+PICTURE，mp4 取 ilst 的 ©nam/©ART/covr。

### 修改文件

- `apps/web/src/features/queue/history.ts`、`features/room/bandwidth.ts`（新增纯函数）
- `apps/web/src/features/room/RoomPage.tsx`（上一首按钮/带宽提示与警告/共同 DJ 提示/重试按钮）
- `apps/web/src/transport/ws/room-store.ts`（fatalKind/retryReconnect）
- `apps/web/src/features/room/library.ts`（readAudioTags + parseFlacTags/parseMp4Tags）
- `apps/web/src/features/room/use-host-library.ts`（改用 readAudioTags）
- `apps/web/src/test/phase45-wrapup.test.ts`（新增 15 例）
- `docs/DECISIONS.md`（D-020）、`docs/TEST_EVIDENCE.md`（PH4-010）

### 验证与证据

- 命令（全部退出码 0）：`npm run typecheck`（0 错误）、`npm test`（166 例）、`node scripts/go.mjs vet/test ./...`（11 包）、`npm run build`、`npm run smoke`（46 项 PASS）。
- 浏览器（dev 栈双标签页）：上一首全闭环（播放→跳过→按钮启用→重播）；带宽提示实值 353 kbps 与测试音一致；无成员时不显示估算（不给误导数字）。

### 未完成与风险

- 收藏 / PWA / 移动端真机 / 压测基线（1000 连接）/ P95 延迟测量 / 依赖升级残留（vite8/vitest5/jest-dom7）：仍为待办，见前几份交接与 D-020 前的记录。
- flac/m4a 解析为尽力而为：moov 在文件尾部（非 faststart）的 m4a 回退文件名；加密/非常规结构同样回退——失败表现是"歌名=文件名"，不是错误。

### 下一步

- Phase 5 公网实战验收（MVP 总验收最后一格）仍是最优先；收尾包已把其余高价值缺口清空。

### 敏感信息检查

- [x] 没有提交密码、token、Cookie、真实本地路径或个人音频（测试音频为脚本合成并已清理）。

## 2026-09-18 / Phase 4 后续：Docker 一键部署实测 + 用户手册

### 任务

- 阶段：Phase 4 后续（用户指令：Docker 已就绪，测试部署并写用户手册）
- 目标：容器化部署可用且实测通过；README 成为"部署/邀请/加入"的可读用户手册。

### 已完成

- [x] 新增部署文件：`apps/relay/Dockerfile`（多阶段 Go 构建 → alpine 非 root 运行时 + HEALTHCHECK）、`apps/web/Dockerfile`（node:22 monorepo 构建 → nginx 托管）、`apps/web/nginx.conf`（SPA fallback + /api 反代 + /ws WebSocket 升级头）、`docker-compose.yml`（web :9000 → nginx → relay，同源免 CORS）、`.dockerignore`。
- [x] 全链路实测：healthz/建房/邀请链接生成/成员加入/双成员同步全部经 nginx 反代成功；截图 `docs/evidence/phase4/docker-e2e-member-joined.png`。
- [x] 修复两个部署缺陷：①`/healthz` 未反代（首页探测失败）；②web 构建未内联 `VITE_RELAY_HTTP_URL`（前端直连未暴露的 relay 端口）。
- [x] README 重写为用户手册：快速开始（Docker 三步）、房主/成员分角色使用说明、FAQ、隐私边界、部署进阶（换端口/公网 HTTPS/TURN/OAuth）、环境变量参考、开发者指南。

### 验证与证据

- `docker compose build`（relay 首次 go mod download 瞬时网络失败，重跑通过）、`docker compose up -d --build` 双容器 healthy。
- 浏览器（localhost:9000）：建房 → 邀请链接 → 第二标签页加入 → 双端"已连接"、成员列表一致。
- 开发侧自检不受影响（本轮只改部署文件与 README）。

### 未完成与风险

- 跨主机/公网访问未实测（需外网环境）；README 部署进阶已写明 HTTPS 反代与 TURN 要求。
- 容器内 Go 构建走 goproxy.cn（Dockerfile ARG 可覆盖），海外构建建议改回官方代理。

### 下一步

- 如需公网演示：按 README「公网发布」一节配置反代 + coturn。

### 敏感信息检查

- [x] 没有提交密码、token、Cookie、真实本地路径或个人音频（compose 中 TURN/OAuth 均为注释占位）。

## 2026-09-18 / Phase 4 后续：遗留风险处置（TURN / OAuth 全栈验收 / 依赖专项）

### 任务

- 阶段：Phase 4 后续加固（用户指令：放弃 Spotify/YouTube 外网方向，解决遗留风险）
- 目标：TURN 短期凭据落地；OAuth 以 provider 无关实现 + 本地全栈验收替代真实平台联调；平台接口变更可运维切换；无障碍与依赖升级专项。
- 对应 checklist：不新增阶段项（Phase 4 checklist 已完成）；决策记录 D-018/D-019，实测记录 PROVIDERS.md P-012。

### 已完成

- [x] 文档先行：D-018（TURN 短期凭据经 Relay 下发，coturn REST 机制）、D-019（放弃外网方向，OAuth 验收基准调整，API base 可运维切换）；PROVIDERS.md P-012；D-010 补注。
- [x] TURN 短期凭据（消除"长期凭据进前端包"风险）：`internal/turncreds`（HMAC-SHA1 为 coturn 协议规定算法，独立测试向量）；`GET /api/webrtc/ice`（会话鉴权，`LISTO_TURN_URLS/SECRET/TTL_SECONDS`）；web 端三级优先（运行时 > VITE_ICE_SERVERS > 默认 STUN），进房拉取 + TTL/2 刷新 + 失败不阻塞建联。
- [x] OAuth 全栈浏览器验收（替代不可达的真实平台联调）：`scripts/mock-oauth-provider.mjs` 独立进程标准 AC+PKCE 授权服务器；浏览器 E2E 验证 授权弹窗→回调→连接（打码标识）→过期刷新→断开撤销 全链路（mock 计数 issued=1/refreshed=1/revoked=1 与 UI 一致）；冒烟新增协议级等价 3 项（46 项 PASS 连续两轮）。
- [x] 真实 UX 缺陷修复：OAuth 授权弹窗被拦截时增加"在新标签页完成授权"回退链接。
- [x] 平台接口变更缓解：`LISTO_PROVIDERS_*_API_BASE` 环境变量覆盖各平台 API base（NewRegistryWithBases）。
- [x] 无障碍基础：`:focus-visible` 统一焦点样式；真实 Tab 键走查焦点顺序。
- [x] 依赖升级专项：保留 react 19.3.0 / jsdom 30.1.0 / **typescript 7.0.2**；回退 vite 8 / plugin-react 6 / vitest 5（生态不兼容，原因留档见 TEST_EVIDENCE PH4-008）。

### 修改文件

- `apps/relay/internal/turncreds/**`（新增）、`internal/httpapi/{iceapi,iceapi_test}.go`（新增）、`internal/providers/provider.go`（Bases/NewRegistryWithBases）、`internal/config/config.go`（Turn*/providers base 配置）、`cmd/relay/main.go`（接线）。
- `apps/web/src/media/webrtc/ice-config.ts`（运行时优先重构）、`features/room/{api.ts,RoomPage.tsx}`（iceApi + 拉取刷新循环 + 清理）、`features/providers/OAuthPanel.tsx`（弹窗拦截回退）、`test/ice-config.test.ts`（新增 6 例）、`app/styles.css`（focus-visible）。
- `scripts/mock-oauth-provider.mjs`（新增）、`scripts/smoke.mjs`（mock provider 进程编排 + OAuth 全流程/刷新/撤销 + ICE 端点 4 项）。
- `apps/relay/.env.example`（LISTO_TURN_*、LISTO_PROVIDERS_*）、`README.md`（TURN/mock OAuth 使用说明）。
- 依赖：`apps/web/package.json` + 各 packages（typescript ^7.0.2）、`package-lock.json`（干净重建）。
- `docs/{DECISIONS,PROVIDERS,TEST_EVIDENCE,HANDOFF}.md`。

### 验证与证据

- 命令（全部退出码 0）：`npm run typecheck`（TS 7，0 错误）、`npm test`（151 例：web 122/protocol 18/media 4/shared 7）、`node scripts/go.mjs vet/test ./...`（Go 11 包）、`npm run build`、`npm run smoke`（46 项 PASS ×2）。
- 浏览器 OAuth 全栈：mock 生命周期计数与 UI 状态逐步一致（详见 TEST_EVIDENCE PH4-007）。
- 敏感边界：TURN secret 不出服务端（测试断言）；mock OAuth 的 token 均为进程内自造值。

### 未完成与风险

- 真实 TURN 中继连通性仍需部署 coturn 后实测（凭据算法/下发形状已按标准向量与协议级测试验收）。
- vite 8 / vitest 5 / jest-dom 7 组合待上游修复后再评估（vitest 5.0.0 类型再导出破坏 jest-dom 模块增强）；TS 7 为大版本首升，如遇工具链问题可整体回退 ^5.9.3。
- mock provider 的 authorize 为"自动同意"，未模拟用户拒绝页（协议层 denied 路径已有单测覆盖）。

### 下一步

- 部署实践：coturn use-auth-secret 配置样例（README 可补）；真实双机/跨公网场景复测（沿用 Phase 2/3 记录的边界）。
- 可选：OAuth 面板显示 scope 授权详情、歌词翻译双行显示等增强（不影响出口条件）。

### 敏感信息检查

- [x] 没有提交密码、token、Cookie、真实本地路径或个人音频（TURN secret 在测试中为自造值 `smoke-turn-secret` 且不进日志/证据；mock OAuth token 全为进程内自造值）。

## 2026-09-12 / Phase 4 平台识别、OAuth 与安全加固

### 任务

- 阶段：Phase 4（平台识别、官方 OAuth 与安全加固）+ Phase 3 延伸体验增强（封面/歌词）
- 目标：可插拔平台识别、官方 OAuth（token 边界）、不可播放情况可解释可恢复；封面全员显示与歌词同步高亮。
- 对应 checklist：`docs/phases/phase-4-provider-and-hardening.md`（9 项功能 + 2 项体验增强全部完成并勾选）。

### 已完成

- [x] 文档先行：DECISIONS 新增 D-014（provider 服务端解析/SSRF 白名单/播放能力语义/降级）、D-015（OAuth AC+PKCE、token 只存 Relay 内存、打码输出）、D-016（封面 DataChannel 分块/512KB/发送时机）、D-017（TRACK_LYRICS/Relay 缓存/48KB 上限）；技术设计新增"平台识别、OAuth 与安全加固（Phase 4 实现设计）"。
- [x] 协议扩展（canonical schema 单一来源）：`TRACK_LYRICS` 事件、`trackSource`（platform/url/externalId/playability/coverUrl）、错误码 `LYRICS_TOO_LARGE`；TS 类型与 Go payload/严格解码同步，parity 测试通过。
- [x] Go providers 包：`Provider` 接口 + Registry（`Add` 可扩展）+ netease/qqmusic/spotify/ytmusic 适配器；URL 规范化与 web 端双实现同矩阵测试；SSRF 防护（https+域名白名单+拨号 IP 校验拒绝私网/回环/CGNAT/ULA+重定向白名单+1MB 上限+8s 超时）；`POST /api/rooms/{roomId}/links/resolve`（仅房主+限流 10/分）。
- [x] Go oauth 包：Authorization Code + PKCE(S256)、state 一次性绑定会话哈希（10min TTL）、token 内存存储、refresh 轮换、撤销、会话失效 Sweep 释放、userLabel 打码；`/api/oauth/{providers,start,callback,disconnect}`；未配置时优雅降级。真实平台（Spotify）因网络封锁+无凭证不可联调，以本地 mock provider 全流程自动化验收（PROVIDERS.md P-006）。
- [x] Go 房间歌词：host 发布→校验（48KB/500 行/单行 512B，超限 LYRICS_TOO_LARGE）→LRU 50 缓存→转发；挂载/切歌补发；不进快照不占 revision。
- [x] 加固：HTTP panic recovery 中间件、房间 actor 与 ws 写泵 goroutine panic 隔离、解析限流（滑动窗口）、消息大小边界（WS 64KB 已有/请求体 8KB 已有/歌词 48KB 新增）；README「隐私与数据边界」。
- [x] Web：链接规范化即时校验 + LinkResolver 卡片（识别→可用性→加入曲库→平台徽章/降级提示）；OAuthPanel（未配置/已配置未连接/已连接打码标识）；封面 DataChannel（分块 JSON 帧、canvas 压缩 ≤512KB、(成员,trackId) 去重、新通道清去重重发、成员 LRU 缓存+占位）；歌词（LRC 解析/同名自动检测/手动指定/发布乐观更新/LyricsPanel 行级 aria-current 高亮）；Media Session（播放/暂停/跳过/seekto/positionState）与 wake lock；曲库条目平台徽章与"指定歌词/更换歌词"。
- [x] 真实平台联调：netease/QQ 真实 API 全链路可用（元数据+时长+封面+可用性）；Spotify/YouTube 本机不可达，解析失败 5-8s 内可解释返回。全部实测记录在 `docs/PROVIDERS.md`（P-001~P-011，含失败经验）。
- [x] 冒烟扩展至 41 项 PASS（新增 12 项 Phase 4 离线可判定流程）；浏览器 E2E 双成员验证封面/歌词/平台降级全链路。

### 修改文件

- `packages/protocol/schema/envelope.schema.json`、`src/types.ts`：TRACK_LYRICS、trackSource、LYRICS_TOO_LARGE。
- `apps/relay/internal/providers/**`（新增）：provider.go（接口/Registry/safeClient/fetchJSON）、netease.go、qqmusic.go、spotify.go、ytmusic.go、providers_test.go。
- `apps/relay/internal/oauth/**`（新增）：oauth.go（Manager/PKCE/token 生命周期）、oauth_test.go（mock provider 全流程）。
- `apps/relay/internal/room/{room,playback,lyrics,lyrics_test}.go`：歌词缓存/路由/补发；`hub/hub.go`：SessionExistsByHash；`ws/handler.go`：写泵 recover；`cmd/relay/main.go`：装配 providers/oauth/recovery。
- `apps/relay/internal/httpapi/{resolveapi,oauthapi,recover,resolveapi_test}.go`（新增）：解析端点/OAuth 端点/panic recovery/测试。
- `apps/relay/internal/protocol/{protocol,payload,payload_test}.go`：新事件与边界。
- `apps/relay/.env.example`：LISTO_RELAY_PUBLIC_BASE_URL、LISTO_OAUTH_* 占位。
- `apps/web/src/features/providers/**`（新增）：normalize.ts、api.ts、LinkResolver.tsx、OAuthPanel.tsx。
- `apps/web/src/features/room/{library,use-host-library,lyrics,LyricsPanel,LibraryPanel,RoomPage}`：source 字段/封面字节/歌词导入与发布/面板集成/平台降级文案/DEV 钩子 `__listoImportAudioSet`。
- `apps/web/src/media/**`：cover-channel.ts（新增）、media-session.ts（新增）、wake-lock.ts（新增）、host-audio.ts（封面发送）、member-audio.ts（onDataChannel）、webrtc/{peer-targets,member-peer}（DataChannel）、local-source/buffer-source.ts（stripId3v2）、wiring.ts（封面收发接线）。
- `apps/web/src/transport/ws/room-store.ts`：TRACK_LYRICS 状态/发布、歌词乐观更新。
- `apps/web/src/test/phase4-{units,ui}.test.tsx`（新增 47 例）。
- `scripts/smoke.mjs`（+12 项）、`scripts/gen-phase4-assets.mjs`（新增，测试资源生成器）。
- `docs/{DECISIONS,03-technical-design,TEST_EVIDENCE,HANDOFF,PROVIDERS}.md`、`docs/phases/phase-4-provider-and-hardening.md`、`README.md`、`docs/evidence/phase4/*`。

### 验证与证据

- 命令（全部退出码 0）：`npm run typecheck`、`npm test`（TS 141 例）、`node scripts/go.mjs vet ./...`、`node scripts/go.mjs fmt ./...`、`node scripts/go.mjs test ./...`（Go 10 包）、`npm run build`、`npm run smoke`（41 项 PASS）。
- 真实平台联调：网易/QQ 全链路成功（643ms/147ms 完整元数据）；Spotify 不可达可解释失败（详见 PROVIDERS.md P-008）。
- 浏览器端到端（双标签页）：成员端封面解码显示（naturalWidth=32）、起播 2.4s 第一句高亮（音频电平 0.26）、重连后歌词/封面补发、网易云真实识别入曲库（平台徽章+降级提示）、Spotify 识别可解释失败、平台曲目入队衔接失败自动跳过（历史"播放失败"）、OAuth 面板未配置降级。
- 证据：`docs/evidence/phase4/{e2e-member-cover-lyrics,e2e-host-playing}.png` + `docs/TEST_EVIDENCE.md` PH4-001 ~ PH4-005 + `docs/PROVIDERS.md`。

### 未完成与风险

- 真实 OAuth 端到端（Spotify 等）未验证：本机网络封锁 + 无开发者凭证（P-006）。启用方式已就绪（环境变量），首次联调建议在有海外网络与注册应用的机器上进行；当前等价验收为 mock provider 全流程。
- QQ 音乐/网易 API 为非官方公开接口：无 SLA，字段或限流策略可能变化；适配器已把"空数据/非 200"映射为可解释状态，失效时表现为明确的 PROVIDER_UNAVAILABLE 而非误报成功。
- TURN 短期凭据（D-010 列入 Phase 4 的 coturn REST 凭据）**未实现**：本机无 TURN 服务器可验证，VITE_ICE_SERVERS 静态注入仍可用；生产部署前需补 coturn use-auth-secret 方案（已记录为遗留）。
- 歌词/聊天/房间状态仍为 Relay 内存态（重启即失，既有决策）；歌词缓存每房间 50 条 LRU，超出后最早条目不再补发（可接受）。
- E2E 环境限制：IAB 双媒体标签页下截图管道易超时（截图 2/3 成功，其余以文本断言记录）；HMR 热重载会触发 disconnect 钩子（仅开发环境）。移动端后台播放只做了 wake lock + Media Session，iOS 低电量模式等真实设备行为未测（无设备）。
- 浏览器无障碍为"基础检查"级：aria-current/aria-label/键盘焦点可用，未做屏幕阅读器完整走查。
- E2E 中修复的 `stripId3v2` 值得关注：仅对文件头 ID3v2 生效（ID3v1 尾标不影响解码，无需处理）。

### 下一步

- 可选增强（不影响出口条件）：点歌配额/冷却参数可配置、队列拖拽排序、TURN 短期凭据部署实践、跨大版本依赖升级专项（vite 8/vitest 5/typescript 7/jsdom 30）、真实设备移动端后台播放实测。
- 如需接入更多平台：实现 `providers.Provider` 接口 + `Registry.Add` 注册即可（URL 规范化 fixture 同步到 web 端 normalize.ts 与两端测试）。

### 敏感信息检查

- [x] 没有提交密码、token、Cookie、真实本地路径或个人音频（OAuth token 仅存在于测试进程内存与 mock 字符串，均为自造值；E2E 音频/封面为脚本合成；`.env.example` 仅占位；截图与证据 JSON 不含凭证）。

## 2026-09-05 / 文档基线

### 任务

- 阶段：Phase 0（文档与结构准备）
- 目标：固化产品范围、架构决策、阶段 checklist、协作规范和证据链要求。
- 对应 checklist：文档基线，不涉及应用实现。

### 已完成

- [x] 建立 `AGENTS.md`，包含目录约定、自检要求和证据链规则。
- [x] 建立产品概览、架构/同步模型和阶段总览。
- [x] 建立具体技术设计，确定 Go Relay、TypeScript/React 前端和 WebRTC 媒体边界。
- [x] 建立 Phase 0 至 Phase 4 阶段任务文档。
- [x] 建立决策记录、交接模板和测试证据模板。

### 验证与证据

- 命令：基线文件存在性和 README 相对链接检查脚本。
- 结果：通过；`files=14 missing=0 readme_links=9 broken_links=0`。
- 证据：补充到 `docs/TEST_EVIDENCE.md`。
- 追加检查：旧同步规则关键词检查通过；`stale_sync_rules=0`。

### 未完成与风险

- 尚无应用代码、依赖或可运行服务。
- Relay、TURN 和本地音频到 WebRTC 的具体库尚未选定。

### 下一步

- 执行 Phase 0，建立工程骨架和协议 schema。

### 敏感信息检查

- [x] 文档未包含真实密码、token、Cookie 或个人文件内容。

## 2026-09-05 / Phase 0 工程骨架

### 任务

- 阶段：Phase 0（项目基础与协议基线）
- 目标：建立可启动的工程骨架、统一协议 schema、环境配置和测试证据流程。
- 对应 checklist：`docs/phases/phase-0-foundation.md`（7 项全部完成并勾选）。

### 已完成

- [x] 根 workspace（npm workspaces）+ 五个模块：`apps/web`、`apps/relay`、`packages/protocol`、`packages/shared`、`packages/media`。
- [x] 协议单一来源 `packages/protocol/schema/envelope.schema.json`：信封（v/roomId/senderId/revision 等元数据）、15 个 MVP 事件的 payload 定义（if/then 绑定）、11 个错误码、角色/成员状态/房间快照定义。
- [x] TS 侧：类型 + ajv 校验器 + 31 个测试（协议 16、shared 脱敏 7、media 4、web 4）。
- [x] Go 侧：Relay 服务（`/healthz` + CORS、`/ws` 信封校验拒绝路径、slog JSON 日志 + 敏感字段脱敏、环境变量配置、优雅关闭）+ 五个包的单元测试 + 与 canonical schema 的 parity 测试。
- [x] Web 客户端：React + Vite 首页，自动探测 Relay `/healthz` 并显示连接状态。
- [x] 脚本：`scripts/go.mjs`（go 路径解析，支持 `LISTO_GO_BIN`）、`scripts/smoke.mjs`（一键冒烟：构建、启动两个服务、健康检查、CORS、关闭）。
- [x] 示例配置 `apps/relay/.env.example`、`apps/web/.env.example`（无真实密钥）。

### 修改文件

- `package.json`、`tsconfig.base.json`、`.gitignore`：根 workspace 与脚本。
- `packages/protocol/**`：schema、src（schema-source/types/error-codes/validate）、test、包配置。
- `packages/shared/**`：redact 脱敏工具 + 测试。
- `packages/media/**`：`LocatableAudioSource` 接口、`driftExceedsTolerance` + 测试。
- `apps/relay/**`：go.mod/go.sum、cmd/relay/main.go、internal/{config,logging,protocol,httpapi,ws} 及测试、.env.example。
- `apps/web/**`：Vite/React 骨架、RelayHealth 组件、测试、.env.example。
- `scripts/go.mjs`、`scripts/smoke.mjs`：工具脚本。
- `README.md`：快速启动、命令表、项目结构、配置与敏感信息规则。
- `docs/03-technical-design.md`：目录说明同步（protocol 包结构、Go 校验位置）。
- `docs/phases/phase-0-foundation.md`：checklist 勾选与实现说明。
- `docs/TEST_EVIDENCE.md`：PH0-001 ~ PH0-005 证据记录。

### 验证与证据

- 命令与退出码（全部通过）：`npm install`、`npm run typecheck`、`npm test`（31 例）、`go vet ./...`、`go test ./...`、`gofmt -l .`（无输出）、`npm run build`、`npm run smoke`。
- 冒烟输出：relay `/healthz` 返回 ok + 版本；CORS 白名单回显；web 首页 200。
- 详细记录见 `docs/TEST_EVIDENCE.md` PH0-001 ~ PH0-005（含两轮真实失败与修复过程：Go payload 形状校验缺口、冒烟脚本 go build 工作目录与 Vite IPv4 绑定）。

### 未完成与风险

- 仓库尚未 `git init`，无提交记录；首个提交应在下一个任务开始前完成。
- 本机 Go 为 windows/386（32 位）且不在 PATH；`scripts/go.mjs` 已兼容，但换机器需设置 `LISTO_GO_BIN` 或 PATH。proxy.golang.org 不可达，已用 `GOPROXY=https://goproxy.cn,direct` 下载依赖（依赖已缓存，后续构建可离线）。
- `NEXT_TRACK_PREPARE` 的 `startAtMs` 晚于 `prepareDeadlineMs` 只有语义约定，schema 未强制（JSON Schema 无法表达跨字段比较）；Phase 1 房间逻辑需加运行时校验。
- Go 侧目前只校验信封结构，payload 字段级校验依赖 schema（TS 侧）；Phase 1 房间 actor 需按事件做语义校验。
- web 首页的 Relay 地址经 Vite 环境变量注入，仅构建/启动时生效。

### 下一步

- 进入 Phase 1（房间与控制面）：邀请 token 与会话、房间 actor 串行 command loop、revision 单调性（STALE_REVISION 拒绝落进真实消息流）、成员/权限事件、双浏览器端到端加入。
- 建议先在 DECISIONS.md 补充：邀请链接与 token 的具体形态（一次性 vs 可复用）、WebSocket 鉴权握手格式。

### 敏感信息检查

- [x] 没有提交密码、token、Cookie、真实本地路径或个人音频。

## 2026-09-05 / Phase 1 房间与控制面

### 任务

- 阶段：Phase 1（房间与控制面）
- 目标：建房/邀请链接加入、成员与权限、可靠同步与重连恢复，两个浏览器可见一致房间状态。
- 对应 checklist：`docs/phases/phase-1-room-control.md`（8 项全部完成并勾选）。

### 已完成

- [x] 文档先行：`DECISIONS.md` 新增 D-007（邀请 token/密码凭证形态）、D-008（HTTP 换会话 + WS 握手格式）、D-009（断线宽限/3001 显式离开/房主转移/房间生命周期）；`03-technical-design.md` 补充 HTTP API 表、权限矩阵、revision 规则、屏障运行时校验、连接健康参数、TLS/部署说明。
- [x] Go Relay：`internal/auth`（128 位 token + SHA-256 哈希、PBKDF2 密码）、`internal/room`（串行 actor：成员/角色/revision/播放权威/下一首屏障/presence/房主转移/慢消费者断开）、`internal/hub`（房间/会话管理、join 校验、Sweep 清理）、`internal/httpapi` 房间 REST（建房/加入/信息/锁房/踢人/授权/关房 + CORS）、`internal/ws`（升级前会话校验、信封校验路由、senderId 会话覆写、单写者写泵 + PING 保活、3001/4001/4002/4003 关闭码）。
- [x] Web 客户端：极简路由 + `HomePage`（建房）/`JoinPage`（邀请链接解析与错误提示）/`RoomPage`（成员/播放/屏障/房主管理/邀请链接复制）；`transport/ws/room-store.ts`（重连退避 + 心跳 + 协议应用 + 服务器时钟换算）；连接状态横幅、自动播放限制说明、会话失效致命提示。
- [x] 权限模型：PLAY/PAUSE/SEEK 仅房主；NEXT_TRACK_PREPARE 房主+共同 DJ；READY/RESYNC 全员；管理操作仅房主；全部在房间 actor 内以成员记录判定，不信任客户端自报。
- [x] Phase 1 播放器状态模型：currentTrack/playing/positionMs（服务端按时钟外推）+ 队列占位；进度只在切歌/暂停/拖动/加入/重连/手动同步时广播（AGENTS §4）。

### 修改文件

- `apps/relay/internal/{auth,room,hub,ws,httpapi,protocol,config}/**`：房间控制面全部实现与测试；`cmd/relay/main.go` 装配 + 直连 TLS。
- `apps/web/src/{app,features/room,transport/ws,ui}/**`：页面、RoomStore、会话/邀请工具、样式与测试。
- `scripts/go.mjs`：固定以 apps/relay 为工作目录（修复从根目录调用失败）；`scripts/smoke.mjs`：扩展双 WS 房间流程（13 项 PASS）。
- `apps/relay/.env.example`：新增 MAX_MEMBERS / OFFLINE_TTL_SECONDS / TLS 证书项。
- `docs/DECISIONS.md`、`docs/03-technical-design.md`、`docs/phases/phase-1-room-control.md`、`docs/TEST_EVIDENCE.md`、`README.md`。

### 验证与证据

- 命令（全部退出码 0）：`npm run typecheck`、`npm test`（TS 56 例）、`npm run test:relay`（Go 8 包）、`npm run vet:relay`、`go fmt`（无 diff）、`npm run build`、`npm run smoke`（13 PASS）。
- 浏览器端到端（双标签页独立会话）：建房→邀请链接加入→下一首屏障统一开始（两端 0:47 一致）→暂停/恢复同步（0:19/0:20）→成员页刷新恢复（0:29）→重新同步（6:10/6:11）→房主离开转移（新房主获得全部控制权）。
- 证据：`docs/evidence/phase1/*.png`（4 张）+ `docs/TEST_EVIDENCE.md` PH1-001 ~ PH1-006。

### 未完成与风险

- 「互联网」验证边界：E2E 在本机双标签页完成（等同两个独立会话/两个网络连接的客户端逻辑），未做真实跨公网验证；公网部署需按技术设计启用 WSS/反代，`LISTO_RELAY_TLS_CERT/KEY` 已支持直连 TLS。
- 重连成员从快照看不到进行中屏障的曲目元数据（schema 快照无“下一首”字段），仅显示就绪计数；Phase 2 扩展快照时补齐。
- 屏障 deadline 到达后仅广播快照供房主决策，没有“强制开始”事件；房主通过重发 PREPARE 或踢人推进（已在设计文档写明）。
- `RESYNC_REQUEST` 在 Phase 1 只补发快照并转发房主（无媒体可重建）；会话失效时浏览器侧拿不到 401 状态码，客户端以 10 次有限重试后提示重新加入。
- Relay 重启即失去全部房间（内存态，已知限制，Phase 4 前不引入持久化）。
- E2E 期间修复的两个缺陷值得 Phase 2 回归关注：①非 3001 断线一律走 offline 宽限（后台标签页冻结不再踢人）；②卸载用 disconnect()、只有离开按钮发 3001；③屏障期快照必须携带 transitionId（有 Go 回归测试）。

### 下一步

- Phase 2（WebRTC 音频与同步屏障）：房主本地文件 → 可定位音频源 → MediaStreamAudioDestinationNode → 每成员 PeerConnection；Relay 信令转发已就绪（OFFER/ANSWER/ICE 已可路由）；把 Phase 1 的“自动 READY”替换为真实缓冲就绪。
- 建议 Phase 2 先在 DECISIONS.md 确认 TURN 凭据注入方式与 AudioContext 解锁策略。

### 敏感信息检查

- [x] 没有提交密码、token、Cookie、真实本地路径或个人音频（截图中的 token 属一次性测试房间且已随房间关闭失效）。

## 2026-09-06 / Phase 2 WebRTC 音频与同步屏障

### 任务

- 阶段：Phase 2（WebRTC 音频与同步屏障）
- 目标：房主本地文件经 WebRTC 实时分享给成员；仅下一首走准备屏障并按统一时间开播；暂停/拖动/重连不强制等待；迟到/卡顿成员手动重新同步；房间不被单个成员阻塞。
- 对应 checklist：`docs/phases/phase-2-media-sync.md`（11 项全部完成并勾选）。

### 已完成

- [x] 文档先行：DECISIONS 新增 D-010（ICE 配置经 `VITE_ICE_SERVERS` 构建期注入，默认公共 STUN；TURN 生产凭据方案列为 Phase 4）、D-011（音频同步口径：房主 AudioContext 调度统一开始、成员实时收流、READY=媒体管道就绪、重新同步=按成员重建音频段、屏障超时强制开始）；技术设计重写“WebRTC 媒体流程（Phase 2 实现设计）”并新增“实现要点与已知限制”。
- [x] 协议扩展：快照可选 `pendingPrepare` 字段（schema + TS 类型 + Go 结构），重连成员可恢复屏障元数据并上报 READY（补齐 Phase 1 遗留）。
- [x] Go Relay：快照携带屏障元数据；`NEXT_TRACK_START` 支持房主/共同 DJ 屏障超时强制开始（transitionId 必须匹配、越权拒绝）；新增 3 个 room 单测。
- [x] Web 媒体层（`apps/web/src/media/`）：本地文件解码为 AudioBuffer（LocatableAudioSource 实现）、调度换算纯函数、ICE 配置解析、房主/成员 PeerConnection 管理、房主音频段调度（每成员独立 dest 节点 + 本地监听）、成员解锁/音量/静音/健康检查、`wiring` 接线层。
- [x] RoomStore：服务端信封订阅（媒体层消费信令）、`notifyBarrierMediaReady()`（媒体就绪后上报 READY，去重）、`forceStartBarrier()`、快照 `pendingPrepare` 恢复、`lastCompletedPrepare` 供媒体对齐、迟到判定（连接后首个快照一次）。
- [x] RoomPage：房主本地文件选择与解码、屏障超时“立即开始（跳过未就绪成员）”、成员“启用声音”/音量/静音/音频状态卡、迟到横幅 + 重新同步、`window.__listo` 调试状态（证据采集）。
- [x] E2E（三标签页=三成员，合成测试音）：双端真实音频流动（RMS 0.278~0.290）、统一开始首音滞后 112/198ms、显示偏差 -22ms、暂停位置两端完全一致、恢复 4ms、拖动不触发屏障、迟到成员横幅+不自动出声+重新同步接入、屏障超时强制开始（自动化）。
- [x] E2E 中发现并修复 4 个真缺陷：①房主侧未路由收到的 WEBRTC_ANSWER/ICE_CANDIDATE（ICE 卡 connecting）；②Chromium 远端 MediaStream 需 muted `<audio>` 元素唤醒解码管线（否则 WebAudio 恒静音，实验数据见 PH2-003）；③迟到判定误伤一直在收听的成员（改为连接后首个快照判定一次）；④刷新后房主 currentBuffer 为空导致播放/拖动静默无效（加载文件自动晋升当前缓冲）。

### 修改文件

- `packages/protocol/schema/envelope.schema.json`、`packages/protocol/src/types.ts`：快照 `pendingPrepare`。
- `apps/relay/internal/{protocol/payload.go,room/room.go,room/playback.go,room/room_test.go}`：屏障元数据快照、强制开始、3 个新测试。
- `apps/web/src/media/**`（新增 `audio-clock.ts`、`local-source/buffer-source.ts`、`webrtc/{ice-config,peer-targets,member-peer}.ts`、`host-audio.ts`、`member-audio.ts`、`wiring.ts`）：媒体层全部实现。
- `apps/web/src/transport/ws/room-store.ts`：信封订阅、READY 门控、强制开始、迟到判定、快照屏障恢复。
- `apps/web/src/features/room/RoomPage.tsx`、`apps/web/src/app/HomePage.tsx`、`apps/web/src/vite-env.d.ts`、`apps/web/.env.example`：UI 与配置。
- `apps/web/src/test/{room-store.test.ts,pages.test.tsx,media-units.test.ts}`：测试更新与新增。
- `scripts/smoke.mjs`：Phase 2 流程（屏障元数据/强制开始/信令转发，18 项 PASS）；`scripts/gen-test-audio.mjs`（新增，合成测试音）；`.gitignore`（测试音排除）。
- `docs/{DECISIONS.md,03-technical-design.md,TEST_EVIDENCE.md,phases/phase-2-media-sync.md}`、`README.md`。

### 验证与证据

- 命令（全部退出码 0）：`npm run typecheck`、`npm test`（TS 69 例：web 42 / protocol 16 / media 4 / shared 7）、`node scripts/go.mjs vet ./...`、`node scripts/go.mjs fmt ./...`、`node scripts/go.mjs test ./...`（Go 8 包）、`npm run build`、`npm run smoke`（18 PASS）。
- 浏览器端到端（`docs/evidence/phase2/*.png|json` 9 个文件）：双端真实音频、统一开始、暂停/拖动同步、迟到成员重新同步接入；详细记录 `docs/TEST_EVIDENCE.md` PH2-001 ~ PH2-007。
- 手工场景关键数据：屏障统一开始首音滞后 112/198ms（WebRTC 传输+抖动缓冲）；双端显示位置偏差 -22ms；暂停位置 39814ms 完全一致；恢复后 4ms；迟到成员重新同步前 level=0、之后 0.2826。

### 未完成与风险

- TURN 未在真实服务器验证（本机无 TURN 服务）：`VITE_ICE_SERVERS` 解析有单测，直连路径已验证；TURN 中继路径与凭据轮换列为 Phase 4。
- “双浏览器”为同一浏览器实例的三个独立标签页（独立 sessionStorage 会话、独立 PeerConnection），未做跨设备/跨公网验证；公网需 WSS/反代与 TURN，部署说明已在技术设计。
- 曲目播到结尾：音频段自然结束静音，控制面位置继续外推，不自动切歌（Phase 3 队列衔接点，已记录）。
- 房主转移后新媒体权威需重新加载同一本地文件才恢复出声（D-011 已知限制）；共同 DJ 在 Phase 2 UI 不提供切歌入口（音频由房主本地文件决定，Phase 3 队列解决），协议层权限不变。
- IAB 后台标签页约 90s 被挂起导致 WS 断开：宽限+重连按设计恢复，但重连 10 次失败后进入致命状态需手动刷新；真实浏览器影响较小，Phase 4 可考虑“致命后引导一键重连”。
- E2E 使用 DEV 钩子 `__listoLoadAudio` 注入音频（自动化无法操作系统文件选择器）；生产构建不含该钩子，文件选择器路径与钩子共用同一 `loadFile` 实现。

### 下一步

- Phase 3（队列与本地文件）：点歌/队列管理/审批与“曲目结束自动衔接下一首”（消除曲目结束静音边界）；队列条目与本地文件的绑定（房主文件选择体验）；共同 DJ 点歌与审批流。
- 建议 Phase 3 先在 DECISIONS.md 确认：队列条目如何引用本地文件（文件指纹/会话内句柄）、缺席房主时队列歌曲的降级策略。

### 敏感信息检查

- [x] 没有提交密码、token、Cookie、真实本地路径或个人音频（E2E 音频为脚本生成的合成测试音，已加入 .gitignore；证据 JSON/截图不含凭证与本地路径）。

## 2026-09-06 / Phase 2 补充：黑夜模式主题

### 任务

- 阶段：Phase 2 补充（用户需求小功能）
- 目标：前端添加黑夜模式主题，跟随系统偏好为默认，用户可手动切换并持久化。
- 对应 checklist：不涉及阶段 checklist；证据记录 `docs/TEST_EVIDENCE.md` PH2-008。

### 已完成

- [x] `apps/web/src/ui/theme.ts`：主题辅助（resolveInitialTheme/applyTheme/currentTheme/toggleTheme，依赖可注入便于测试）；初始主题=已保存选择 > 系统深色偏好。
- [x] `apps/web/src/ui/ThemeToggle.tsx`：右上角固定切换按钮（🌙/☀️，aria-label 随主题），App.tsx 挂载使其在所有页面可用。
- [x] `apps/web/src/app/styles.css`：颜色全量改为 CSS 变量，`:root` 浅色 / `:root[data-theme="dark"]` 深色；补 `color-scheme`（原生滚动条/控件）与 `accent-color`（复选框/滑块随主色）。
- [x] `apps/web/src/main.tsx`：首帧渲染前应用主题，避免深色用户闪白。
- [x] 测试：`apps/web/src/test/theme.test.ts` 7 例（偏好优先级、非法值回退、切换持久化、存储不可用容错、data-theme 写入读回）。

### 修改文件

- 新增 `apps/web/src/ui/theme.ts`、`apps/web/src/ui/ThemeToggle.tsx`、`apps/web/src/test/theme.test.ts`；修改 `apps/web/src/{main.tsx,app/App.tsx,app/styles.css}`。

### 验证与证据

- 命令：`npm run typecheck`（退出码 0）；`npx vitest run`（apps/web 49 例通过 = 原 42 + theme 7）。
- 浏览器实测：默认跟随系统进入深色 → 切换浅色（localStorage saved=light）→ 房间页两种主题渲染正常（横幅/卡片/徽章/提交按钮对比度正常）→ 刷新后主题保持。
- 证据：`docs/evidence/phase2/{theme-dark-home,theme-light-home,theme-light-room,theme-dark-room}.png`。

### 未完成与风险

- 无功能风险；深色配色为人工选取，如有品牌色要求可在 `styles.css` 变量集中调整。

### 下一步

- 随 Phase 3 一起演进（新页面/组件直接使用既有变量即可）。

### 敏感信息检查

- [x] 没有提交密码、token、Cookie、真实本地路径或个人音频。

## 2026-09-11 / Phase 3 队列、点歌与本地文件

### 任务

- 阶段：Phase 3（队列、点歌与本地文件体验）
- 目标：多人点歌审批闭环、共享队列管理、房主队列播放衔接、本地文件导入体验与持久化、聊天与投票跳过。
- 对应 checklist：`docs/phases/phase-3-queue-and-local-files.md`（9 项全部完成并勾选）。

### 已完成

- [x] 文档先行：DECISIONS 新增 D-012（队列/房间曲库/点歌模型：曲库仅元数据、trackId 绑定、审批与插队规则、冷却/配额、房主为队列播放执行者、TRACK_FINISHED 历史与失败自动跳过）、D-013（聊天/反应不进快照不占 revision、连接时单发 CHAT_HISTORY、投票跳过过半通过由房主端自动执行）；技术设计新增"队列、点歌与聊天（Phase 3 实现设计）"章节（事件表、队列状态机、房主执行循环、本地文件体验）。
- [x] 协议扩展（canonical schema 单一来源）：13 个新事件 + DUPLICATE_TRACK 错误码 + 快照扩展（playMode/library/queueEntry 形态的 queue/pendingRequests/history/skipVotes）；TS 类型与 Go payload 结构/严格解码同步，parity 测试通过。
- [x] Go Relay：房间 actor 新增曲库/点歌/审批/排序/清空/投票/历史/播放模式/聊天处理（`internal/room/queue.go`），屏障完成按 trackId 移除任意位置队列条目并记录当前条目点歌人；16 个新单测覆盖权限/阈值/幂等/限流/失败跳过。
- [x] Web 媒体层：`HostAudioController.stageFile`（屏障按 trackId 暂存解码缓冲 + 解码缓存）、自然播完检测（onended 区分主动停止）、`wireHostMedia` 接收任意成员发起的 PREPARE 时解析房主本机文件并门控 READY、缺文件明确提示不上报 READY。
- [x] Web 客户端：`features/room/library.ts` + `use-host-library.ts`（trackId 生成、ID3v2 标签/封面解析、拖放文件/文件夹导入、失败逐文件提示、localStorage 持久化、名称+大小重绑定、导入导出 JSON）；`QueuePanel`（点歌区/待审批/队列/最近记录/排序/跳过/清空/播放模式/投票）、`LibraryPanel`（房主曲库管理）、`ChatPanel`（聊天与反应）；`RoomPage` 房主推进逻辑（自然播完/手动跳过/投票通过 → TRACK_FINISHED → 按模式衔接；失败自动跳过带重试上限；队列空自动暂停+提示）。
- [x] RoomStore：新事件处理（CHAT_HISTORY/CHAT_MESSAGE/快照新字段）+ 全部队列动作 + 发送后乐观递增本地 revision（修复同一 tick 连发写事件的 STALE_REVISION 自竞态，已记入技术设计）。
- [x] 冒烟脚本扩展至 29 项 PASS（新增 11 项 Phase 3 流程）。
- [x] 三标签页浏览器 E2E：点歌→审批→排序→投票跳过（房主自动执行）→手动跳过→短曲自然播完→队列空自动暂停→聊天与反应；截图与三端终态 JSON 已存证。

### 修改文件

- `packages/protocol/schema/envelope.schema.json`、`packages/protocol/src/types.ts`：Phase 3 事件与快照扩展。
- `apps/relay/internal/protocol/{protocol,payload}.go`：新事件常量、payload 结构与解码。
- `apps/relay/internal/room/{room,playback,queue}.go`：房间状态扩展、路由、Phase 3 处理器；`room/queue_test.go`（新增 16 例）、`ws/handler_test.go`（readEnvelope 跳过 CHAT_HISTORY 辅助消息）。
- `apps/web/src/transport/ws/room-store.ts`：新状态/事件/动作 + 乐观 revision。
- `apps/web/src/media/{host-audio,wiring}.ts`：stageFile/解码缓存/onTrackEnded/HostFileResolver。
- `apps/web/src/features/room/{library.ts,use-host-library.ts,LibraryPanel.tsx,RoomPage.tsx}`（新增/重写）、`features/queue/QueuePanel.tsx`、`features/chat/ChatPanel.tsx`（新增）、`ui/format.ts`（formatMs 迁出）、`app/styles.css`（新组件样式）。
- `apps/web/src/test/{room-store,queue-panel,library,pages}.test.ts(x)`：更新与新增（web 69 例）。
- `scripts/smoke.mjs`：Phase 3 流程 + waiter 超时修复；`packages/protocol/test/envelope.test.ts`：28 事件样例。
- `docs/{DECISIONS,03-technical-design,TEST_EVIDENCE,HANDOFF}.md`、`docs/phases/phase-3-queue-and-local-files.md`、`README.md`、`docs/evidence/phase3/*`。

### 验证与证据

- 命令（全部退出码 0）：`npm run typecheck`、`npm test`（TS 96 例：web 69 / protocol 16 / media 4 / shared 7）、`node scripts/go.mjs vet ./...`、`node scripts/go.mjs fmt ./...`、`node scripts/go.mjs test ./...`（Go 8 包，含 queue_test.go 16 例）、`npm run build`、`npm run smoke`（29 项 PASS，连续两轮稳定）。
- 浏览器端到端（三标签页 = 三成员，合成测试音）：曲库导入广播、屏障统一开始（成员 firstAudioLagMs 125/126ms、房主 2/2 PeerConnection serving）、成员点歌→待审批→批准入队、排序（上移/下移）、投票跳过 2/3 票通过且房主端自动衔接、短曲自然播完→TRACK_FINISHED(played)→队列空自动暂停+"队列已播完"提示、聊天文本+反应三端一致；成员端无管理按钮、点歌区 2 条、投票按钮可见（权限分离）。
- 证据：`docs/evidence/phase3/{e2e-host-playing-b,e2e-host-natural-end-paused,e2e-member-history-chat}.png` + `e2e-state.json`（三端终态）+ `docs/TEST_EVIDENCE.md` PH3-001 ~ PH3-005。

### 未完成与风险

- 「互联网」验证边界同 Phase 2：E2E 在本机三标签页完成（独立会话/独立 PeerConnection），未做真实跨公网验证；公网需 WSS/反代与 TURN（Phase 4）。
- 封面（APIC）只在持有文件的房主端显示，不进协议（快照体积与隐私考虑）；成员端封面列为后续增强（可经 WebRTC dataChannel 传输）。
- 聊天仅内存保留（Relay 重启即失），不持久化、不进快照——D-013 已记录；房间重启后曲库/队列同样丢失（Relay 内存态，Phase 4 前不引入持久化）。
- ID3 解析仅覆盖 mp3（v2.3/2.4 的 TIT2/TPE1/APIC）；flac/m4a 等标签解析回退文件名，未做。
- E2E 环境限制：IAB 会周期性回收标签页（两次音频播放约 20 余秒后三标签页同时 about:blank，relay 日志仅见正常 offline；与 Phase 2 记录的"后台标签页挂起"同源但更激进）。场景已压缩至单次自动化调用完成；崩溃后重新加入即恢复（D-009 路径再次验证）。真实浏览器场景预计不受影响，但建议 Phase 4 在真实浏览器复测长时播放。
- 队列播放衔接的连续失败上限为"队列长度"（客户端内存态，刷新后重置）；极端情况下房主刷新可能再次尝试缺失文件的条目各一次（每次失败仍会自动跳过，不阻塞房间）。
- 共同 DJ 发起切歌时，若房主本机缺对应文件，房主端不 READY 并提示"缺少音频文件"，屏障会超时——共同 DJ 可强制开始或撤销该请求；UI 已提示但无自动引导，可后续优化。

### 下一步

- Phase 4（官方平台识别、OAuth 与安全加固）：TURN 短期凭据（D-010 列入）、外部链接可播放性状态、限流与部署加固；建议顺带评估成员端封面经 dataChannel 传输、房主"致命断线后一键重连"（Phase 2 遗留）。
- 可选增强（不影响出口条件）：队列条目拖拽排序（现为上移/下移按钮）、点歌配额/冷却参数可配置、聊天持久化。

### 敏感信息检查

- [x] 没有提交密码、token、Cookie、真实本地路径或个人音频（E2E 音频为脚本生成的合成测试音并已加入 .gitignore；曲库/队列只含元数据；证据 JSON/截图不含凭证与本地路径）。
