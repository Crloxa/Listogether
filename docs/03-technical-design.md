# 具体技术设计

本文档把当前决策落到可以直接开工的技术边界。实现时若需要改变选型，应先在 `docs/DECISIONS.md` 新增决策并同步本文件。

## 选型结论

| 层 | 选型 | 选择理由 |
| --- | --- | --- |
| 浏览器客户端 | TypeScript + React + Vite | 浏览器生态成熟，适合 WebRTC、Web Audio、Media Session 和响应式界面 |
| Relay 后端 | Go + `net/http` + WebSocket | 控制/信令消息量小但连接数可能多；部署为单一静态二进制，内存和并发模型简单 |
| 音频传输 | 浏览器原生 Web Audio + WebRTC | 房主本地解码，成员实时收听；不经应用层保存音频 |
| 数据格式 | 版本化 JSON envelope | 控制面低频、可调试；用 JSON Schema 做边界校验，后续可替换为二进制而不改变事件语义 |
| MVP 状态存储 | Relay 内存 | 单实例足够验证核心闭环，避免过早引入数据库；重启后房间失效是已知限制 |
| 多实例扩展 | Redis Pub/Sub（后续） | 只在需要多 Relay 或持久房间时引入 |
| NAT 穿透 | STUN + 可配置 TURN（coturn） | 优先点对点，无法直连时才使用 TURN |

Go Relay 只负责房间控制、信令、鉴权和健康检查，不解码、不混音、不保存音频。WebRTC 音频由房主浏览器分别发送给成员，带宽和音频资源由房主承担。

## 代码目录

```text
apps/
├─ web/
│  └─ src/
│     ├─ app/                 # 路由、依赖注入、全局错误边界
│     ├─ features/room/       # 建房、入房、成员和房间设置
│     ├─ features/player/     # 播放器 UI 与房主控制
│     ├─ features/queue/      # 队列、点歌、审批、投票
│     ├─ features/chat/       # 聊天和反应
│     ├─ features/auth/       # OAuth 状态和 provider UI
│     ├─ transport/ws/        # Relay WebSocket 客户端、重连和请求超时
│     ├─ media/local-source/  # 文件选择、标签读取、可定位音频源
│     ├─ media/webrtc/        # PeerConnection、音频轨道和 ICE 状态
│     ├─ state/               # RoomStore、ConnectionStore、PlayerStore、AuthStore
│     ├─ ui/                  # 无业务逻辑的通用组件
│     └─ test/                # 浏览器单元和组件测试
└─ relay/
   ├─ cmd/relay/main.go       # 配置、HTTP、优雅关闭
   └─ internal/
      ├─ httpapi/             # health、room、oauth callback
      ├─ ws/                  # WebSocket 升级、连接读写和限流
      ├─ room/                # 房间 actor、权限、revision 和快照
      ├─ protocol/            # JSON envelope、schema 和错误码
      ├─ signal/              # SDP/ICE 信令转发，不持久化
      ├─ auth/                # 邀请 token、会话 token、OAuth state
      ├─ presence/            # 心跳、在线状态和超时
      └─ observability/       # slog 结构化日志和指标（脱敏）

packages/
├─ protocol/
│  ├─ schema/                 # canonical JSON Schema（单一来源）
│  └─ src/                    # TypeScript 类型、事件/错误码常量、ajv 校验器
├─ shared/                    # 跨应用工具：日志脱敏等
└─ media/                     # 可定位音频源接口与漂移判断（Phase 2 实现）
```

Go 侧信封校验与已知事件集合位于 `apps/relay/internal/protocol`，通过 parity 测试（`TestKnownTypesParityWithSchema`）与 canonical schema 的 type 枚举保持同步；payload 字段级校验由 schema（TS 侧 ajv）负责，Go 房间逻辑在 Phase 1 按事件处理。

## 前端设计

### 状态分层

- `RoomStore`：服务器快照、成员、队列、`revision` 和权限，只由服务端事件更新。
- `PlayerStore`：本机 `<audio>`/Web Audio/PeerConnection 状态、缓冲和静音；房主有全局控制入口，成员只有本地控制入口。
- `ConnectionStore`：WebSocket、PeerConnection、RTT、重连次数和错误状态。
- `AuthStore`：provider 登录状态和脱敏用户标识，不保存可复制的 token 到 React 状态或 URL。

