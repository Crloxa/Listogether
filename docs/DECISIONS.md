# 决策记录

本文档记录已经讨论并确认的产品/架构决策。新的方案应新增条目，不要覆盖历史内容。

## D-001：主要音频源是房主本地文件

- 状态：已确认
- 决策：MVP 以房主本地音频为主要来源，通过 WebRTC 发送给好友；Relay 不保存音频。
- 原因：满足朋友共享场景，避免要求每位成员拥有相同平台账号和音频源。
- 影响：迟到成员需要房主从可定位本地源重新生成带偏移的音频流；房主上行带宽随成员数增加。

## D-002：房主是播放权威

- 状态：已确认
- 决策：房主负责全房间播放、暂停、拖动和切歌；成员只控制本地音量、静音和重新同步。
- 原因：降低并发冲突，保证统一体验。

## D-003：仅下一首使用全员准备屏障

- 状态：已确认
- 决策：只有播放下一首时，全房间先缓冲并对齐到目标时间戳，ready 后按统一开始时间播放。当前歌曲的暂停、拖动和迟到不强制其他成员等待；正常播放不高频发送进度。
- 原因：把强一致性限制在自然的歌曲边界，避免房主操作造成全房间频繁中断。

## D-004：迟到成员只提示重新同步，下一首统一对齐

- 状态：已确认
- 决策：迟到或卡顿成员不自动改变当前歌曲进度，只显示提示并提供房间内重新同步按钮。全房间播放下一首时，当前在线成员统一缓冲、对齐时间戳并同时开始；断线成员不永久阻塞房间。

## D-005：互联网访问通过 Relay

- 状态：已确认
- 决策：房主和好友主动连接互联网 Relay，Relay 提供 WebSocket 控制/信令，并在需要时协助 WebRTC 建联。
- 原因：避免要求用户配置公网 IP、端口转发或防火墙。

## D-006：平台登录使用官方 OAuth

- 状态：已确认
- 决策：使用官方 OAuth（优先 PKCE）和最小权限；不接收密码，不把 token 放入房间或链接；不绕过 DRM、会员或地区限制。

## D-007：邀请 token 与房间凭证形态

- 状态：已确认（Phase 1）
- 决策：
  - 房间 ID 为服务端生成的随机标识；邀请 token 为 128 位随机值，可复用（同一链接可多次使用），Relay 只保存其 SHA-256 哈希，不保存原文。
  - 邀请链接形如 `<web 起源>/join?room=<roomId>#i=<inviteToken>`：房间 ID 走 query（非敏感），邀请 token 放 URL fragment，不会出现在任何服务器访问日志。
  - 房间可选密码只用于入房校验，Relay 内存中以 PBKDF2-HMAC-SHA256（加盐）哈希保存，不落盘、不写日志。
  - 加入/建房成功后 HTTP 换取短期会话凭证（sessionToken），同样只存哈希；会话随成员被移除或房间关闭而失效，空闲超时（默认 10 分钟未使用）自动清理。
- 原因：邀请链接是唯一分发物，必须自包含且不能泄露长期凭证；token 原文只出现在房主复制的一次链接里。

## D-008：WebSocket 鉴权握手格式

- 状态：已确认（Phase 1）
- 决策：客户端先通过 HTTP（`POST /api/rooms` 建房或 `POST /api/rooms/{roomId}/sessions` 加入）换取 sessionToken，再以 `GET /ws?roomId=<roomId>&sessionToken=<sessionToken>` 完成 WebSocket 握手。Relay 在升级前校验会话，无效则返回 HTTP 401。会话只绑定身份；所有权限判断都在房间 actor 内基于成员记录进行，不信任客户端自报的 senderId/role。
- 原因：把鉴权放在 HTTP 层可以用标准状态码（401/403/404/409）表达锁定、满员、token 失效等原因，WebSocket 消息流保持纯房间事件；重连复用同一 sessionToken，无需新事件类型。
- 风险与缓解：sessionToken 出现在 WS 握手 URL 中，可能进入反向代理访问日志。缓解：Relay 自身不记录 URL 与 query；生产部署要求 HTTPS/WSS，且建议反代关闭 query 记录（见技术设计“TLS 与部署”）。

