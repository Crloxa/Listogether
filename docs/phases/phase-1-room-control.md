# Phase 1：房间与控制面

## 目标

让房主通过本地应用创建互联网房间，好友通过邀请链接加入，并在两个浏览器间可靠同步成员、权限和房间状态。

## 功能 checklist

- [x] 创建/关闭房间、随机邀请 token、复制链接和可选密码。
- [x] 加入、离开、锁房、人数上限、踢人和成员在线状态。
- [x] 房主、共同 DJ、听众权限检查；房主离开时转移或结束。
- [x] Relay WebSocket 连接、TLS 配置说明、心跳和超时处理。
- [x] 版本化房间快照、事件广播、旧事件拒绝和重连恢复。
- [x] 基础播放器状态模型：当前歌曲、播放/暂停、进度、队列占位。
- [x] 浏览器自动播放限制和连接失败提示。
- [x] 互联网双浏览器端到端加入测试。

实现说明：

- 凭证与握手形态见 `docs/DECISIONS.md` D-007/D-008/D-009（邀请 token 可复用且只存哈希；HTTP 换会话 + `GET /ws?roomId=&sessionToken=` 握手；断线默认 offline 宽限，显式离开用关闭码 3001 标记）。
- Go 侧新增 `internal/auth`（token/PBKDF2）、`internal/room`（串行 actor：成员/revision/播放/屏障/presence）、`internal/hub`（房间与会话、join 校验、清理）、`internal/httpapi` 房间 REST、`internal/ws` 会话接入与单写者写泵。
- 屏障运行时校验补齐了 Phase 0 遗留的跨字段约束（`startAtMs > prepareDeadlineMs` 且二者必须晚于服务器时间）；Phase 1 客户端收到 PREPARE 即自动上报 READY（无真实媒体可准备），Phase 2 替换为真实缓冲就绪。
- Web 侧新增 `transport/ws/room-store.ts`（重连/心跳/协议应用）、`features/room/{HomePage,JoinPage,RoomPage}` 与会话/邀请工具；页面角色以服务端快照为准（房主转移后 UI 即时跟随）。
- 已知限制：重连后的成员从快照看不到进行中屏障的曲目元数据（快照 schema 无“下一首”字段），仅显示就绪计数；Phase 2 扩展快照时补齐。

## 验收证据

- 双标签页（独立 sessionStorage 会话）建房/邀请链接加入、播放/暂停/切歌同步、刷新恢复、房主离开转移截图 → `docs/evidence/phase1/*.png`，记录见 `docs/TEST_EVIDENCE.md` PH1-004/PH1-005。
- 越权控制、过期 token、锁房与关房广播 → `npm run smoke`（双 WS 连接流程，13 项 PASS）与 Go/TS 单测（PH1-001 ~ PH1-003）。
- 断网/重连/房主离开场景：WS 层测试 `TestExplicitLeaveVsGracefulOffline`、`TestReconnectRestoresMemberIdentity`、`TestHostLeaveTransfersToEarliestMember` + 浏览器实测（PH1-005）。

## 出口条件

房间控制面在没有音频流的情况下仍能完成建房、入房、权限操作和状态恢复，且没有把 token 或本地路径发送到成员端。✅ 已达成：会话/邀请 token 只保存在持有者自己的 sessionStorage 与响应原文中，房间事件不携带任何 token；成员端收到的快照与广播不含本地路径或凭证。