组件只通过 command/query API 操作状态，不直接修改服务端快照。音频和 WebSocket 连接放在 feature 之外管理，避免组件卸载造成媒体流泄漏。

### 关键页面

- `HomePage`：创建房间、输入邀请链接、最近本地歌单。
- `RoomPage`：当前播放、成员/延迟、队列、点歌、聊天和设置。
- `SyncBanner`：迟到提示、当前歌曲已开始、手动重新同步、下一首准备进度。
- `HostControls`：房主/DJ 操作和下一首准备屏障状态。

## Relay 设计

### 房间生命周期与鉴权（Phase 1）

凭证流（详见 DECISIONS.md D-007/D-008/D-009）：

1. `POST /api/rooms` 创建房间，返回 `roomId`、`inviteToken`、房主 `sessionToken`。邀请链接 `<web>/join?room=<roomId>#i=<inviteToken>` 由房主复制分发。
2. 成员 `POST /api/rooms/{roomId}/sessions`（携带 inviteToken、昵称、可选密码）换取自己的 sessionToken；锁定（403 ROOM_LOCKED）、满员（409 ROOM_FULL）、token/密码错误（401）在此拒绝。
3. 双方 `GET /ws?roomId=&sessionToken=` 接入；Relay 升级前校验会话，升级后向该连接发送 `ROOM_SNAPSHOT` 并向其他成员广播 `MEMBER_JOINED`。
4. 所有权限判断在房间 actor 内基于成员记录执行：会话只提供身份，`senderId` 由服务端用会话绑定的成员 ID 覆写。

HTTP API（`Authorization: Bearer <sessionToken>`，均为 JSON）：

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `POST /api/rooms` | 匿名 | 创建房间：`{hostName, roomName?, password?, maxMembers?}` |
| `POST /api/rooms/{roomId}/sessions` | 匿名 + 邀请 token | 加入房间：`{inviteToken, name, password?}` |
| `GET /api/rooms/{roomId}` | 匿名 | 公开信息：`{locked, memberCount, maxMembers, needsPassword}` |
| `POST /api/rooms/{roomId}/lock` | 房主 | `{locked: bool}`；只影响新加入，不广播、不改 revision |
| `POST /api/rooms/{roomId}/members/{memberId}/kick` | 房主 | 踢人；目标会话立即失效 |
| `POST /api/rooms/{roomId}/members/{memberId}/role` | 房主 | `{role: "co_dj"\|"listener"}`；不能指定 host（转移只在房主离开时发生） |
| `POST /api/rooms/{roomId}/close` | 房主 | 关闭房间，全员 `MEMBER_LEFT(room_closed)` |

错误码到 HTTP 状态：`INVALID_MESSAGE`→400，`INVALID_TOKEN`→401（邀请/会话 token 无效），`UNAUTHORIZED`/`ROOM_LOCKED`→403（含密码错误与角色越权），`ROOM_NOT_FOUND`→404，`ROOM_FULL`→409。

### 房间 actor 与状态

每个 WebSocket 连接经 hub 校验会话后挂到房间 actor。每个房间一个串行 command loop，全部状态变更（revision、成员、播放、屏障）在该 loop 内完成；HTTP 管理操作也投递到同一 loop，保证无并发竞争。

- revision：任何广播可见的状态变更（加入/离开/踢人/角色/READY/PLAY/PAUSE/SEEK/PREPARE/START）使 revision 单调 +1。锁房对成员不可见，不改 revision。
- 旧事件拒绝：客户端写操作的 `roomRevision` 小于服务端当前值时回 `ERROR(STALE_REVISION)`（refEventId 指向原事件）；`READY` 以 transitionId 匹配为准，不做 revision 检查；`HEARTBEAT`、`SKIP_VOTE` 与 `CHAT_MESSAGE` 与 WebRTC 转发不做检查；客户端在每次发送后乐观递增本地 revision（服务端拒绝时由后续事件校准），使同一 tick 内的连续写操作（如 `TRACK_FINISHED` 后立即 `PAUSE`/`NEXT_TRACK_PREPARE`）不被误拒。
- 客户端收到 STALE_REVISION 或需恢复状态时发送 `RESYNC_REQUEST`：Relay 先向请求者补发 `ROOM_SNAPSHOT`，再转发该事件给房主（Phase 2 起房主据此为其重建音频流；只影响请求者自己）。
- 快照进度：房间保存"最近一次进度事件的位置与时刻"，快照中 `positionMs` 在播放中按时钟外推；成员端以本地接收时刻为基准外推显示，不高频广播进度（AGENTS §4）。