## D-009：房主离开转移与房间生命周期

- 状态：已确认（Phase 1）
- 决策：
  - 连接断开（无论是否优雅关闭）默认进入 offline 宽限期并广播快照；宽限期内用原 sessionToken 重连即恢复原身份（含屏障内 ready 状态）。刷新页面、切后台被浏览器冻结、网络抖动都属于此类。
  - 显式离开必须由客户端在关闭 WebSocket 时使用专用关闭码 3001（`leave`）标记，服务端立即广播 `MEMBER_LEFT`（reason=left）并失效其会话。
  - 超过宽限期仍未重连的成员被移除并广播 `MEMBER_LEFT`（reason=timeout）；若被移除的是房主且房间仍有成员，房主角色自动转移给最早加入的剩余成员并广播快照；若无成员，房间关闭。
  - 房主显式关闭房间（`POST /api/rooms/{roomId}/close`）：全员收到 `MEMBER_LEFT`（reason=room_closed），所有连接关闭，房间与全部会话删除，不可恢复。
  - 锁房只影响新加入（`ROOM_LOCKED`），不断开已有成员；被踢成员（reason=kicked）的会话立即失效，必须重新通过邀请链接加入。
- 原因：浏览器在刷新、跳转和后台挂起时都会发送优雅关闭帧，无法与“主动离开”区分；把优雅关闭一律当作离开会把正常操作误杀成踢出房间。显式离开是用户界面上的明确动作，客户端有能力且必须显式标记。

## D-010：STUN/TURN 配置经构建期环境变量注入 web 客户端

- 状态：已确认（Phase 2）
- 决策：
  - ICE 服务器列表由 web 客户端在构建/启动时从 `VITE_ICE_SERVERS`（JSON `RTCIceServer[]`）读取；未配置时使用默认公共 STUN（`stun:stun.l.google.com:19302`）。
  - Relay 不分发 ICE 配置：它不参与媒体面，保持“控制/媒体分离”，也避免新增一个可被任意客户端拉取的配置端点。
  - TURN 长期凭据出现在静态前端包里是已知暴露面：MVP 面向朋友房间可接受；生产部署必须改用一次性/短期凭据（coturn `use-auth-secret` + HMAC REST 凭据），列入 Phase 4 加固项。
- 原因：WebRTC 配置只在浏览器端使用，构建期注入实现最小、无新增服务端面；TURN 只在无法直连时启用，属可配置兜底路径而非默认路径。
- 补充（Phase 4 后续，见 D-018）：长期凭据暴露面由运行时短期凭据方案解决，本决策的静态注入保留为 Relay 不可达时的回退。

## D-011：Phase 2 音频同步口径（房主调度统一开始，成员实时收流）

- 状态：已确认（Phase 2）
- 决策：
  - “统一开始”由房主实现：房主把本地文件解码为 `AudioBuffer`，以 AudioContext 时钟把播放精确调度到 `startAtMs`；成员接收的是实时 WebRTC 流，端到端网络延迟（通常 50–300ms）不做逐成员补偿，以实测偏差记录为准。
  - `READY` 的语义是“成员媒体管道就绪”：PeerConnection 已连接且远端音频轨道已接入本地音频图。AudioContext 未解锁（自动播放限制）不阻塞 READY，但界面持续给出醒目的“点击启用声音”提示；避免未点击的成员把全房间屏障卡死。
  - 重新同步：成员丢弃本地音频图并向房主发送 `RESYNC_REQUEST`；房主为该成员单独从当前权威位置重建音频段（每成员独立的 `MediaStreamAudioDestinationNode` 与音频段，使重建只影响请求者）。
  - 屏障超时策略：deadline 过后房主/共同 DJ 可发送 `NEXT_TRACK_START` 强制开始（复用既有事件类型），跳过未就绪成员；未就绪成员随后连接成功时从直播位置收听，可再手动重新同步对齐显示。房间不因单个成员无限等待。
  - 迟到成员（加入时歌曲已在播放中）：不自动接入音频流，界面提示“当前歌曲已开始”并提供重新同步按钮；点击后走上一条重建路径。
  - 暂停/拖动不停止 PeerConnection：房主停掉当前音频段即可静音，恢复/拖动时从新位置重建音频段，成员端无需重协商。
