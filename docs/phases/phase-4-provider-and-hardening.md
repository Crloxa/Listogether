# Phase 4：平台识别、官方 OAuth 与安全加固

## 目标

以可插拔方式识别音乐平台链接，使用官方 OAuth 表达用户授权，并让所有不可播放情况可解释、可恢复。

## 功能 checklist

- [x] Provider adapter 接口和平台 URL 规范化。（`apps/relay/internal/providers`：`Provider` 接口 + netease/qqmusic/spotify/ytmusic 适配器，`Registry.Add` 支持扩展；web 端 `features/providers/normalize.ts` 同规则双实现，两端同矩阵测试）
- [x] 识别歌曲标题、艺人、版本、时长、封面和来源平台。（netease/QQ 实测返回全字段（PROVIDERS.md P-003/P-008）；Spotify/YouTube 本机网络不可达，识别/规范化可用、解析失败可解释；album 归入 message/source 元数据）
- [x] 播放能力状态：可播放、需登录、仅预览、地区限制、失效或不支持。（`trackSource.playability` 六态枚举；netease fee / QQ pay_play 保守映射；平台不可达 ≠ 链接无效）
- [x] Authorization Code + PKCE、最小 scope、token 轮换和撤销。（`internal/oauth`：S256 PKCE、state 一次性绑定会话、refresh 轮换、撤销端点尽力调用；mock provider 全流程测试）
- [x] token 不进入房间状态、邀请链接、客户端日志或测试证据。（token 只在 Relay 内存绑定会话哈希；`/status` 只出打码标识；日志测试断言无 token；smoke 断言 providers 响应无 token 字段）
- [x] 官方播放器/嵌入能力受限时明确降级到本地文件、预览或跳过。（平台条目显示"需绑定本机文件"；屏障缺文件横幅区分平台曲目并说明合规边界；队列播放失败自动跳过并记历史——E2E 验证《海阔天空》播放失败入历史）
- [x] 链接输入校验、SSRF 防护、XSS 转义、限流和消息大小限制。（https+白名单+私网 IP 拒绝+重定向白名单+1MB 响应上限；解析 10 次/分/成员；外部元数据纯文本渲染；歌词 48KB/500 行 + WS 64KB 帧 + 请求体 8KB）
- [x] 依赖更新、错误监控、备份/导出和隐私说明。（react 19.3.0 semver 兼容更新并回归，跨大版本更新记录不升级理由；HTTP/房间 actor/写泵 panic recovery；曲库导出已有 + 隐私与数据边界进 README）
- [x] 浏览器权限、媒体键、移动端后台播放和无障碍基础检查。（Media Session 播放/暂停/跳过/seekto + positionState；wake lock 房主播放时常亮（不支持则静默）；歌词高亮 aria-current、图标按钮 aria-label、应用不请求任何敏感权限—— autoplay 门控沿用"启用声音"）

## 体验增强（Phase 3 延伸，用户需求）

- [x] 封面全员显示：房主经既有 WebRTC PeerConnection 的 DataChannel 把封面二进制（trackId + mime + bytes）推送给成员，成员按 trackId 缓存；Relay 不参与媒体数据（D-001/架构边界不变）。约束：单张封面设上限（建议 512KB，超限时房主端用 canvas 缩放压缩后再发）；仅在曲目切换与新成员建联时发送一次；成员端收到前显示占位。（实现 `media/cover-channel.ts` 分块 JSON 帧 + LRU 缓存 + canvas 压缩；E2E 验证成员端解码显示、重连补发；平台封面 URL 由各端直连加载不经转发（P-005））
- [x] 歌词加载与同步显示：房主导入曲库时支持同名 `.lrc`（逐行时间戳同步歌词）与 `.txt`（纯文本歌词），也可在曲库条目上手动指定；LRC 解析为 {时间戳, 文本} 数组，三端按 `livePositionMs` 高亮当前行（行级高亮对 100ms 内偏差不敏感）。歌词为文本（通常几 KB）经控制面新事件（如 `TRACK_LYRICS`）下发，Relay 按 trackId 内存缓存、成员加入/切歌时补发；不进快照避免膨胀；设大小上限（建议 64KB）与行数上限，超限提示不加载。无歌词曲目显示占位。（上限 48KB/500 行（帧内安全，P-007）；E2E 验证逐行高亮、纯文本、占位、超限拒绝、重连补发）

## 验收证据

- 每个 provider 的正例、未知链接、失效链接和需要登录状态。（Go 单测 httptest mock 全分支 + smoke 离线可判定路径 + 真机联调记录（PROVIDERS.md P-008）+ 浏览器 E2E 网易真实解析/Spotify 不可达报错）
- OAuth 登录、取消、过期、撤销和最小 scope 的测试结果（不记录 token）。（`internal/oauth` mock provider 覆盖正常/取消(access_denied)/state 不匹配/过期刷新轮换/撤销/会话失效释放；真实 provider 因网络封锁+无开发者凭证不可联调（P-006），mock 为等价验收）
- 安全测试结果：越权、XSS、SSRF、过期邀请和限流。（smoke：非房主解析 403、私网 400、伪造 state 400、解析限流 429、歌词越权/超限；XSS 由 React 文本渲染 + 测试断言；过期邀请/会话 401 沿用 Phase 1 路径）
- 封面：成员端在曲目切换后收到并显示封面、断线重连后能重新获取、超大封面被压缩。（E2E：成员端 naturalWidth=32 解码显示；重连后新通道补发；>512KB canvas 压缩路径单测 pickJpegQuality + compressCoverBlob 降级）
- 歌词：LRC 同步高亮随进度推进、纯文本正常显示、无歌词占位、超限文件被拒绝并提示。（E2E 起播后第一句高亮、曲末第三句高亮；纯文本/占位/48KB 超限 LYRICS_TOO_LARGE 均有自动化）

## 出口条件

平台接入失败不会影响本地文件房间；用户能理解失败原因，且鉴权和房间邀请的敏感数据边界可审计。（✅ Spotify/YouTube 解析失败仅影响该链接本身，本地文件房间全流程正常；所有失败带可操作文案；D-014/D-015 边界有自动化断言）