### 权限矩阵

| 操作 | host | co_dj | listener |
| --- | --- | --- | --- |
| PLAY / PAUSE / SEEK | ✓ | — | — |
| NEXT_TRACK_PREPARE / NEXT_TRACK_START / PLAY_MODE | ✓ | ✓ | — |
| TRACK_FINISHED（队列播放执行者随媒体在房主） | ✓ | — | — |
| LIBRARY_ADD / LIBRARY_REMOVE | ✓ | — | — |
| QUEUE_APPROVE / QUEUE_REJECT / QUEUE_REORDER / QUEUE_CLEAR | ✓ | ✓ | — |
| QUEUE_REQUEST / SKIP_VOTE / CHAT_MESSAGE | ✓ | ✓ | ✓ |
| QUEUE_REMOVE | ✓ | ✓ | 仅撤销自己的条目 |
| READY / RESYNC_REQUEST | ✓ | ✓ | ✓ |
| 锁房/踢人/授权角色/关房 | ✓ | — | — |

越权写操作回 `ERROR(UNAUTHORIZED)`。成员的本地音量/静音是纯客户端行为，不产生房间事件。

### 下一首屏障

1. host/co_dj 发送 `NEXT_TRACK_PREPARE`（`transitionId`、track 元数据、`startPositionMs`、`prepareDeadlineMs`、`startAtMs`）；运行时校验 `prepareDeadlineMs < startAtMs` 且两者必须晚于服务器当前时间（Phase 0 已知 schema 无法表达跨字段比较，此处补齐）。
2. 在线成员准备后发送 `READY`（transitionId 匹配），Relay 广播快照使全员看到就绪状态。
3. 当前全部在线成员就绪后，Relay 立即广播 `NEXT_TRACK_START`，置 `currentTrack`、`playing=true`，客户端在 `startAtMs` 统一开始。
4. deadline 到达仍有人未就绪：广播一次快照供房主查看，屏障保持（晚到的 READY 仍被接受）；房主可重发 `NEXT_TRACK_PREPARE` 重设时间、踢出未就绪成员或等待。已离线连接不会被永久计入屏障（offline 成员不参与就绪计算）。

### 连接健康与在线状态（Phase 1 参数）

- 客户端每 15s 发一次 `HEARTBEAT`（仅用于健康/在线，不携带进度）。
- 服务端 WebSocket 读超时 60s，任何消息或 Pong 刷新；服务端每 20s 发 PING（浏览器自动 Pong）。
- 连接断开（含优雅关闭）的成员先标记 offline 并广播快照；离线超过 45s（`LISTO_RELAY_OFFLINE_TTL_SECONDS`）被移除并广播 `MEMBER_LEFT`。宽限期内用原 sessionToken 重连即恢复原成员身份（含屏障内 ready 状态）。刷新页面、切后台被冻结、网络抖动均走此路径。
- 显式离开：客户端关闭 WebSocket 时使用关闭码 3001，服务端立即移除成员（reason=left）并失效会话，不走宽限期。
- 每连接一条有序出站队列（64 条），写满视为慢消费者并断开，不阻塞房间 actor。
- 关闭码：3001 显式离开（仅客户端→服务端方向），4001 会话失效（被踢/过期/房间已关），4002 房间关闭，4003 连接被新连接替换（同一会话重复打开页面）。

### TLS 与部署说明

- 开发：HTTP + WS 明文，仅限本机/可信局域网。
- 直连 TLS：设置 `LISTO_RELAY_TLS_CERT` / `LISTO_RELAY_TLS_KEY`（PEM），Relay 以 `http.ServeTLS` 提供 HTTPS/WSS；客户端 WSS 地址需同步配置。
- 反向代理（推荐生产）：在 Nginx/Caddy 终止 TLS 并代理到 Relay，`Upgrade`/`Connection` 头透传 WebSocket；访问日志关闭 query 记录以避免 sessionToken 留存（D-008 风险项）。
- Web 侧邀请链接基于当前浏览器起源生成，部署时保证 web 与 relay 同源或跨源 CORS 白名单正确配置。