- 原因：WebRTC 是实时流，无法“倒放”历史音频；把强一致放在歌曲边界的房主调度上，把迟到/卡顿处理收敛到同一条“从当前位置重建”的路径，语义简单且与 D-003/D-004 一致。
- 已知限制：房主转移后新媒体权威需要重新加载同一本地文件才能恢复出声（控制面转移在 Phase 1 已完成）；快照 `pendingPrepare` 字段补齐了重连成员的屏障元数据（Phase 1 遗留项）。

## D-012：队列、房间曲库与点歌模型（Phase 3）

- 状态：已确认（Phase 3）
- 决策：
  - 房间曲库（library）只包含音频元数据（trackId/title/artist/durationMs + addedBy/addedAt），由房主从本地文件导入（支持拖放文件/文件夹与多选）；音频文件本身只存在于房主本机，不进入协议、不经过 Relay、不上传。成员只从曲库点歌，音频始终由房主经 WebRTC 发送——"本地文件只由房主读取"。
  - `trackId` 由房主客户端在导入时生成（文件名 + 大小 + 修改时间的哈希），是曲库条目、队列条目与本地文件绑定的唯一标识；重复检测按 `trackId` 判定。
  - 队列条目（queueEntry）携带服务端生成的 `entryId`、点歌人 `requestedBy/requestedByName` 与 `addedAtMs`；快照同时携带待审批区 `pendingRequests`。
  - 权限：host/co_dj 可审批（QUEUE_APPROVE/QUEUE_REJECT）、删除任意条目、重排（QUEUE_REORDER）、清空（QUEUE_CLEAR）、跳过当前曲目、切换播放模式（PLAY_MODE：order/repeat_one/shuffle）；listener 只能点歌（QUEUE_REQUEST）、投票跳过（SKIP_VOTE）与撤销自己的未播放条目（QUEUE_REMOVE）。
  - 插队规则：host/co_dj 的点歌免审批直接入队尾；listener 点歌进入待审批区，审批通过后入队尾；房主可用重排/清空调整顺序，也可对任意曲库或队列曲目直接"下一首播放"（走既有 NEXT_TRACK_PREPARE 屏障）。
  - 冷却与配额：listener 点歌有 30 秒冷却，且未播放条目（待审批 + 队列中）每人最多 2 条；超限回 `RATE_LIMITED`，重复点歌回 `DUPLICATE_TRACK`。host/co_dj 不受限（审批权本身就是节流阀）。
  - 播放衔接：房主客户端是队列播放的执行者——曲目自然结束、手动跳过或投票跳过通过时，按当前播放模式从队列取下一首（order 取队首；shuffle 随机；repeat_one 重播当前），为其发起既有 NEXT_TRACK_PREPARE 屏障；队列为空则暂停并提示。服务端在屏障完成时按 trackId 从队列移除匹配条目（兼容房主直接播放曲库曲目不在队列的情况）。
  - 历史与失败自动跳过：房主发送 `TRACK_FINISHED{played|skipped|failed}`；`failed` 携带 `trackId` 时服务端把该队列条目移除并记入历史（房主找不到对应本地文件/解码失败时自动跳过并继续取下一首）。服务端保留最近 20 条历史随快照下发。
- 原因：音频文件留在房主本机是 D-001 的延伸；"曲库点歌 + 审批"让成员无需上传音频即可参与选歌，服务端只持有元数据，控制面保持轻量。房主客户端执行播放衔接把"选哪首"的音频可行性（文件是否存在）留在有文件的端上判断，Relay 不需要理解音频可用性。

## D-013：聊天、反应与投票跳过（Phase 3）

- 状态：已确认（Phase 3）
- 决策：
  - 聊天 `CHAT_MESSAGE` 作为即时事件由 Relay 转发全员，不进快照、不占 roomRevision、不持久化；每房间内存保留最近 50 条，仅在连接建立时随快照后单发一次 `CHAT_HISTORY` 给该连接（重连也可恢复近期聊天）。限流每成员 10 条/10 秒，超限回 `RATE_LIMITED`。
  - 基础反应 = `kind=reaction` 的聊天消息（表情快捷按钮），不引入独立事件类型。
  - 投票跳过 `SKIP_VOTE` 绑定当前曲目的 transitionId，每成员一票（重复投票忽略）；票数满足"严格超过在线成员半数且 ≥2 票"时快照 `skipVotes.passed=true`。房主客户端看到 passed 后自动执行"跳过当前并播下一首"（队列空则暂停），无需房主在场；切歌后投票自动清零。
  - 房主/co_dj 拥有直接跳过权（TRACK_FINISHED{skipped}），无需投票。
