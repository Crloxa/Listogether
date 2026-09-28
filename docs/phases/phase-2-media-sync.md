# Phase 2：WebRTC 音频与同步屏障

## 目标

房主本地音频可以被互联网成员听到；只有播放下一首使用准备屏障，在统一时间点播放，暂停/拖动/重连不强制全房间等待。

## 功能 checklist

- [x] 房主本地音频解码并连接到 WebRTC 音频轨道。
- [x] 每个成员独立 PeerConnection、连接状态和资源释放。
- [x] STUN 配置；TURN 作为无法直连时的可配置路径。
- [x] `PREPARE`、`READY`、`START`、`SNAPSHOT` 和 `RESYNC_REQUEST` 流程。
- [x] 未来 `startAt`、目标时间戳和媒体缓冲状态处理。
- [x] 房主播放下一首时暂停全房间并走准备屏障；当前歌曲拖动不强制全员等待。
- [x] 成员手动重新同步只影响自己。
- [x] 迟到成员只收到“当前歌曲已开始”的提示和重新同步按钮，不自动追赶。
- [x] 播放下一首时，所有在线成员通过准备屏障对齐并同时开始。
- [x] 缓冲超时、音频中断、自动播放失败和重连提示。
- [x] 双浏览器真实音频播放和同步偏差验证。

实现说明：

- 决策依据：`docs/DECISIONS.md` D-010（ICE 配置经 `VITE_ICE_SERVERS` 构建期注入，默认公共 STUN；TURN 为可配置兜底，长期凭据风险与生产替代方案已记录）、D-011（房主以 AudioContext 时钟调度统一开始；成员实时收流；READY = 媒体管道就绪；重新同步 = 房主为该成员从当前位置重建音频段；屏障超时由房主强制开始收口）。
- 前端媒体层：`apps/web/src/media/`（`local-source/buffer-source` 文件解码与可定位源、`audio-clock` 调度换算纯函数、`webrtc/{ice-config,peer-targets,member-peer}` 信令与连接、`host-audio` 房主音频段调度/重建/释放、`member-audio` 解锁/播放/音量/健康检查、`wiring` 把 RoomStore 事件接到控制器）。
- 协议扩展：快照新增可选 `pendingPrepare`（屏障元数据随快照下发，重连成员据此恢复屏障并上报 READY，补齐 Phase 1 遗留项）；`NEXT_TRACK_START` 允许房主/共同 DJ 在屏障超时后强制开始（复用既有事件类型，transitionId 必须匹配当前屏障）。
- READY 语义变化：Phase 1“收到 PREPARE 即 READY”移除；成员在 PeerConnection connected 且远端轨道接入后才上报（AudioContext 未解锁不阻塞 READY，界面持续提示“启用声音”）。
- 已知限制（均记录于技术设计“实现要点与已知限制”）：曲目播到结尾不自动切歌（Phase 3 队列）；房主转移后新房主需重新加载同一文件；TURN 未在真实服务器上验证（本机无 TURN 服务，配置解析有单测）；E2E 双浏览器为同一浏览器实例的三个独立标签页（独立 sessionStorage 会话），未做跨公网验证。

## 验收证据

- 双标签页真实音频（同一房主本地测试音、统一开始、电平 0.278~0.290、首音滞后 112/198ms、显示偏差 -22ms）→ `docs/evidence/phase2/{sync-playing.json,host-playing.png,member-hearing.png}`，记录 PH2-003。
- 暂停/恢复/拖动同步（暂停位置两端完全一致、恢复 4ms、拖动不触发屏障）→ 记录 PH2-004；成员重新同步只影响自己 → PH2-004/PH2-005。
- 迟到成员（横幅提示 + 不自动出声 + 重新同步接入）→ `docs/evidence/phase2/{late-join-resync.json,late-join-connected.png}`，记录 PH2-005。
- 屏障超时强制开始（未就绪成员不阻塞房间、权限与 transitionId 校验）→ `npm run smoke` 18 项 PASS + Go 单测，记录 PH2-006。
- Relay 未保存音频：信令转发为内存短路径（`playback.go` forwardTo），无落盘代码路径；冒烟断言转发行为，记录 PH2-002。
- 自动化基线：TS 69 例 + Go 8 包全部通过，记录 PH2-001。

## 出口条件

一个成员缓冲慢或离线时，其他已准备成员可以在超时策略下继续；房间不会因为单个成员无限暂停。✅ 已达成：offline 成员不参与就绪计算（Phase 1 语义保持）；deadline 过后房主可强制开始（NEXT_TRACK_START，PH2-006）；未就绪成员随后经重新同步从直播位置接入（PH2-005）。✅