### 消息 envelope

```json
{
  "v": 1,
  "type": "NEXT_TRACK_PREPARE",
  "eventId": "opaque-id",
  "roomRevision": 42,
  "senderId": "opaque-member-id",
  "sentAtMs": 0,
  "payload": {}
}
```

MVP 事件至少包括：`ROOM_SNAPSHOT`、`MEMBER_JOINED`、`MEMBER_LEFT`、`PLAY`、`PAUSE`、`SEEK`、`NEXT_TRACK_PREPARE`、`READY`、`NEXT_TRACK_START`、`RESYNC_REQUEST`、`WEBRTC_OFFER`、`WEBRTC_ANSWER`、`ICE_CANDIDATE`、`HEARTBEAT`、`ERROR`，以及 Phase 3 队列/点歌/聊天事件（`LIBRARY_ADD`、`LIBRARY_REMOVE`、`QUEUE_REQUEST`、`QUEUE_APPROVE`、`QUEUE_REJECT`、`QUEUE_REMOVE`、`QUEUE_REORDER`、`QUEUE_CLEAR`、`SKIP_VOTE`、`TRACK_FINISHED`、`PLAY_MODE`、`CHAT_MESSAGE`、`CHAT_HISTORY`，详见"队列、点歌与聊天（Phase 3 实现设计）"）。

`NEXT_TRACK_PREPARE` 是唯一触发全员播放屏障的事件。`PLAY`、`PAUSE`、`SEEK` 只更新房主权威状态并通知成员；成员若发现本地偏差，显示重新同步入口。

## WebRTC 媒体流程（Phase 2 实现设计）

决策依据见 DECISIONS.md D-010/D-011。前端媒体代码位于 `apps/web/src/media/`：

```text
media/
├─ local-source/buffer-source.ts   # 文件解码为 AudioBuffer；LocatableAudioSource 实现
├─ audio-clock.ts                  # 纯函数：startAtMs → AudioContext 调度时间/偏移
├─ webrtc/ice-config.ts            # VITE_ICE_SERVERS 解析（默认公共 STUN）
├─ webrtc/host-peer.ts             # 房主侧：每成员一条 PeerConnection 的建联/信令/释放
├─ webrtc/member-peer.ts           # 成员侧：应答 offer、收集 ICE、远端轨道回调
├─ host-audio.ts                   # 房主音频控制器：音频段调度、重建、资源释放
└─ member-audio.ts                 # 成员音频控制器：解锁 AudioContext、播放、音量、健康检查
```

### 图与信令时序

- 房主解码本地文件得到 `AudioBuffer`；为每个在线成员建立独立的 `MediaStreamAudioDestinationNode` + `RTCPeerConnection`，轨道加入对应连接；另接一路本地监听增益节点（房主自己能听到）。
- **offer 一律由房主发起**（成员加入、房主重连后 reconcile、成员重新同步时重建）：`WEBRTC_OFFER` → 成员 `WEBRTC_ANSWER` → 双向 `ICE_CANDIDATE`。Relay 只按 `toMemberId` 转发，不保存 SDP/候选超过连接生命周期。
- 音频段（segment）= `AudioBufferSourceNode`：控制面每次权威状态变化（PLAY/PAUSE/SEEK/NEXT_TRACK_START/RESYNC）后由房主按新锚点重建。暂停/拖动不重协商 PeerConnection。
- 成员把远端轨道接 `MediaStreamAudioSourceNode → AnalyserNode（本地电平显示）→ GainNode（本地音量/静音）→ destination`；音量是纯客户端行为，不产生房间事件。

### 屏障与 READY 门控

1. 房主选择本地文件（解码成功后才允许发起屏障），提交 `NEXT_TRACK_PREPARE`（track 元数据取自解码结果）。
2. 成员在“PeerConnection connected + 远端轨道接入”后发送 `READY`（Phase 1 的“收到即 READY”移除）；AudioContext 未解锁不阻塞 READY（D-011）。
3. 全员就绪 → Relay 广播 `NEXT_TRACK_START` → 房主以 AudioContext 时钟调度全员音频段在 `startAtMs` 起播；成员听实时流。
4. deadline 过后仍未全员就绪：快照会携带 `pendingPrepare`（transitionId/track/时间字段，重连成员据此恢复屏障元数据并发 READY）；房主界面出现“立即开始（跳过未就绪成员）”，发送 `NEXT_TRACK_START`（host/co_dj 权限，transitionId 必须匹配当前屏障）由 Relay 完成屏障。