- 原因：聊天是低价值高频率数据，进快照会让高频快照广播膨胀并推高 roomRevision 使写操作更易 STALE_REVISION；"过半即通过 + 房主客户端自动执行"让房间不被单个成员阻塞，也不需要房主实时在线操作，同时权限仍收敛在房主端媒体执行者上。

## D-014：平台链接识别在 Relay 端做，provider 适配器可插拔，失败必须可解释（Phase 4）

- 状态：已确认（Phase 4）
- 决策：
  - 平台识别/元数据解析在 **Relay（Go）端**执行：`internal/providers` 提供 `Provider` 接口（`Match/NormalizeURL/Resolve`），按平台注册适配器（netease、qqmusic、spotify、ytmusic）；web 端只做同一规则的 URL 规范化（即时输入校验），两者用同一份 fixture 做跨语言一致性测试。
  - 解析入口是 `POST /api/rooms/{roomId}/links/resolve`（host 会话 + 限流 10 次/分钟）。平台域名白名单 + 仅 https + 禁私网地址 + 重定向仅限同白名单 + 响应 ≤1MB + 8s 超时（SSRF 防护）。
  - `Track` 增加可选 `source` 字段：`{platform, url, externalId?, playability?, resolvedAtMs?}`，随曲库/队列/快照下发。playability 枚举：`playable | needs_login | preview_only | region_locked | unavailable | unknown`。语义是"平台侧可用性判断"，不是"房间内可播"——房间内可播永远取决于房主本机文件（D-001）。
  - 平台链接曲目与本地曲目共用队列模型：房主可为其绑定本机同名/对应文件（正常播放）；无文件时走既有失败跳过路径，UI 明确提示"平台音频不能直接播放（合规边界），需要房主本机文件或跳过"。不做平台音频转发、不做 DRM/会员/地区绕过。
  - 不可达/超时解析失败回 HTTP 502 `PROVIDER_UNAVAILABLE`（可解释），不支持的平台回 400 `PLATFORM_UNSUPPORTED`；全部错误都带用户可操作的消息。失败经验按日期记录在 `docs/PROVIDERS.md`。
- 原因：Relay 端解析避开浏览器 CORS 与密钥分发问题；白名单式 SSRF 防护比黑名单可靠；"识别与可用性判断"和"可播"分离让降级路径永远明确。本机实测 Spotify/YouTube 不可达（PROVIDERS.md P-001），可解释失败是第一验收项。

## D-015：OAuth 使用 Authorization Code + PKCE，token 只存在 Relay 内存（Phase 4）

- 状态：已确认（Phase 4）
- 决策：
  - 流程：web 端请求 `POST /api/oauth/{provider}/start`（会话鉴权）→ Relay 生成 `state` + `code_verifier`（S256 challenge）并暂存（绑定成员会话，10 分钟有效）→ 浏览器新窗口打开 `authorizeUrl` → provider 回调 `GET /api/oauth/{provider}/callback?code&state` → Relay 校验 state、用 verifier（+服务端 client_secret，如配置）换 token → token 只存 Relay 内存并绑定会话 → 回调页提示"授权完成，请回房间"。断开时尽力调用 provider 撤销端点并删除本地副本。
  - scope 最小化并显式配置（`LISTO_OAUTH_<PROVIDER>_SCOPES`），默认仅够"识别可用性"的只读 scope。
  - token 边界（硬性）：token/refresh_token/authorization code 不进房间快照、不进任何 WS 消息、不进邀请链接、不回传浏览器（`/status` 只返回 `connected` + 打码用户标识 + scope）、不写日志（日志侧按字段名与值的模式脱敏）、不进测试证据；relay 重启即失效（无持久化）。会话被清理时同步释放对应 token。
  - 未配置凭证的 provider：`/start` 返回 503 `OAUTH_NOT_CONFIGURED`，UI 显示"未配置"；配置方法写在 README（环境变量占位示例）。真实 provider（Spotify 等）在当前开发环境不可达且无开发者凭证，OAuth 全流程用本地 mock provider 自动化验证（PROVIDERS.md P-006），不因无法联调真实平台而降低实现标准。
