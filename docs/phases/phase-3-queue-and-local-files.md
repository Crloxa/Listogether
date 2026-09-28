# Phase 3：队列、点歌与本地文件体验

## 目标

完成多人点歌和房主播放管理，并让本地文件可以安全、可解释地进入房间播放。

## 功能 checklist

- [x] 拖放文件/文件夹、读取音频标签和封面、格式不支持提示。（房主曲库面板：拖放区（`webkitGetAsEntry` 递归目录）+ 多选/文件夹选择器；mp3 解析 ID3v2 标题/艺人/APIC 封面（本机显示，不进协议），其余格式回退文件名；解码失败逐文件提示且不影响其他文件）
- [x] 本地文件只由房主读取；成员只获得 WebRTC 音频流和必要元数据。（曲库只有元数据进协议；音频文件留在房主本机，屏障按 trackId 在房主注册表解析文件，成员端仅有音频流与 title/artist/duration）
- [x] 共享播放列表、添加/删除/排序、当前/接下来分组。（快照 `queue`（queueEntry：entryId/track/requestedBy/addedAtMs）；房主/DJ 上移/下移（QUEUE_REORDER 全量顺序）、移除、清空；正在播放与"接下来"分区展示，条目带点歌人标记）
- [x] 点歌审批、点歌人标记、插队规则和每人冷却/配额。（listener 点歌进 `pendingRequests` 待 host/co_dj 批准；host/co_dj 免审批直接入队尾；listener 30s 冷却 + 未播放条目 2 首配额（RATE_LIMITED）；房主可对任意曲库/队列条目"下一首播放"插队）
- [x] 重复检测、投票跳过、请求历史、撤销和失败自动跳过。（trackId 重复点歌回 DUPLICATE_TRACK；SKIP_VOTE 一人一票、票数过半且 ≥2 通过，房主端自动跳过衔接；快照携带最近 20 条 history（played/skipped/failed/rejected + 点歌人）；QUEUE_REMOVE 撤销（listener 仅限自己的条目）；TRACK_FINISHED{failed,trackId} 移除失败条目，房主端自动取下一首）
- [x] 顺序/单曲/随机播放和空队列行为。（PLAY_MODE：order 取队首 / repeat_one 重播当前 / shuffle 随机；曲目自然结束（onended）→ TRACK_FINISHED(played) → 按模式衔接；队列空 → 自动暂停并提示"队列已播完"）
- [x] 房主/DJ/听众对队列操作的权限测试。（Go `internal/room/queue_test.go` 16 例：曲库/审批/排序/清空/播放模式 host+DJ 专属、QUEUE_REMOVE 点歌人限制、冷却/配额/重复检测、投票通过阈值与清零、TRACK_FINISHED 越权拒绝；前端 `queue-panel.test.tsx` 验证入口显隐与服务端仍做最终判定）
- [x] 房间聊天、在线成员和基础反应（若不影响核心同步）。（CHAT_MESSAGE 即时转发、不占 revision、不进快照，10 条/10s 限流；连接时单发 CHAT_HISTORY 恢复最近 50 条；反应 = kind=reaction 消息；在线成员列表 Phase 1 已有）
- [x] 本地队列持久化与导入导出最小格式。（房主曲库元数据持久化 localStorage（不含文件字节），刷新后条目"未加载"、重新选择同名同大小文件按名称+大小绑定回原 trackId，队列请求不失效；导出/导入 `{version:1,tracks:[…]}` JSON）

## 验收证据

- 三个浏览器同时点歌、审批、排序、投票跳过的操作记录：`npm run smoke`（29 项 PASS，含 Phase 3 曲库/点歌/审批/排序/投票/历史/聊天/失败跳过流程）+ 浏览器三标签页 E2E（`docs/evidence/phase3/`）。
- 重复歌曲、刷屏冷却、越权操作和断线恢复测试：Go 单测（DUPLICATE_TRACK / RATE_LIMITED / UNAUTHORIZED / 撤销权限）+ smoke（DUPLICATE_TRACK、RATE_LIMITED 限流、CHAT_HISTORY 恢复）+ E2E（断线恢复沿用 D-009 宽限重连，E2E 期间标签页被环境回收后重新加入验证）。
- 多种音频格式/损坏文件/缺少标签的导入结果：`library.test.ts`（ID3 解析/损坏数据/非 ID3 回退）；导入失败文件逐个提示且不影响其他文件（E2E 中合成 WAV 全部成功，损坏文件路径由单测覆盖）。

## 出口条件

房主可以在不打断同步协议的情况下管理完整队列；单个成员无法通过点歌或控制操作破坏其他人的播放。（成员全部操作限于点歌/投票/撤销自己的条目/聊天；审批、排序、跳过、播放衔接均在房主/DJ 权限与服务端判定之下；投票跳过需过半共识）