### 重新同步与迟到

- 成员重新同步：丢弃本地音频图 → `RESYNC_REQUEST` → Relay 补发快照并转发房主 → 房主停掉该成员的音频段并从当前权威位置重建（PC 不可用时连带重建并发新 offer）。只影响请求者。
- 迟到成员：PC 建联后不自动出声，界面提示“当前歌曲已开始”+ 重新同步按钮；点击后走上一条重建路径。

### 资源释放

- 成员离开/被踢/掉线：房主关闭对应 PeerConnection 与音频段节点（MEMBER_LEFT 与快照 reconcile 双路径）。
- 成员端离开/卸载：关闭 PeerConnection 与 AudioContext；WS 重连不等于 WebRTC 中断，健康检查发现 `failed` 才自动触发一次重新同步。

### 同步偏差测量

成员首次从音频流采到非静音样本（AnalyserNode RMS 超阈值）时记录 `firstAudioLagMs = 采样时刻服务器时钟 - startAtMs`；两端各自记录并对比相对偏差，写入测试证据。

### 实现要点与已知限制（Phase 2 实测）

- **Chromium 远端流必须先被 `<audio>` 元素消费**：成员端把远端 MediaStream 绑定到一个 muted `<audio autoplay>` 元素以启动轨道解码管线，否则 `MediaStreamAudioSourceNode` 恒为静音（端到端实测确认，直连 tap 为 0、元素唤醒后正常）。实际出声与音量控制仍走 WebAudio 图，元素本身静音不外放。
- **刷新/接管后的缓冲晋升**：控制面已有播放中曲目而房主本机没有当前缓冲时，刚加载的文件直接充当当前曲目（界面有“本机尚未加载音频文件”提示）。
- **曲目播到结尾**：音频段自然结束转为静音，控制面位置继续外推，不自动暂停或切歌；自动衔接下一首在 Phase 3 队列接入。
- **房主转移的媒体连续性**：新房主需重新加载同一本地文件并通过“下一首”或播放/拖动恢复出声（D-011 已知限制）。

## 队列、点歌与聊天（Phase 3 实现设计）

决策依据见 DECISIONS.md D-012/D-013。Relay 是队列/曲库/审批/投票/历史的权威；房主客户端是队列播放的执行者（音频文件只在房主本机）。

### 协议扩展

快照（ROOM_SNAPSHOT）新增可选字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `playMode` | `order\|repeat_one\|shuffle` | 播放模式，缺省 `order` |
| `library` | `libraryEntry[]`（≤500） | 房间曲库：`{trackId,title,artist?,durationMs,addedBy,addedAtMs}`，仅元数据 |
| `pendingRequests` | `queueEntry[]`（≤200） | 待审批点歌 |
| `queue` | `queueEntry[]` | 条目改为 `{entryId,track,requestedBy,requestedByName,addedAtMs}`（破坏性调整，前后端同步发布） |
| `history` | `historyEntry[]`（≤20） | `{track,outcome:played\|skipped\|failed,atMs,requestedByName?}` |
| `skipVotes` | `{transitionId,memberIds[],passed}` \| null | 当前曲目的投票跳过状态 |

新增事件（客户端→服务端，均走信封校验 + 权限判定 + STALE_REVISION 检查）：