- 原因：D-006 只定了"官方 OAuth + PKCE + 最小权限"；此决策把它落到 Relay 单点持有 token 的形态——浏览器永远不接触 token，房间状态只有脱敏登录标识，泄露面最小且可审计。

## D-016：封面经既有 WebRTC DataChannel 发给成员，Relay 不接触（Phase 4 体验增强）

- 状态：已确认（Phase 4）
- 决策：
  - 房主在与每成员的既有 PeerConnection 上新建 `listo-data` DataChannel（offer 前创建）；消息为 JSON 文本帧：`{kind:"cover-meta", trackId, mime, totalChunks, size}` + 若干 `{kind:"cover-chunk", trackId, seq, data(base64)}`，每 chunk 携带 ≤48KB 原始字节。
  - 发送时机仅两个：曲目切换（NEXT_TRACK_START 后）与和新成员建联（含重连建联）；同一 (成员, trackId) 不重发。单张封面 ≤512KB，超过则房主端 canvas 缩放/降质量压缩后再发，仍超限则放弃发送（成员端显示占位）。
  - 来源：房主本地文件的 ID3 APIC 嵌入封面（同源 blob）。平台链接的封面 URL 不经 DataChannel 转发（跨域画布污染，PROVIDERS.md P-005）；成员端如需显示平台封面，直接由各客户端从 URL 加载。
  - 成员按 trackId 缓存（内存，LRU 20 张），收到前显示占位。
- 原因：封面是媒体数据，走 P2P 数据通道保持"Relay 不参与媒体"（D-001/架构边界）；分块绕开 SCTP 单消息大小限制；只发一次控制 DataChannel 流量。

## D-017：歌词经 TRACK_LYRICS 控制面事件下发，Relay 内存缓存（Phase 4 体验增强）

- 状态：已确认（Phase 4）
- 决策：
  - 房主导入曲库时自动匹配同名 `.lrc`/`.txt`（也可在曲库条目手动指定文件）；LRC 解析为 `{timeMs, text}` 数组（支持一行多时间戳），`.txt` 为纯文本整段显示。歌词以 `TRACK_LYRICS{trackId, format, lyrics}`（host→Relay）发布，Relay 校验（仅 host、≤48KB、≤500 行、单行 ≤512 字符）后缓存（按 trackId，每房间 ≤50 条，超出淘汰最旧）并转发给其他在线成员。
  - 补发时机：新连接挂载后（若当前曲目有缓存歌词）与屏障完成切歌时（若新曲目有缓存歌词），复用 TRACK_LYRICS（relay→client）。不进快照、不占 revision。
  - 超限拒绝回 `ERROR(LYRICS_TOO_LARGE)`（新错误码）；客户端发送前预检同样规则，给出明确提示。无歌词曲目显示占位。
  - 成员按 `livePositionMs` 做行级高亮（对 100ms 内偏差不敏感）；高亮用 `aria-current="active"` 保持无障碍。
- 原因：歌词是几 KB 级文本，走控制面实现最简单且能复用既有权限/校验/连接生命周期；Relay 缓存是 checklist 明确要求；48KB 上限来自 64KB WS 帧限制减去转义与信封余量（PROVIDERS.md P-007）。

## D-018：TURN 短期凭据由 Relay 运行时下发（coturn REST 机制）

