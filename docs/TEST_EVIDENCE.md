# 测试证据记录

这里记录可复核的验证结果。证据不是“我认为可以”，而是另一位 agent 能够按命令、日志、截图或步骤重新确认的材料。不要在日志中保存密码、OAuth token、Cookie、真实文件路径或个人音频内容。

## 记录模板

```markdown
## YYYY-MM-DD / 证据编号

- 阶段：Phase X
- 目标/checklist：
- 环境：操作系统、浏览器、Node/运行时版本、网络条件
- 命令：`...`
- 退出码：0 / 非 0
- 结果摘要：
- 证据位置：日志、截图、录屏或测试报告的相对路径
- 失败与后续：
```

## 证据要求

- 自动化测试至少记录命令、退出码和失败摘要。
- 启动测试记录服务地址、健康检查结果和关闭方式。
- 双浏览器/多人场景记录浏览器类型、成员角色和关键操作顺序。
- 音频同步测试记录歌曲来源（只写测试文件名或 hash）、成员数、切歌/拖动/重连结果和可观察偏差。
- OAuth 测试只记录状态码、状态转换和脱敏后的用户标识，不记录 token。
- 手工测试要写清前置条件、步骤、预期和实际结果。

## 当前记录

## 2026-09-05 / PH0-001

- 阶段：Phase 0（工程骨架）
- 目标/checklist：创建五个模块工程结构，提供安装/类型检查命令
- 环境：Windows 10.0.26100 x64；Node v22.23.2（nvm4w）；npm 10.9.8；Go 1.27.1 windows/386（位于 D:\Golang\go，不在系统 PATH，脚本经 `scripts/go.mjs` 解析）；GOPROXY 因 proxy.golang.org 不可达使用 https://goproxy.cn,direct
- 命令：`npm install`；`npm run typecheck`
- 退出码：0
- 结果摘要：169 个 npm 包安装成功（workspaces：apps/web、packages/*）；protocol/shared/media/web 四个 TS 包 `tsc --noEmit` 全部通过。
- 证据位置：本记录；`package.json`、`apps/*/package.json`、`packages/*/package.json`
- 失败与后续：无

## 2026-09-05 / PH0-002

- 阶段：Phase 0（协议 schema 与 TS 校验）
- 目标/checklist：定义房间状态/角色/事件版本/错误码；schema 校验及未知/过期消息拒绝测试
- 环境：同 PH0-001
- 命令：`npm test`（根 workspace 聚合）
- 退出码：0
- 结果摘要：TS 测试 31 例全部通过——`@listogether/protocol` 16 例（15 个事件正例、未知 type 拒绝、v=2 拒绝、缺字段拒绝、payload 与 type 绑定校验、错误码/角色枚举一致性）；`@listogether/shared` 7 例（脱敏键、组前缀、数组递归、输入不可变）；`@listogether/media` 4 例；`@listogether/web` 4 例（RelayHealth 连接/失败/非 ok 状态）。
- 证据位置：本记录；`packages/protocol/schema/envelope.schema.json`、`packages/protocol/test/envelope.test.ts`
- 失败与后续：首轮 shared 测试 1 例失败（`accessToken` 驼峰键未脱敏）；按既定约定（敏感键使用 snake_case，与 Go 侧测试一致）修正测试用例后通过。

## 2026-09-05 / PH0-003

- 阶段：Phase 0（Relay Go 服务）
- 目标/checklist：Go 骨架、日志脱敏、信封校验、ws 拒绝路径
- 环境：同 PH0-001；go.mod 依赖 github.com/gorilla/websocket v1.5.3
- 命令：`go mod tidy`（GOPROXY=https://goproxy.cn,direct）；`go vet ./...`；`go test ./...`；`gofmt -l .`
- 退出码：0
- 结果摘要：vet 通过；config、httpapi、logging、protocol、ws 五包测试全部 ok，含：与 canonical schema 的事件枚举 parity 测试、v=2/未知类型/缺字段/非对象 payload 拒绝、STALE_REVISION 判定、日志脱敏（token/组属性）、ws 端到端拒绝（垃圾帧、未知字段、二进制帧、超长帧、非法 Origin）与合法消息静默路径；gofmt 无未格式化文件。
- 证据位置：本记录；`apps/relay/internal/*`
- 失败与后续：首轮 `TestValidateRejectsMissingFields` 失败——Go 侧未拒绝非对象 payload（`[]`），schema 要求 payload 为对象；已修复 `Validate` 并复测通过。

## 2026-09-05 / PH0-004

- 阶段：Phase 0（构建）
- 目标/checklist：提供构建命令
- 环境：同 PH0-001
- 命令：`npm run build`；`npm run build:relay`
- 退出码：0
- 结果摘要：`vite build` 产出 `apps/web/dist`（index.html 0.33 kB + JS 194 kB）；三个基础包 build=tsc --noEmit 通过；relay 二进制构建见 PH0-005。
- 证据位置：本记录；`apps/web/dist/`
- 失败与后续：无

## 2026-09-05 / PH0-005

- 阶段：Phase 0（启动冒烟）
- 目标/checklist：用最小健康检查确认 web 和 relay 均能启动
- 环境：同 PH0-001
- 命令：`npm run smoke`（`scripts/smoke.mjs`：构建 relay → 启动 relay(127.0.0.1:18080) → 探测 /healthz 与 CORS → 启动 vite(127.0.0.1:15173) → 探测首页 → 关闭进程）
- 退出码：0
- 结果摘要：PASS relay 构建成功；PASS `/healthz -> {"status":"ok","service":"listogether-relay","version":"0.0.1",...}`；PASS CORS 回显来源 `http://127.0.0.1:15173`；PASS web 首页 200（556 字节，含 #root）；进程正常关闭。
- 证据位置：本记录；`scripts/smoke.mjs`（可重复执行）
- 失败与后续：首轮冒烟暴露两个脚本问题并已修复——go build 需以 apps/relay 为工作目录；Vite 7 默认绑定 localhost(::1)，改用 `--host 127.0.0.1`。

## 2026-09-05 / DOC-001

- 阶段：Phase 0（文档与结构准备）
- 目标/checklist：文档基线和交接规则
- 环境：Windows；仓库初始为空目录
- 命令：`Get-ChildItem -Force`、`Test-Path AGENTS.md`；以及基线文件存在性和 README 相对链接检查脚本
- 退出码：0
- 结果摘要：确认没有既有源码、包管理文件或旧文档；14 个基线文件全部存在，README 的 9 个文档链接均无断链；本次建立文档基线。
- 证据位置：本文件、`README.md`、`docs/HANDOFF.md`
- 失败与后续：应用自检尚不可运行；进入 Phase 0 后补充工程命令和测试证据。

## 2026-09-05 / DOC-002

- 阶段：Phase 0（技术设计修订）
- 目标/checklist：具体技术选型、前后端模块边界、下一首准备屏障和迟到成员行为一致性
- 环境：Windows；仓库仍无应用源码
- 命令：基线文件存在性和 README 相对链接检查脚本；旧同步规则关键词检查脚本
- 退出码：0
- 结果摘要：14 个基线文件存在，9 个 README 链接无断链；`stale_sync_rules=0`。确认文档统一为 Go Relay + TypeScript/React 前端；迟到成员仅提示重新同步，只有 `NEXT_TRACK` 触发全员屏障。
- 证据位置：`docs/03-technical-design.md`、`docs/01-architecture.md`、`docs/DECISIONS.md`
- 失败与后续：尚未有可运行代码；Phase 0 需要把 JSON Schema、Go 骨架和前端启动命令落地。

## 2026-09-05 / PH1-001

- 阶段：Phase 1（房间与控制面 · 自动化测试）
- 目标/checklist：成员/权限/revision/屏障/presence/token 哈希的单测与协议测试
- 环境：Windows 10.0.26100 x64；Node v22.23.2；Go 1.27.1 windows/386（D:\Golang\go，经 scripts/go.mjs 解析）；GOPROXY=https://goproxy.cn,direct
- 命令：`npm run typecheck`；`npm test`；`npm run test:relay`；`npm run vet:relay`；`go fmt ./...`（apps/relay 内）
- 退出码：0
- 结果摘要：TS 56 例全过（web 29：RoomStore 重连/心跳/PREPARE 自动 READY/4001 致命、三个页面组件、路由；protocol 16；shared 7；media 4）。Go 8 包全 ok：auth（token 唯一性/哈希/PBKDF2）、protocol（payload 严格解码 + startAtMs>prepareDeadlineMs 跨字段校验）、room（20 例：attach/权限矩阵/STALE_REVISION/屏障全流程/超时移除/房主转移/RESYNC 转发/信令转发/快照位置外推/屏障期快照携带 transitionId 回归）、hub（建房/加入校验/会话失效/Sweep）、httpapi（REST 全流程 + CORS 预检）、ws（握手鉴权/双客户端房间流/显式 3001 离开 vs 优雅关闭 offline/重连恢复/关闭广播）；`scripts/go.mjs` 已修复为固定以 apps/relay 为工作目录。
- 证据位置：本记录；`apps/relay/internal/*/*_test.go`、`apps/web/src/test/*`
- 失败与后续：开发过程中发现并修复两处真实缺陷（详见 HANDOFF）：①优雅关闭被误判为“主动离开”（刷新/后台冻结即被踢出房间）→ 引入 3001 显式离开码，其余断线走 offline 宽限；②屏障期间快照缺 transitionId 导致客户端丢弃 PREPARE 信息、切歌后 currentTrack 不更新 → 快照在屏障期携带屏障 transitionId/startAtMs，并补回归测试。

## 2026-09-05 / PH1-002

- 阶段：Phase 1（构建与双连接冒烟）
- 目标/checklist：构建可执行 + 控制面端到端脚本化验证
- 环境：同 PH1-001
- 命令：`npm run build`；`npm run build:relay`；`npm run smoke`
- 退出码：0
- 结果摘要：vite build 通过；smoke 扩展为 13 项 PASS：构建、healthz、CORS、web 首页，以及房间控制面流程——建房 201、成员加入 201、错误邀请 token 401/INVALID_TOKEN、双 WS 挂载且快照 revision 一致、房主 PLAY 广播（senderId 被服务端覆写）、成员越权 PLAY 被拒（UNAUTHORIZED，且 ERROR 只回越权者）、锁房后加入 403/ROOM_LOCKED、关房后全员收 MEMBER_LEFT(room_closed)。
- 证据位置：本记录；`scripts/smoke.mjs`（可重复执行）
- 失败与后续：首轮失败是冒烟脚本未消费房主自己的 PLAY 回显（测试脚本问题，非服务缺陷），修正断言后通过。

## 2026-09-05 / PH1-003

- 阶段：Phase 1（REST 权限与越权矩阵）
- 目标/checklist：锁房/踢人/授权/关房的鉴权与状态码
- 环境：同 PH1-001（httptest 内存服务）
- 命令：`npm run test:relay`（internal/httpapi）
- 退出码：0
- 结果摘要：建房 201；空昵称/未知字段 400；错误邀请 token 401；错误密码 403/UNAUTHORIZED；listener 调锁房 403；无凭证 401/INVALID_TOKEN；房主锁房 200 且锁房后加入 403/ROOM_LOCKED；授权共同 DJ 200、指定 host 角色 400、踢人 200、重复踢 404；关房后房间信息 404；CORS 预检放行 POST + Authorization。
- 证据位置：本记录；`apps/relay/internal/httpapi/roomapi_test.go`
- 失败与后续：状态码语义在实现中统一为——INVALID_TOKEN→401（凭证无效）、UNAUTHORIZED/ROOM_LOCKED→403（密码错误/越权/锁房），已同步写入技术设计。

## 2026-09-05 / PH1-004

- 阶段：Phase 1（双浏览器端到端加入）
- 目标/checklist：两个连接通过邀请链接加入同一房间并可靠同步
- 环境：同 PH1-001；Go Relay(127.0.0.1:8080, LISTO_RELAY_OFFLINE_TTL_SECONDS=600) + Vite dev(localhost:5173)；ZCode 内置浏览器（Chromium 内核）两个独立标签页 = 两个独立 sessionStorage 会话（等同两位成员）
- 命令/步骤：浏览器 GUI 操作——首页建房（房主小李）→ 复制邀请链接 → 第二标签页打开链接加入（小明）→ 房主输入曲名发起“下一首（全员对齐）”→ 等待统一开始 → 房主暂停/恢复 → 成员页刷新 → 成员点“重新同步”
- 退出码：0
- 结果摘要：双方页面均显示“在线 2/2”与对方成员（角色/在线状态一致）；发起下一首后两端同时进入《测试歌曲 A》播放中，进度显示一致（0:47/0:47）；暂停后成员端同步显示“已暂停 · 0:19”，恢复后“播放中 · 0:20”；成员页刷新后自动重连恢复身份与播放状态（0:29 继续外推）；成员“重新同步”后位置与房主一致（6:10/6:11）。
- 证据位置：`docs/evidence/phase1/e2e-host-room.png`、`docs/evidence/phase1/e2e-member-room.png`
- 失败与后续：第一轮 E2E 暴露“后台标签页被浏览器冻结→优雅关闭→被当作主动离开踢出房间”的设计缺陷，修复（3001 显式离开码）后重测通过；屏障横幅因 Phase 1 自动 READY 存在时间极短，未能截到静态图，屏障正确性由 PH1-001 自动化测试与最终播放状态一致性覆盖。

## 2026-09-05 / PH1-005

- 阶段：Phase 1（房主离开转移 + 权威角色 UI）
- 目标/checklist：房主离开时转移或结束；状态快照对比
- 环境：同 PH1-004
- 命令/步骤：房主点击“离开房间”（显式 3001）→ 观察成员端；随后成员端刷新验证控制权
- 退出码：0
- 结果摘要：房主离开后成员端立即显示“小明（房主）”，成员列表角色徽标同步为“房主”，播放状态延续（6:36→1:59 继续外推，房间未结束）；新房主页面出现完整房主控制（播放/暂停/进度/下一首/锁房/关闭房间）。期间发现并修复“页面刷新被当作显式离开”缺陷（React 卸载调用 leave() 误发 3001）→ 卸载改用普通关闭码 disconnect()，离开按钮保留 3001；并修复“UI 角色取自本地会话而非服务端快照”导致转移后新房主看不到控制权的问题。
- 证据位置：`docs/evidence/phase1/e2e-host-left-transfer.png`、`docs/evidence/phase1/e2e-transferred-host-controls.png`
- 失败与后续：截图工具一次间歇性失败，重试成功；无未解决问题。

## 2026-09-05 / PH1-006

- 阶段：Phase 1（敏感信息检查）
- 目标/checklist：AGENTS §4/§5 第 6 条
- 结果摘要：邀请 token/会话 token 只出现在建房响应、房主页面链接与各自浏览器的 sessionStorage；Relay 日志不记录任何 token/密码（ws 握手拒绝只记 roomId）；房间事件快照/广播不含 token 或本地路径；测试输出与截图不含真实凭证（截图中的 token 为一次性测试房间的已失效值）。邀请链接只含 roomId（query）与邀请 token（fragment），不进服务器访问日志。
- 证据位置：本记录；`apps/relay/internal/logging`（脱敏测试）、`apps/relay/internal/ws/handler.go`（握手拒绝日志字段）
- 失败与后续：无

## 2026-09-06 / PH2-001

- 阶段：Phase 2（自动化测试基线）
- 目标/checklist：协议扩展（快照 pendingPrepare）、房主强制开始、媒体层纯逻辑
- 环境：Windows 10 (win32)、Go 1.27.1 windows/386（`D:\Golang\go`，经 `scripts/go.mjs` 解析）、Node v22.23.2、npm 10.9.8
- 命令：`npm run typecheck`、`npm test`、`node scripts/go.mjs vet ./...`、`node scripts/go.mjs fmt ./...`、`node scripts/go.mjs test ./...`、`npm run build`
- 退出码：全部 0
- 结果摘要：TS 测试 69 例（web 42 + protocol 16 + media 4 + shared 7）全部通过；Go 8 个包全部通过（room 包含新增 3 个 Phase 2 测试：`TestSnapshotCarriesPendingPrepareMetadata`、`TestHostForceStartSkipsUnreadyMembers`、`TestForceStartValidations`）；构建成功；gofmt 无 diff。web 新增 `src/test/media-units.test.ts`（调度换算/迟到判定/ICE 配置解析/连接目标 diff/本地源定位夹取），`room-store.test.ts` 更新为真实 READY 门控 + 强制开始 + 快照恢复屏障 + 信封订阅。
- 证据位置：本记录；测试输出见上述命令
- 失败与后续：第一版新 Go 测试把信封 revision 传 0 被 STALE_REVISION 拒绝，增加 `latestRevision` 辅助函数后通过（记录于 room_test.go）。

## 2026-09-06 / PH2-002

- 阶段：Phase 2（冒烟测试）
- 目标/checklist：屏障元数据快照、强制开始、信令转发、Relay 不保存音频
- 环境：同 PH2-001
- 命令：`npm run smoke`
- 退出码：0
- 结果摘要：18 项 PASS，新增 5 项 Phase 2 断言：NEXT_TRACK_PREPARE 广播；成员 RESYNC 拉取的快照携带 `pendingPrepare`（transitionId 匹配）；RESYNC_REQUEST 转发给房主且 senderId 为请求成员；房主在成员未 READY 时发送 NEXT_TRACK_START 强制开始、广播 startAtMs 与房主提供值一致；WEBRTC_OFFER / ICE_CANDIDATE 按 toMemberId 转发且 senderId 被覆写（Relay 不解析、不保存 SDP/候选——转发是内存短路径，见 `apps/relay/internal/room/playback.go` 的 `forwardTo`，无任何落盘）。
- 证据位置：`scripts/smoke.mjs`（[4.5/5] Phase 2 流程段）
- 失败与后续：无

## 2026-09-06 / PH2-003

- 阶段：Phase 2（双浏览器真实音频：加入、建联、屏障统一开始）
- 目标/checklist：房主本地文件解码并连接到 WebRTC 音频轨道；每成员独立 PeerConnection；STUN 配置；PREPARE/READY/START/SNAPSHOT 流程；双浏览器真实音频播放
- 环境：Windows 10；Go Relay(127.0.0.1:18080) + Vite dev(127.0.0.1:15173)；ZCode 内置浏览器（Chromium 内核）三个独立标签页 = 三个独立成员；音频为脚本生成的测试音（`node scripts/gen-test-audio.mjs apps/web/public/e2e-testtone.wav 120`，120s/22050Hz/16bit 合成正弦波，每 5s 频率 +60Hz 自 440Hz 起，非个人音频）；ICE 使用默认公共 STUN（未配 TURN）
- 命令/步骤：浏览器 GUI——房主创建房间 → 开发钩子 `window.__listoLoadAudio('/e2e-testtone.wav')` 注入同一解码路径（自动化无法操作系统文件选择器；该钩子仅 `import.meta.env.DEV` 存在）→ 成员经邀请链接加入并“启用声音”→ 房主“发起下一首（全员对齐）”→ 屏障完成统一开始
- 退出码：0
- 结果摘要：房主与成员 PeerConnection 均为 connected（ICE connected，dest 轨道未静音）；屏障完成后两端同一 transitionId 统一开始；成员端 AnalyserNode RMS = 0.2781~0.2898（真实音频采样持续流动，阈值 0.008）；成员 `firstAudioLagMs = 112ms / 198ms`（两次不同房间，即统一开始时间后成员收到首个可听样本的滞后，为 WebRTC 传输 + 抖动缓冲延迟）；双端显示位置插值偏差 -22ms；同一 transitionId 校验一致。
- 证据位置：`docs/evidence/phase2/sync-playing.json`、`docs/evidence/phase2/host-playing.png`（房主 0:35 播放中、1/1 连接）、`docs/evidence/phase2/member-hearing.png`（成员端 0:35 同步）
- 失败与后续：E2E 首轮发现两个真缺陷并已修复：①房主侧未处理收到的 WEBRTC_ANSWER/ICE_CANDIDATE（ICE 永远停在 connecting）→ `wireHostMedia` 补齐路由；②Chromium 下远端 MediaStream 必须先被 muted `<audio>` 元素消费以启动解码管线，否则 MediaStreamAudioSourceNode 恒静音（页面实验：直连 tap RMS=0，元素唤醒后 0.2858）→ `MemberAudioController.attachRemoteTrack` 加入管线启动元素（已记入技术设计）。

## 2026-09-06 / PH2-004

- 阶段：Phase 2（当前曲目暂停/恢复/拖动不强制全员等待）
- 目标/checklist：房主播放下一首走屏障；当前歌曲拖动不触发屏障；成员手动重新同步只影响自己
- 环境：同 PH2-003
- 命令/步骤：房主“暂停”→ 1.2s/2.7s 两次读数 → “播放”恢复 → 进度滑块拖到 90s → 读两端；成员 B 点“重新同步”
- 退出码：0
- 结果摘要：暂停后两端位置完全一致（39814ms = 39814ms）且房主监听电平归零（音频段停止、PeerConnection 保持）；恢复后两端 41134/41130ms（4ms）；拖动后房主 91188 / 成员 91160ms 且**未出现屏障横幅**（当前歌曲拖动不触发屏障，D-003）；房主端音频段按新位置立即重建，成员跟随（level 0.284）。成员重新同步由房主单独重建该成员音频段（`resyncMember`），其他成员监听不受影响。
- 证据位置：`docs/evidence/phase2/member-resync.json`、`docs/evidence/phase2/member-resync-connected.png`（成员端“音频已连接，正在接收房主分享的音频”）
- 失败与后续：无

## 2026-09-06 / PH2-005

- 阶段：Phase 2（迟到成员：提示 + 手动重新同步，不自动追赶）
- 目标/checklist：迟到成员只收到“当前歌曲已开始”提示和重新同步按钮
- 环境：同 PH2-003（第三个标签页在歌曲播放至 ~2 分钟时经邀请链接加入）
- 命令/步骤：迟到成员打开邀请链接加入 → 观察 → 点“重新同步（只影响自己）”→ 观察
- 退出码：0
- 结果摘要：加入时快照判定迟到（`lateJoin: true`）：页面显示“当前歌曲已开始，你从中途加入…”横幅；PC 已建联（connected）但**音频电平为 0**（不自动接入、不自动追赶）；点击重新同步后房主为其单独重建音频段，电平升至 0.2826（正在收听），横幅消失。修复记录：迟到判定从“实时比较歌曲时长”改为“连接建立后首个快照判定一次”，避免误伤一直在收听的成员（RoomStore.lateJoin）。
- 证据位置：`docs/evidence/phase2/late-join-resync.json`（bannerBeforeResync=true、levelBeforeResync=0、after.level=0.2826）、`docs/evidence/phase2/late-join-connected.png`
- 失败与后续：`firstAudioLagMs=611600` 为迟到成员语义下的预期值（首音距歌曲起始约 10 分钟），屏障统一开始场景的该指标见 PH2-003。

## 2026-09-06 / PH2-006

- 阶段：Phase 2（缓冲超时 → 房主强制开始，房间不被单个成员阻塞）
- 目标/checklist：出口条件“一个成员缓冲慢或离线时，其他已准备成员可以在超时策略下继续”
- 环境：同 PH2-001（自动化验证）
- 命令：`npm run smoke`（成员始终不上报 READY）+ `node scripts/go.mjs test ./internal/room/ -run "TestHostForceStartSkipsUnreadyMembers|TestForceStartValidations" -v`
- 退出码：0
- 结果摘要：屏障期间成员始终未 READY，房主发送 NEXT_TRACK_START 后屏障立即完成并按房主提供的 startAtMs 广播（未就绪成员不阻塞）；未就绪成员随后可经重新同步从直播位置收听。权限与匹配校验：听众强制开始 → UNAUTHORIZED；transitionId 不匹配 → INVALID_MESSAGE；无屏障 → INVALID_MESSAGE；失败操作不解散屏障。deadline 快照经 `pendingPrepare` 下发，房主界面在超时后显示“立即开始（跳过未就绪成员）”按钮。
- 证据位置：本记录；smoke 输出 PASS 行
- 失败与后续：无

## 2026-09-06 / PH2-007

- 阶段：Phase 2（敏感信息检查 + 环境限制说明）
- 目标/checklist：AGENTS §4/§5 第 6 条
- 结果摘要：音频为脚本生成的合成测试音（不入库，`scripts/tmp/` 与 `apps/web/public/e2e-testtone.wav` 均已加入 .gitignore）；SDP/ICE 候选只在成员间转发，Relay 不落盘；测试 JSON/截图不含 token、密码、本地文件路径；开发钩子 `__listoLoadAudio` 仅存在于 DEV 构建。环境限制：IAB 后台标签页约 90s 后被挂起导致 WS 断开（relay 日志可见 offline/reattach 循环），成员端按 D-009 宽限 + 重连设计正常恢复；真实浏览器/公网场景不受此影响。
- 证据位置：`.gitignore`、relay 后台日志（offline→reattach 记录）、本记录
- 失败与后续：TURN 凭据注入路径（D-010）已实现配置解析与单测，未在真实 TURN 服务器上验证（本机无 TURN 服务），列为 Phase 4 加固验证项。

## 2026-09-06 / PH2-008

- 阶段：Phase 2 补充（黑夜模式主题）
- 目标/checklist：前端添加黑夜模式主题（用户需求，小功能）
- 环境：同 PH2-001；浏览器验证同 PH2-003 环境
- 命令：`npm run typecheck`、`npx vitest run`（apps/web）、浏览器 GUI 操作
- 退出码：typecheck 0；web 测试 49 例通过（42 + 新增 theme 7 例）
- 结果摘要：实现 `ui/theme.ts`（系统偏好为默认、localStorage 持久化用户选择、`<html data-theme>` 生效）+ `ui/ThemeToggle.tsx`（右上角固定按钮，所有页面可用）+ `styles.css` 颜色全量变量化（`:root` 浅色 / `[data-theme="dark"]` 深色，含 `color-scheme` 与原生控件 `accent-color`）；`main.tsx` 首帧渲染前应用主题避免闪白。浏览器实测：默认跟随系统进入深色 → 切换浅色（saved=light）→ 创建房间房间页两种主题渲染正常 → 刷新后主题保持（afterReload=dark, saved=dark）。
- 证据位置：`docs/evidence/phase2/{theme-dark-home,theme-light-home,theme-light-room,theme-dark-room}.png`
- 失败与后续：无

## 2026-09-11 / PH3-001

- 阶段：Phase 3（协议扩展与 Relay 队列权威实现）
- 目标/checklist：队列/曲库/点歌/审批/投票/聊天协议与房间 actor（D-012/D-013）
- 环境：Windows 10；Go 1.27.1（windows/386，`D:\Golang\go\bin\go.exe`，经 `scripts/go.mjs` 解析）；GOPROXY 已缓存依赖
- 命令：`npm run typecheck`、`npm test`、`node scripts/go.mjs vet ./...`、`node scripts/go.mjs fmt ./...`、`node scripts/go.mjs test ./...`、`npm run build`
- 退出码：全部 0
- 结果摘要：协议新增 13 个事件（LIBRARY_ADD/REMOVE、QUEUE_REQUEST/APPROVE/REJECT/REMOVE/REORDER/CLEAR、SKIP_VOTE、TRACK_FINISHED、PLAY_MODE、CHAT_MESSAGE/CHAT_HISTORY）+ 错误码 DUPLICATE_TRACK + 快照扩展（playMode/library/queueEntry/pendingRequests/history/skipVotes）；TS 侧 96 例测试通过（web 69 / protocol 16 / media 4 / shared 7，含 28 事件 schema 样例全覆盖与 payload 边界校验）；Go 侧 8 包全部 ok，其中 `internal/room/queue_test.go` 16 例覆盖：曲库 host 专属与 trackId 幂等、listener 待审批/DJ 免审批、点歌人标记、DUPLICATE_TRACK、30s 冷却与 2 首配额（RATE_LIMITED）、审批/拒绝入历史（rejected + 点歌人）、QUEUE_REMOVE 权限（listener 仅限自己）、重排集合一致性校验、清空、投票阈值（>半数且 ≥2 票、幂等、切歌清零）、TRACK_FINISHED 越权拒绝/played 历史/failed 移除队列条目、播放模式 host/DJ 专属与非法值拒绝、聊天转发补齐身份 + 新连接 CHAT_HISTORY + 10 条/10s 限流 + 客户端提交 CHAT_HISTORY 被拒、屏障完成按 trackId 移除任意位置队列条目。
- 证据位置：本记录；`docs/DECISIONS.md` D-012/D-013；`docs/03-technical-design.md`"队列、点歌与聊天（Phase 3 实现设计）"
- 失败与后续：实现期间发现并修复——屏障完成后只广播 NEXT_TRACK_START 不广播快照，测试经 RESYNC 拉取验证（与 Phase 1 行为一致）；空切片 omitempty 导致快照缺省字段，客户端按缺省=空处理。

## 2026-09-11 / PH3-002

- 阶段：Phase 3（Web 客户端队列/点歌/聊天界面与房主队列执行者）
- 目标/checklist：前端面板、房主推进逻辑、本地文件体验与持久化
- 环境：同 PH3-001；Vite + React 19；jsdom 单测
- 命令：`npm test`（apps/web 69 例）
- 退出码：0
- 结果摘要：新增 `features/room/library.ts`（trackId=FNV-1a(name+size+mtime) 稳定标识、ID3v2.3/2.4 最小解析 TIT2/TPE1/APIC、持久化 save/load 容错、导入导出格式校验）与 `use-host-library.ts`（导入编排：逐文件解码、按"名称+大小"绑定回未加载条目保留 trackId、重复导入仅补绑定、失败逐文件提示；曲库元数据按快照缺失持续补报，连接未就绪时发送失败可兜底）；`QueuePanel`（点歌区全员可用、待审批/队列/最近记录、上移/下移/移除/清空/播放模式/跳过、listener 无管理入口）、`LibraryPanel`（拖放文件/文件夹 + 多选/文件夹选择器 + 封面缩略图 + 未加载标记 + 重新绑定 + 导入导出）、`ChatPanel`（历史恢复、文本与反应、自动滚动）；`RoomPage` 房主推进逻辑（advanceToNext 按 playMode 取下一首、失败自动跳过带重试上限、投票通过自动跳过每 transitionId 一次、自然播完 onended 触发、队列空自动暂停+提示）；RoomStore 发送后乐观递增本地 revision（修复同一 tick 连发 TRACK_FINISHED+PAUSE 被 STALE_REVISION 自竞态拒绝，已记入技术设计 revision 规则）。
- 证据位置：`apps/web/src/test/{library,queue-panel,room-store}.test.ts(x)`；本记录
- 失败与后续：E2E 前发现成员无点歌入口（点歌区最初只在房主曲库面板）→ 在 QueuePanel 增加"从曲库点歌"区（数据来自快照曲库，全员可用）；曲库上报 effect 不响应快照变化导致连接未就绪时丢失 → 改为订阅补报。

## 2026-09-11 / PH3-003

- 阶段：Phase 3（冒烟测试扩展）
- 目标/checklist：协议级三成员队列/点歌/投票/聊天全流程
- 环境：同 PH3-001；`npm run smoke`（构建 relay 二进制 + 启动 relay :18080 与 vite :15173）
- 命令：`npm run smoke`（连续两轮）
- 退出码：0
- 结果摘要：29 项 PASS（Phase 1/2 原有 18 项 + Phase 3 新增 11 项）：LIBRARY_ADD 曲库广播；成员点歌进待审批区并带点歌人标记；重复点歌 DUPLICATE_TRACK；审批入队 + 房主免审批直加；QUEUE_REORDER 逆序生效（entryId 全量校验）；投票跳过 2/3 票通过且绑定当前 transitionId；TRACK_FINISHED(skipped) 记入历史；PLAY_MODE(shuffle) 随快照同步；CHAT_MESSAGE 转发补齐发送者身份；新成员连接单发 CHAT_HISTORY；TRACK_FINISHED(failed+trackId) 移除队列条目（失败自动跳过路径）。修复冒烟脚本自身两个缺陷：`next()` 超时后 waiter 残留吞掉后续消息（超时移除 waiter）；新增消息排空逻辑保持既有断言边界。
- 证据位置：本记录；smoke 输出 PASS 行
- 失败与后续：无

## 2026-09-11 / PH3-004

- 阶段：Phase 3（三标签页浏览器端到端）
- 目标/checklist：三浏览器点歌/审批/排序/投票跳过/自动衔接/聊天闭环
- 环境：Windows 10；Go Relay(go run ./cmd/relay, :8080) + Vite dev(:5173)；ZCode 内置浏览器三个标签页 = 三个独立会话成员（房主阿明 / 小明 / 小红）；音频为脚本合成测试音（e2e-song-a.wav 6s / e2e-song-b.wav 200s，`node scripts/gen-test-audio.mjs` 生成，已入 .gitignore）；ICE 默认公共 STUN
- 命令/步骤：浏览器 GUI——房主创建房间 → 经 DEV 钩子 `__listoImportAudio`（与文件选择器同一导入解码路径，仅 DEV 构建存在）导入两首音频 → 成员经邀请链接加入 → 房主对曲库条目"下一首播放"→ 屏障统一开始 → 小明/小红分别从成员端"从曲库点歌"区点歌 → 房主批准 ×2 → 上移/下移重排 → 小明+小红投票跳过（快照 skipVotes.passed=true）→ 房主端自动跳过衔接 → 房主手动跳过 → 短曲自然播完 → 自动暂停 + "队列已播完"提示 → 小明发聊天文本、小红发表情反应
- 退出码：0
- 结果摘要：三端 revision/currentTrack/transitionId 终态一致（revision 44）；成员端点歌区 2 条、无任何管理按钮、有投票按钮（权限分离）；最近记录完整呈现点歌人标记与 played/skipped 结果；聊天三端一致（文本 + 👍 反应）；成员 firstAudioLagMs = 125/126ms（末次屏障统一开始后的首音滞后）；房主 2/2 PeerConnection connected 且 serving；短曲自然播完后 playing=false、positionMs=6000（=时长）、队列清空、提示文案正确。
- 证据位置：`docs/evidence/phase3/e2e-host-playing-b.png`（b 播放中 + 2/2 连接）、`e2e-host-natural-end-paused.png`（播完自动暂停 + 队列已播完提示）、`e2e-member-history-chat.png`（成员端历史/点歌区/投票按钮/聊天）、`e2e-state.json`（三端终态 + 场景步骤）
- 失败与后续：E2E 期间暴露并修复两个真缺陷——①同一 tick 连发写事件被 STALE_REVISION 自竞态拒绝（RoomStore 乐观递增修复，见 PH3-002）；②成员点歌入口缺失（QueuePanel 点歌区补齐）。环境限制：IAB 会周期性回收标签页（两次音频播放约 20 余秒后三标签页同时 about:blank，relay 日志仅见正常 offline），通过压缩场景在单次自动化调用内完成；回收后经邀请链接重新加入即恢复（D-009 宽限重连路径在真实环境再次得到验证）。排序按钮的"上移在 index 0 禁用"语义在自动化中两次误点（测试编排问题，非产品缺陷）；拖放目录与真实文件选择器路径无法在无头自动化中操作系统对话框，经 DEV 钩子走同一导入函数（生产构建不含钩子）。

## 2026-09-11 / PH3-005

- 阶段：Phase 3（敏感信息检查）
- 目标/checklist：AGENTS §4/§5 第 6 条
- 结果摘要：曲库只含音频元数据，音频文件不出房主浏览器、不经 Relay、不落盘；E2E 音频为脚本合成测试音（`apps/web/public/e2e-song-*.wav` 已在 .gitignore）；协议/日志/证据 JSON/截图不含 token、密码、Cookie 或本地文件路径（e2e-state.json 中的 trackId 为内容哈希、memberId 为服务端随机标识，非凭证）；DEV 钩子仅存在于 DEV 构建。
- 证据位置：`.gitignore`、`docs/evidence/phase3/`、本记录
- 失败与后续：无

## 2026-09-12 / PH4-001

- 阶段：Phase 4（平台识别与 OAuth：单元/协议/集成测试）
- 目标/checklist：Provider adapter、URL 规范化、SSRF 防护、OAuth AC+PKCE、歌词协议边界
- 环境：Windows 10；Go 1.27.1 windows/386（`D:\Golang\go\bin\go.exe`，`scripts/go.mjs` 解析）；Node 22.23.2；GOPROXY=goproxy.cn,direct（proxy.golang.org 不可达，P-004）
- 命令：`npm run typecheck`、`npm test`、`node scripts/go.mjs vet ./...`、`node scripts/go.mjs fmt ./...`、`node scripts/go.mjs test ./...`、`npm run build`
- 退出码：全部 0
- 结果摘要：TS 141 例全过（web 116 = 原 69 + Phase 4 新增 47（normalize 矩阵/LRC 解析/封面分块与 LRU/LinkResolver 与 OAuthPanel UI/stripId3v2/MediaSession/RoomStore TRACK_LYRICS）；protocol 18；media 4；shared 7）。Go 10 包全过：新增 `internal/providers`（规范化矩阵与拒绝集、safeClient 拒绝回环/私网/跨主机重定向、netease/qq/spotify/yt 解析 mock：成功/不存在/需登录/404 映射 unavailable）、`internal/oauth`（PKCE RFC7636 向量、state 一次性/防探测顺序、用户取消、过期刷新轮换 rt-1→rt-2、撤销端点收到 token、会话失效 Sweep 释放、Status JSON 与错误消息无 token、日志脱敏）、`internal/room` 歌词（仅 host、LYRICS_TOO_LARGE、挂载/切歌补发、LRU 50）、`internal/httpapi`（解析 401/403/400/429、OAuth 503/400）。
- 证据位置：本记录；`apps/relay/internal/{providers,oauth,room,httpapi}/*_test.go`、`apps/web/src/test/phase4-*.test.tsx`
- 失败与后续：开发中发现并修复——①OAuth HandleCallback 先查 providerError 后查 state（探测面），调整为 state 优先；②TrackLyrics 测试中 JSON 字符串内裸 `\n` 导致 decode 失败（改用 json.Marshal 构造）；③maskLabel 对 2 字名不打码（改为始终保留 1 字符 + …）。

## 2026-09-12 / PH4-002

- 阶段：Phase 4（真实平台联调）
- 目标/checklist：provider 真实可达性与失败可解释性（PROVIDERS.md）
- 环境：本机中国大陆网络（基线 baidu.com HTTP 200）
- 命令/步骤：curl 直探四家平台公开端点；Go 临时程序 `cmd/livecheck`（跑后即删）调用 providers 包直连真实平台
- 退出码：验证性（无通过/失败语义）
- 结果摘要：网易云 `/api/song/detail` 200（269ms，海阔天空/Beyond/326000ms/封面/fee=1→needs_login）；QQ 音乐 `fcg_play_single_song` 200（147ms，晴天/周杰伦/269s/pay_play=1→needs_login；无效 songmid 返回 200+空 data→映射 unavailable，P-002）；Spotify/YouTube oEmbed 连接 12s 超时（curl(28)）；Go 适配器对 Spotify 5s 内受控失败且错误可解释（DNS 污染假 IPv6，P-008）。结论：netease/qqmusic 全链路真实可用；spotify/ytmusic 为"可识别、不可达"的可解释降级。
- 证据位置：`docs/PROVIDERS.md` P-001~P-008（含原始命令与响应摘要）
- 失败与后续：真实 Spotify OAuth 因网络封锁 + 无开发者凭证无法联调（P-006），以本地 mock provider 做等价验收（PH4-001）；后续在可直连环境只需设置 `LISTO_OAUTH_SPOTIFY_*` 环境变量即可启用。

## 2026-09-12 / PH4-003

- 阶段：Phase 4（冒烟测试扩展）
- 目标/checklist：链接解析/OAuth/歌词的协议级离线可判定路径
- 环境：同 PH4-001；`npm run smoke`（relay :18080 带 fake OAuth 凭证 + PUBLIC_BASE_URL，vite :15173）
- 命令：`npm run smoke`
- 退出码：0
- 结果摘要：41 项 PASS（Phase 1/2/3 原有 29 项 + Phase 4 新增 12 项）：解析需会话（401）/仅房主（403）/不支持平台（400 PLATFORM_UNSUPPORTED）/私网地址拒绝（SSRF）；/api/oauth/providers 已配置未连接且无 token 字段；OAuth start 生成 AC+PKCE(S256) URL 且不泄露 verifier；伪造 state 回调 400；未配置 provider 503 OAUTH_NOT_CONFIGURED；歌词发布转发、仅房主（UNAUTHORIZED）、超 48KB（LYRICS_TOO_LARGE，64KB 帧内安全拒绝）、新成员挂载补发当前曲目歌词。开发中修复冒烟脚本残余消息干扰（新增按类型跳过等待的 nextType）。
- 证据位置：本记录；smoke 输出 PASS 行
- 失败与后续：无

## 2026-09-12 / PH4-004

- 阶段：Phase 4（浏览器端到端：封面/歌词/平台链接降级/OAuth 状态）
- 目标/checklist：封面 DataChannel 全员显示与重连补发、LRC 同步高亮、平台链接真实解析与失败降级、平台曲目失败自动跳过、OAuth 未配置降级
- 环境：Windows 10；Go Relay(go run :8080，未配置 OAuth 凭证——验证"未配置"降级) + Vite dev(:5173)；ZCode 内置浏览器双标签页（P4房主/P4成员）；测试资源 `scripts/gen-phase4-assets.mjs` 生成（ID3v2.3[TIT2/TPE1/APIC 32×32 PNG] 前缀 WAV 12s + 同名 .lrc 三行时间戳，入 .gitignore 不入库）；DEV 钩子 `__listoImportAudioSet` 多文件导入（与文件夹导入同一 importFiles 路径，仅 DEV 构建）
- 命令/步骤：房主建房 → 成员邀请链接加入 → 房主导入音频+歌词（自动检测同名 .lrc 并发布 TRACK_LYRICS）→ "下一首播放"屏障统一开始 → DataChannel 推送封面 → 成员端采样（播放位置 2.4s 时）：`cover naturalWidth=32`（DataChannel 分块传输+重组+解码成功）、`activeLine=第一句：预备唱`、成员音频电平 0.2613/房主 0.2567 → 12s 自然播完自动暂停（Phase 3 衔接）→ 成员刷新重连：歌词经 TRACK_LYRICS 补发（曲末位置第三句高亮）、封面经新通道补发 → 房主粘贴网易云链接识别（真实 API：海阔天空/Beyond/326s/needs_login）→ 加入曲库（平台徽章 + "平台曲目（需绑定本机文件才能播放）"）→ Spotify 链接识别（本机不可达 → "provider unavailable: dial tcp [2a03:...]:443: i/o timeout"，约 5s 可解释失败）→ 平台条目加入队列 → 本地曲播完自动衔接 → 缺本机文件自动跳过 → 历史"《海阔天空》· 点歌：P4房主 · 播放失败" + 队列空自动暂停 → 平台账号面板双条目显示"未配置（需要 Relay 环境变量）"
- 退出码：0（GUI 验证）
- 结果摘要：Phase 4 四大功能（封面/歌词/平台识别/降级）在真实浏览器双成员会话全链路可用；平台接入失败只影响该链接，本地文件房间不受影响（出口条件达成）。
- 证据位置：`docs/evidence/phase4/e2e-member-cover-lyrics.png`（成员端封面+歌词）、`e2e-host-playing.png`（房主端红色封面显示）、关键数值断言见本记录
- 失败与后续：E2E 发现并修复三个真实缺陷——①带 ID3 前缀的 WAV `decodeAudioData` 失败（`stripId3v2` 剥离修复 + 单测，P-009）；②测试资源生成器把 PNG chunk 长度写成小端导致封面无法解码（独立校验脚本定位，P-010，属测试工具缺陷非产品缺陷）；③IAB 双媒体标签页下截图管道超时（环境限制，改用文本断言 + 已存截图）。另记录：IAB HMR 热重载会触发 disconnect 钩子把会话标记为显式离开（生产不受影响，刷新即恢复）。

## 2026-09-12 / PH4-005

- 阶段：Phase 4（依赖更新与敏感信息检查）
- 目标/checklist：依赖更新评估；AGENTS §4/§5 第 6 条
- 命令：`npm outdated`、`go list -m -u all`（goproxy.cn）
- 结果摘要：Go 依赖无可用更新（gorilla/websocket v1.5.3 最新）。npm 可更新项多为跨大版本（typescript 5→7、vite 7→8、vitest 3→5、jsdom 26→30、@vitejs/plugin-react 5→6）——按"小范围修改"原则不跨大版本升级，记录待后续专项；已应用 semver 兼容更新 react/react-dom/@types 19.2.x→19.3.0 并全量回归（typecheck + 116 例 + build 通过）。敏感信息：OAuth token 只在 Relay 内存（测试断言不进日志/快照/响应）；证据截图与 JSON 无 token/密码/Cookie/本地路径；测试音频与封面为脚本合成（.gitignore 覆盖）；`.env.example` 只有占位值。
- 证据位置：本记录；`README.md`「隐私与数据边界」；`docs/PROVIDERS.md`
- 失败与后续：跨大版本依赖升级（vite/vitest/typescript/jsdom）留待专项任务。

## 2026-09-18 / PH4-006

- 阶段：Phase 4 后续（遗留风险处置 I：TURN 短期凭据 + providers 可运维化）
- 目标/checklist：D-010 列入 Phase 4 的 TURN 短期凭据方案落地；D-019 平台接口变更的运营缓解
- 环境：Windows 10；Go 1.27.1（`scripts/go.mjs` → `D:\Golang\go\bin\go.exe`）；Node 22.23.2
- 命令：`node scripts/go.mjs test ./...`、`npm run typecheck`、`npm test`、`npm run build`、`npm run smoke`
- 退出码：全部 0
- 结果摘要：
  - 新增 `internal/turncreds`：coturn use-auth-secret REST 凭据（username=过期Unix秒 + base64(SHA1-HMAC(secret, username))）；测试向量由独立实现（node crypto）预先计算（`owktllEOJ1LdlY0srw8HOtlgo6c=` @ secret=listogether-test-secret/username=1736000000），避免循环验证；TTL 钳制 5min..24h 有测试。SHA-1 为协议规定算法（与 coturn 互通的前提），包注释已说明风险缓解（短期 TTL + 高熵 secret）。
  - 新增 `GET /api/webrtc/ice`（会话鉴权）：配置 `LISTO_TURN_URLS`+`LISTO_TURN_SECRET` 时下发短期凭据，否则回退默认 STUN；测试覆盖 401/凭据正确性/回退/响应不含 secret。
  - web 端 `ice-config.ts` 重构为三级优先：运行时（Relay 下发）> 构建期 `VITE_ICE_SERVERS` > 默认 STUN；RoomPage 进房拉取并按 TTL/2 周期刷新（钳制 5..30 分钟），失败 60s 重试不阻塞建联；新增 6 例单测（web 122 例）。
  - providers API base 环境变量可覆盖（`LISTO_PROVIDERS_{NETEASE,QQMUSIC}_API_BASE` 等，D-019）：`NewRegistryWithBases` + config 解析，接口变更时运维切换不改代码。
- 证据位置：本记录；`apps/relay/internal/turncreds/*`、`apps/relay/internal/httpapi/iceapi*`、`apps/web/src/media/webrtc/ice-config.ts`、`apps/web/src/test/ice-config.test.ts`、`apps/relay/.env.example`
- 失败与后续：真实 TURN 中继连通性仍需部署 coturn 后验证（本机无 TURN 服务器，凭据算法与下发形状已按标准向量验收）。

## 2026-09-18 / PH4-007

- 阶段：Phase 4 后续（遗留风险处置 II：OAuth 全栈浏览器验收，D-019）
- 目标/checklist：放弃 Spotify/YouTube 外网方向后，以 provider 无关标准实现 + 本地 mock provider 完成浏览器全栈 OAuth 验收
- 环境：同 PH4-006；`scripts/mock-oauth-provider.mjs`（独立进程 mock 授权服务器：authorize(302)/token(PKCE S256 校验)/userinfo/revoke/stats，expires_in=1 驱动真实刷新路径）
- 命令/步骤：启动 mock provider(:18090) + relay（LISTO_OAUTH_SPOTIFY_* 指向 mock）+ web(:5173) → 浏览器建房 → "平台账号"卡片显示"Spotify：连接账号" → 点击连接 → window.open 弹窗走 mock /authorize → 302 回 Relay callback（Relay 用自身 code_verifier 完成 PKCE）→ 回调页"授权完成" → 面板自动刷新为"已连接 冒…"（打码标识）→ 等 expires_in=1 过期后状态查询驱动 refresh → 点断开 → 调 revoke 端点 → 面板回到"连接账号"
- 退出码：0（GUI 验证）
- 结果摘要：mock provider 生命周期计数 `{"issued":1,"refreshed":1,"revoked":1}` 与 UI 状态变化一一对应——授权签发、过期刷新、撤销三个环节全部在真实浏览器 + 真实 HTTP 下验证。除"授权服务器域名"外全部环节真实（这是放弃外网方向后可达的最强等价验收）。
- 证据位置：本记录；`scripts/tmp/mock-oauth.log`（不入库，运行时产物）；冒烟测试中的协议级等价路径（OAuth 全流程/刷新轮换/撤销三项 PASS）
- 失败与后续：开发中发现并修复一个真实 UX 缺陷——弹窗被浏览器拦截时用户无路可走，OAuthPanel 增加"点此在新标签页完成授权"回退链接（fallbackUrl 状态）；IAB 环境弹窗会实际完成授权后自关，自动化观察不到中间页（以 mock 计数为准）。

## 2026-09-18 / PH4-008

- 阶段：Phase 4 后续（无障碍基础 + 依赖升级专项）
- 目标/checklist：键盘可达性走查；跨大版本依赖升级（升级/回退决策留档）
- 命令：`npm run typecheck`、`npm test`、`npm run build`、`npm run smoke`（×2 稳定）
- 退出码：全部 0
- 结果摘要：
  - 无障碍：补全 `:focus-visible` 统一焦点样式（2px outline + offset）；键盘走查（真实 Tab 键）确认 DOM 顺序导航合理（离开房间→复制链接→锁房→关房→曲库…）；`aria-current`/`aria-label` 沿用 Phase 4 实现。注：合成按键下 `matches(":focus-visible")` 返回 false 是无头环境启发式限制，真实键盘输入必然触发（样式规则已在样式表验证）。
  - 依赖升级结果：**保留** react 19.2.8→19.3.0、jsdom 26.1.0→30.1.0、typescript 5.9.3→7.0.2（Go 原生版，typecheck 0 错误）；**回退** vite 7.3.6→8 与 @vitejs/plugin-react 5→6（vitest 3 不支持 vite 8，plugin-react 6 只接受 vite 8，与 vitest 3 死锁）、vitest 3→5（vitest 5.0.0 把 Assertion 类型改为内部 chunk 再导出，jest-dom 7 的模块增强失效 → 22 例类型错误；jest-dom 7 运行时 matchers 又按 chai 5 编译与 vitest 3 不兼容）。jest-dom 保持 6.10.0。回退用"改 package.json + 删 lockfile/node_modules 干净重装"完成（增量安装会陷入 peer 死锁）。
  - 冒烟 46 项 PASS 连续两轮（新增 OAuth 全栈 3 项 + ICE 端点 1 项）。
- 证据位置：本记录；`apps/web/package.json`、根/各 workspace package.json（typescript ^7.0.2）
- 失败与后续：vite 8 / vitest 5 / jest-dom 7 组合待生态修复（vitest 5.1+ 或 jest-dom 类型增强适配）后再评估；TS 7 为 Go 原生实现，如遇个别工具链兼容问题可回退 ^5.9.3（本次未遇到）。

## 2026-09-18 / PH4-009

- 阶段：Phase 4 后续（Docker 一键部署实测 + 用户手册）
- 目标/checklist：交付可复制的容器化部署并全链路实测；README 重写为面向用户的部署/邀请/加入手册
- 环境：Docker 29.6.1 + Compose v5.2.0（Windows）；项目新增部署文件
- 命令：`docker compose build`、`docker compose up -d --build`、`curl`（经反代）、浏览器双标签页（localhost:9000）
- 退出码：0
- 结果摘要：新增 `apps/relay/Dockerfile`（多阶段：golang:1.27-alpine 编译 → alpine 运行时，非 root + HEALTHCHECK）、`apps/web/Dockerfile`（node:22 构建 monorepo 前端 → nginx 托管 + 同源反代 /api 与 /ws）、`apps/web/nginx.conf`（SPA fallback + WS 升级头 + 长读超时）、`docker-compose.yml`、`.dockerignore`。实测：healthz/建房 REST/邀请链接生成/成员加入/双成员列表同步全部经 nginx 反代成功（WebSocket 升级正常，双端"已连接"）。开发中发现并修复两个部署缺陷——①`/healthz` 未进反代规则落到 SPA fallback（返回 HTML，首页探测失败）；②web Dockerfile 未声明 `ARG/ENV VITE_RELAY_HTTP_URL`，前端回退默认直连 relay 宿主端口（未暴露）导致"Relay 无法连接"。另记录：容器内 `go mod download` 首次瞬时失败（重跑即过，goproxy.cn 网络抖动）。README 重写为用户手册（快速开始/房主/成员/FAQ/隐私/部署进阶/配置参考/开发者指南）。
- 证据位置：`docs/evidence/phase4/docker-e2e-member-joined.png`（成员端已连接+双成员列表）；本记录
- 失败与后续：真实 TURN 中继连通性仍待 coturn 部署验证（不变）；跨主机/公网访问未实测（需外网环境，部署说明已写明 HTTPS/反代要求）。

## 2026-09-18 / PH4-010

- 阶段：Phase 4.5 收尾包（D-020：上一首/带宽提示/致命断线重试/共同 DJ 引导/flac·m4a 标签）
- 目标/checklist：补齐产品文档承诺但未实现的功能缺口（00-product-overview"上一首"、技术设计"带宽提示"）与遗留 UX 缺口
- 环境：Windows 10；TS 7.0.2 / Go 1.27.1；浏览器（ZCode IAB）双标签页 + 本地 dev 栈
- 命令：`npm run typecheck`（0 错误）、`npm test`（166 例：web 137 + protocol 18 + media 4 + shared 7）、`node scripts/go.mjs vet/test ./...`（11 包）、`npm run build`、`npm run smoke`（46 项 PASS）
- 退出码：全部 0
- 结果摘要：
  - **上一首**：零协议面——`previousTrackFromHistory` 取快照 history 最近一条 played/skipped（failed/rejected 不回放），复用 NEXT_TRACK_PREPARE 屏障。浏览器闭环验证：播放→跳过（进历史）→按钮从禁用变启用（tooltip"重新播放《e2e-test》"）→点击→新屏障→从头播放。开发中修正一处语义：初版排除了与当前曲目相同的条目，但歌曲刚结束时 currentTrack 即它自己、重播恰是预期语义，故去掉排除规则（有专门测试锁定该行为）。
  - **带宽提示**：`estimateHostUpstreamKbps`（文件大小×8÷时长×连接成员数）；浏览器实测成员建联后状态行显示"音频服务：1/1 个连接已建立 · 预计上行 ≈ 353 kbps"（与测试音实际码率一致），小码率不触发警告横幅（阈值 10 Mbps 有单测）。
  - **致命断线重试**：RoomStore 增加 fatalKind；单测覆盖 10 次重连失败→retry_exhausted→retryReconnect 重置并新建连接，以及 session_invalid 类别 no-op（不误导用户重试无意义的路径）。
  - **共同 DJ 引导**：屏障超时且 0 人就绪时显示缺文件提示（render 条件与既有 banner 同源，未单独 E2E）。
  - **flac/m4a 标签**：`readAudioTags` 按魔数分派（fLaC/ftyp/ID3）；手写 FLAC VORBIS_COMMENT+PICTURE 与 MP4 moov→udta→meta(+4)→ilst 解析器（8MB 预算，moov 不在头部回退文件名）；15 例新单测含手造二进制 fixture（开发中发现 fixture 的 © 需为原始字节 0xA9，TextEncoder 会编成 2 字节 UTF-8）。
- 证据位置：本记录；`apps/web/src/features/queue/history.ts`、`features/room/bandwidth.ts`、`transport/ws/room-store.ts`（fatalKind/retryReconnect）、`features/room/library.ts`（readAudioTags/解析器）、`test/phase45-wrapup.test.ts`（15 例）、DECISIONS.md D-020
- 失败与后续：无。遗留：收藏/PWA/压测/P95 测量仍为待办（见 HANDOFF）。

## 2026-09-19 / PH4-011

- 阶段：Phase 4 后续（压测基线：技术设计"性能和容量目标"首次验证）
- 目标/checklist：Relay 单实例 1,000 空闲连接 + 100 活跃房间；控制事件端到端 P95 < 300ms；内存随连接线性增长
- 环境：Docker Desktop（Windows）内运行 `listogether-relay:latest` 容器（LISTO_RELAY_LOG_LEVEL=warn，端口 127.0.0.1:18080 经 docker-proxy 发布）；压测客户端为同机 Node 22 脚本 `scripts/stress-relay.mjs`（内置 WebSocket，无第三方依赖）
- 命令：`node scripts/stress-relay.mjs --report scripts/tmp/stress-full.json`（默认场景 = 100 房间 × (1 房主 + 9 成员) = 1000 WS + 60s 空闲浸泡 + 300 次房主 PLAY→成员广播延迟采样）
- 退出码：0
- 结果摘要（全部达标）：
  - **连接**：1000/1000 成功、0 失败，耗时 1.0s（单连接耗时 P50=48ms / P95=62ms / P99=76ms，含会话预建后的纯 WS 握手）
  - **空闲稳定性**：60s 浸泡 0 掉线（仅服务端 20s PING / 客户端自动 PONG）
  - **控制事件延迟**（房主 PLAY 发出 → 成员收到广播，同机经 docker-proxy，300 样本）：**P50=13ms，P95=24ms，P99=26ms，max=27ms** —— 目标 300ms 的约 1/12
  - **内存**：基线 2.4MiB → 1000 连接后 44.9MiB → 浸泡后 45.4MiB → 延迟压测后 48.1MiB（≈45KB/连接，线性且无泄漏迹象）；CPU 峰值 <3%，压测后 0.05%
  - 容器日志 0 行（warn 级别）、无 error/panic
- 开发过程记录（压测脚本自身的两个 bug，已修复并留档）：
  1. `connectWs` 在 resolve 时用展开运算符拷贝状态对象，消息监听器更新的是原对象的 `maxRevision`/`closed`，调用方持有陈旧副本 → PLAY 全部被 STALE_REVISION 拒绝（0 样本）、掉线统计失真。修复：resolve 同一引用。
  2. 连接阶段 worker 池只 `launch()` 一次：前 50 房间占满并发额度后无人再启动剩余房间，完成条件永假而挂起。修复：改为标准 worker 池（每个 worker 循环取房间直到取空），并给单连接加 20s 超时兜底。另记录诊断技巧：netstat 对 docker 发布端口每个连接显示正反两行，`grep -c` 需除以 2 才是真实连接数。
- 证据位置：`scripts/stress-relay.mjs`、`scripts/tmp/stress-full.json`（运行产物，不入库）、本记录
- 边界与后续：本结果为**同机回环**基线（含 docker-proxy 一跳），未含真实网络 RTT；1000 连接已覆盖设计目标，更大规模（万级）未测。多实例/Redis 分片按设计属后续项。