| 事件 | 权限 | payload | 服务端行为 |
| --- | --- | --- | --- |
| `LIBRARY_ADD` | host | `{tracks: Track[]}`（≤200） | 按 trackId 去重合并进曲库，广播快照 |
| `LIBRARY_REMOVE` | host | `{trackId}` | 从曲库移除 |
| `QUEUE_REQUEST` | 全员 | `{trackId}` | 曲库校验 → 冷却(30s)/配额(2)/重复检测（仅 listener）→ host/co_dj 直接入队尾，listener 进待审批区；失败回 `DUPLICATE_TRACK`/`RATE_LIMITED` |
| `QUEUE_APPROVE` / `QUEUE_REJECT` | host, co_dj | `{entryId}` | 待审批 → 队尾 / 移除并记历史(rejected) |
| `QUEUE_REMOVE` | host, co_dj 或条目点歌人 | `{entryId}` | 从队列/待审批移除（撤销自己的请求） |
| `QUEUE_REORDER` | host, co_dj | `{entryIds[]}` | 全量重排队列（必须与当前队列同一集合） |
| `QUEUE_CLEAR` | host, co_dj | `{}` | 清空队列与待审批 |
| `SKIP_VOTE` | 全员 | `{}` | 对当前 transitionId 记一票（无 revision 检查，一人一票幂等）；票数 > 在线半数且 ≥2 时快照 `skipVotes.passed=true` |
| `TRACK_FINISHED` | host | `{outcome: played\|skipped\|failed\|rejected, trackId?}` | 当前曲目记历史（played/skipped）；`failed+trackId` 移除该队列条目并记历史（失败自动跳过） |
| `PLAY_MODE` | host | `{mode}` | 更新播放模式 |
| `CHAT_MESSAGE` | 全员 | `{kind, text}` | 限流（10 条/10s）后补齐身份字段转发全员；不占 revision、不进快照、无 revision 检查 |
| `CHAT_HISTORY` | 服务端→连接 | `{messages[]}`（≤50） | 连接建立时随快照后单发 |

新增错误码：`DUPLICATE_TRACK`（重复点歌）。

### 队列状态机与房主执行循环

```text
曲库(library) --QUEUE_REQUEST--> 待审批(pendingRequests) --QUEUE_APPROVE--> 队列(queue)
    ^                                  |                                        |
    |                                  +--QUEUE_REJECT--> 历史(rejected)        |--NEXT_TRACK_START(屏障完成,按trackId移除)
    |                                                                           v
    +---- 房主导入本地文件(LIBRARY_ADD，仅元数据)                        当前曲目 --> TRACK_FINISHED --> 历史
```

- 房主客户端维护 `fileRegistry: trackId → File` 与解码缓存；收到 `NEXT_TRACK_PREPARE`（无论发起者）时按 `barrier.track.trackId` 查注册表：有文件 → 暂存解码缓冲并上报 READY；无文件 → 不上报 READY 并提示"缺少音频文件"（屏障会超时，可强制开始或等房主补文件）。
- 曲目自然结束（音频段 onended 且非暂停/拖动/切歌）→ 房主发 `TRACK_FINISHED{played}` → 按播放模式取下一首发起屏障；队列空 → 发 PAUSE 并提示"队列已播完"。
- 手动跳过/投票通过 → `TRACK_FINISHED{skipped}` → 同上取下一首。
- 下一首文件缺失/解码失败 → `TRACK_FINISHED{failed, trackId}` → 服务端移除该条目 → 房主继续取再下一首（连续失败有上限防死循环）。
- 投票跳过通过（快照 `skipVotes.passed`）由房主客户端自动执行，房主无需在线操作；每个 transitionId 只自动执行一次。

### 本地文件体验与持久化

- 房主导入：拖放区 + 文件选择器（多选 + 文件夹 `webkitdirectory`），拖放目录用 `webkitGetAsEntry` 递归展开；逐个 `decodeAudioData`，失败（格式不支持/损坏）计入"无法导入"清单并明确提示，不影响其他文件。
- 标签与封面：mp3 解析 ID3v2（标题/艺人/APIC 封面），其余格式回退文件名；封面以本地 objectURL 只在持有文件的端显示，不进协议（快照体积与隐私考虑，成员端封面列为后续增强）。
- 持久化（房主本机 localStorage）：曲库元数据（不含文件字节）；刷新后条目标记"未加载"，重新选择同名文件时按名称+大小绑定回原 trackId，队列请求不失效。
- 导入导出：最小 JSON 格式 `{version:1, tracks:[{trackId,title,artist,durationMs,file:{name,size}}]}`；导出为下载文件，导入合并为"未加载"条目。

## 平台识别、OAuth 与安全加固（Phase 4 实现设计）

决策依据见 DECISIONS.md D-014/D-015/D-016/D-017；真实平台实测与失败经验见 `docs/PROVIDERS.md`。