- 状态：已确认（Phase 4 后续加固）
- 决策：
  - Relay 新增 `GET /api/webrtc/ice`（会话鉴权）：按 coturn `use-auth-secret` 的 REST 凭据机制（draft-uberti-rtcweb-turn-rest）实时生成短期凭据——`username = <过期Unix秒>`、`credential = base64(SHA1-HMAC(secret, username))`，TTL 默认 1 小时（`LISTO_TURN_TTL_SECONDS`，上限 24h）。
  - 配置全部来自环境变量：`LISTO_TURN_URLS`（逗号分隔 turn(s): 地址）、`LISTO_TURN_SECRET`；两者齐备才下发 TURN 凭据，否则只返回默认 STUN。凭据只在响应中出现一次，不进日志（secret 键名在日志脱敏列表）。
  - web 端进入房间时拉取一次并周期刷新（TTL/2，至少 5 分钟）；`VITE_ICE_SERVERS` 静态注入降级为"Relay 不可达时的回退"（D-010 保留），ICE 建联不因此阻塞。
  - 凭据算法与 coturn 参考实现一致并有固定向量单测；真实 TURN 中继路径的连通性仍需部署 coturn 后验证（本机无 TURN 服务器，与 D-010 阶段限制相同，已如实记录）。
- 原因：静态长期凭据进前端包是不可接受的暴露面；Relay 已持有会话鉴权与安全随机，是生成短期凭据的最小新面。选择 coturn REST 机制可直接对接生产标准部署，不引入私有协议。

## D-019：放弃 Spotify / YouTube 外网方向，OAuth 以 provider 无关实现 + 本地全栈验收为准

- 状态：已确认（Phase 4 后续）
- 决策：
  - 保留 spotify/ytmusic 适配器的 URL 识别/规范化能力（离线可用），**不再投入**其外网解析与真实 OAuth 联调方向；对不可达的解析失败继续以可解释状态呈现（行为不变）。
  - 平台 OAuth 的验收基准调整为：provider 无关的标准 AC+PKCE 实现 + 本地 mock provider 的**浏览器全栈 E2E**（授权弹窗→回调→连接状态→断开撤销）。接入任何真实平台（含未来可直连的）只需要环境变量，无代码改动。
  - 网易/QQ 公开接口无官方 SLA 是固有风险：其 API base 改为环境变量可覆盖（`LISTO_PROVIDERS_*_API_BASE`），接口变更时可运维侧应急切换，不改代码。
- 原因：本机网络对 Spotify/YouTube 持续不可达（P-001/P-008），继续投入无法产生可验证结果；OAuth 的价值在"token 边界与标准流程正确"，这一点与具体平台无关，可等价验收。

## D-020：收尾包——上一首/带宽提示/致命断线重试/共同 DJ 引导（Phase 4.5）

- 状态：已确认（Phase 4.5 收尾）
- 决策：
  - **上一首**：不新增协议事件。"上一首" = 房主从快照 `history` 中取最近一条 outcome 为 played/skipped 的条目，复用既有 `NEXT_TRACK_PREPARE` 屏障发起播放。历史只记录已结束曲目：播放中时 history[0] 即上一首；歌曲刚结束时 history[0] 就是它自己，重播正是预期语义。历史本就随快照下发、屏障机制与曲目无关，零协议面；仅房主 UI 提供入口（共同 DJ 已有曲库/队列任意点播能力）。无可用历史时按钮禁用。
  - **房主上行带宽提示**：纯客户端估算——当前曲目"文件大小×8÷时长"得码率，×已连接成员数得总上行，显示在房主音频状态行；估算超过 10 Mbps（常量，可后续参数化）时显示明确警告（对应技术设计"超过目标人数明确提示，不静默降级"）。文件未加载时显示"—"不给误导数字。
  - **致命断线重试**：`RoomStore` 增加致命类别（session_invalid / room_closed / retry_exhausted）。仅"多次重连失败"类别提供"重试连接"按钮（重置退避重新连接）；会话失效/房间关闭类别不提供（重试无意义，正确路径是重新加入）。
  - **共同 DJ 屏障引导**：屏障超时且 0 人就绪时，给共同 DJ 显示提示（房主本机可能缺文件，可立即开始跳过或换一首）——房主已有缺文件横幅，此提示补齐信息不对称。
  - **flac/m4a 标签解析**：`readAudioTags` 按文件头分派（ID3 / fLaC / ftyp），手写 FLAC VORBIS_COMMENT+PICTURE 与 MP4 ilst 解析器（8MB 读取预算，moov 不在头部时按"不支持"回退文件名，不引入依赖）。
- 原因：全部为纯客户端增强，零协议面、零服务端改动；历史数据早已随快照下发，"上一首"只是把既有能力接到 UI。