### Provider 适配器与链接解析（Relay 端）

```text
apps/relay/internal/providers/
├─ provider.go    # Provider 接口、注册表、URL 通用校验（scheme/host 白名单/私网拒绝）
├─ netease.go     # music.163.com：/song?id=、/song/<id>；API /api/song/detail
├─ qqmusic.go     # y.qq.com：/n/yqq/song/<mid>.html；API fcg_play_single_song
├─ spotify.go     # open.spotify.com：/track/<id> 等；oEmbed + Web API（本机不可达，见 P-001）
└─ ytmusic.go     # music.youtube.com / youtube.com watch?v=；oEmbed（同上）
```

- `Provider` 接口：`ID() string`、`Match(*url.URL) bool`、`NormalizeURL(raw string) (string, error)`、`Resolve(ctx, normalizedURL, oauthToken) (*TrackInfo, error)`。`TrackInfo{Platform, ExternalID, Title, Artist, Album, DurationMs, CoverURL, Playability, Message}`。
- URL 规范化（web 端 `features/providers/normalize.ts` 与 Go 双实现，同一 fixture 跨语言测试）：剥 query/fragment、补 https、平台域名精确匹配；不认识的平台直接拒绝（客户端即时提示，不发请求）。
- SSRF 防护（解析 HTTP 客户端统一走 `safeClient`）：仅 https；host 必须在该 provider 白名单内；每请求前 DNS 解析并拒绝私网/回环/链路本地/CGNAT 地址；重定向目标重新过白名单（CheckRedirect）；响应体 ≤1MB；总超时 8s。
- HTTP API：`POST /api/rooms/{roomId}/links/resolve`（host 会话；body `{url}`；限流 10 次/分钟/成员）→ 200 `{platform, externalId, title, artist, album?, durationMs?, coverUrl?, playability, message?, normalizedUrl}`；错误：400 `PLATFORM_UNSUPPORTED` / 400 `INVALID_MESSAGE`（URL 非法）、502 `PROVIDER_UNAVAILABLE`（超时/不可达/解析失败，带原始原因的脱敏描述）。
- 解析结果由房主确认后经 `LIBRARY_ADD` 进曲库（Track.source 携带平台/URL/playability），后续走既有队列/屏障/失败跳过路径；无本机文件时 UI 明确提示降级（跳过或补文件）。

### OAuth（Authorization Code + PKCE，token 只在 Relay 内存）

```text
apps/relay/internal/oauth/
├─ oauth.go       # Manager：provider 配置（env）、state/verifier 暂存（10min TTL）、token 存储（绑定会话哈希）
├─ pkce.go        # code_verifier/challenge S256、state 生成
└─ store.go       # tokenSet 内存存储；会话失效回调释放；刷新轮换；撤销
```

- 配置（全部环境变量，占位值在 `.env.example`）：`LISTO_OAUTH_<PROVIDER>_CLIENT_ID`、`_CLIENT_SECRET`（公开客户端可省）、`_AUTHORIZE_URL`、`_TOKEN_URL`、`_REVOKE_URL`、`_SCOPES`。内置 provider 预置官方端点默认值，凭证必须显式提供。
- HTTP API（挂在 `/api/oauth/`，CORS 同房间 API）：

| 方法与路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /api/oauth/providers` | 会话 | `[{id, configured, connected, userLabel?, scopes?}]` |
| `POST /api/oauth/{provider}/start` | 会话 | `{authorizeUrl}`（state+PKCE challenge 已含）；未配置回 503 `OAUTH_NOT_CONFIGURED` |
| `GET /api/oauth/{provider}/callback` | 无（provider 重定向） | 校验 state → 换 token → 存内存；返回静态 HTML「授权完成/失败原因」 |
| `POST /api/oauth/{provider}/disconnect` | 会话 | 尽力撤销 + 删除 |

- token 边界（D-015，硬性，测试覆盖）：不进快照/WS 消息/邀请链接/客户端状态/日志/证据；`userLabel` 只输出打码标识；会话被 Sweep 清理时释放对应 token；relay 重启全失效。
- mock provider：Go 单测内起 httptest 授权+token+撤销端点，覆盖正常/取消/state 不匹配/code 失效/refresh 轮换/撤销/日志脱敏；smoke 覆盖未配置 503 与坏 state 400（离线可判定）。

### 封面 DataChannel（P2P，Relay 不接触）

- 房主 `HostPeerSession` 建 offer 前创建 DataChannel `listo-data`；成员端 `ondatachannel` 接收。
- 消息（JSON 文本帧）：`cover-meta{trackId,mime,totalChunks,size}` → `cover-chunk{trackId,seq,data}`（base64，每帧原始字节 ≤48KB）；收齐按 trackId 重组为 Blob → objectURL。
- 发送时机：NEXT_TRACK_START 后向所有 open 通道发当前封面；新成员通道 open 时发当前封面；(成员,trackId) 去重。>512KB 先 canvas 压缩（最长边 512px，JPEG 质量递减 0.85→0.5），仍超限放弃。
- 成员端内存 LRU 缓存 20 张；未收到显示占位。代码在 `apps/web/src/media/cover-channel.ts`（纯函数分块/重组单测）+ `cover-store.ts`（可观察缓存）。

### 歌词（TRACK_LYRICS 控制面事件）

- 解析（`apps/web/src/features/room/lyrics.ts`）：LRC 行 `[mm:ss.xx]`（可多个）→ `{timeMs, text}[]` 按 timeMs 排序；`.txt` 纯文本；元数据标签行忽略。发送前校验 ≤48KB/500 行/单行 ≤512 字符。
- Relay（`internal/room/lyrics.go`）：host 发布 → 校验+缓存（LRU 50 条）→ 转发其他在线成员；连接挂载后与屏障完成切歌时补发当前曲目缓存；超限回 `ERROR(LYRICS_TOO_LARGE)`。
- UI：`LyricsPanel` 以 500ms 房间刷新循环节奏按 `livePositionMs` 计算当前行，`aria-current="active"` 高亮；纯文本滚动显示；无歌词占位。

### 安全加固清单（Phase 4）

- HTTP 中间件：panic recovery（含房间 actor 与 ws 写泵 goroutine recover），panic 记录脱敏日志回 500。
- 限流：链接解析 10 次/分钟/成员（滑动窗口，与聊天限流同模式）。
- 消息大小：WS 帧 ≤64KB（已有）；请求体 ≤8KB（已有）；歌词 ≤48KB（新增）；DataChannel 单帧 ≤48KB 原始字节（新增）。
- XSS：外部 provider 返回的 title/artist 等一律按纯文本渲染（React 默认转义，禁止 dangerouslySetInnerHTML，测试断言恶意标题不产生 HTML 注入）。
- 环境变量新增见 `apps/relay/.env.example`；隐私与数据边界说明进 README「隐私与数据边界」。

## 性能和容量目标

这些是 MVP 的可测目标，不是未经验证的承诺：

- Relay 单实例支持 1,000 个空闲 WebSocket 连接和 100 个活跃房间的压测基线。
- 控制事件端到端 P95 延迟目标小于 300 ms（不含 TURN 音频延迟）。
- 下一首准备屏障从房主发起到开始播放的 P95 目标小于 5 秒（测试文件和网络条件需记录）。
- Relay 控制面不读取音频字节；内存随活跃房间和成员数线性增长。
- 房主上行带宽约等于编码音频码率乘成员数；超过目标人数时明确提示，不静默降级。

## 部署与开发环境

- 本地开发：一个 Go Relay、一个 Vite dev server、浏览器直接访问；STUN/TURN 地址从环境变量读取。
- 互联网测试：Relay 使用 HTTPS/WSS，TURN 使用 TLS；邀请链接只包含随机房间 token。
- 生产前：Relay 放在反向代理后，开启连接/消息限流和结构化脱敏日志；Redis、多实例和持久化房间不属于首个可运行闭环。

## 测试分层

- Go 单元测试：权限、revision、房间 actor、屏障计数、token 哈希和超时。
- TypeScript 单元测试：状态 reducer、时间计算、迟到提示和重新同步命令。
- 协议测试：所有事件 schema、未知版本、越权 sender 和过期 revision。
- 集成测试：WebSocket 建房/入房/重连、WebRTC 信令生命周期。
- 浏览器端到端：两个或三个浏览器播放测试音频，切换下一首、模拟慢网、手动重新同步并采集证据。
