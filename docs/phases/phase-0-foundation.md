# Phase 0：项目基础与协议基线

## 目标

建立可启动的工程骨架、统一类型/协议、环境配置和测试证据流程，为后续房间与媒体实现提供稳定边界。

## 功能 checklist

- [x] 创建 `apps/web`、`apps/relay`、`packages/protocol`、`packages/shared`、`packages/media` 的最小工程结构。
- [x] 提供开发环境安装、启动、构建、类型检查和测试命令。
- [x] 定义房间状态、成员角色、事件版本和错误码。
- [x] 实现协议 schema 校验及未知/过期消息拒绝测试。
- [x] 定义配置项来源和敏感配置规则，提供不含真实密钥的示例配置。
- [x] 建立统一日志格式和敏感字段脱敏测试。
- [x] 用最小健康检查确认 web 和 relay 均能启动。

实现说明：

- 协议单一来源是 `packages/protocol/schema/envelope.schema.json`；TS 类型与校验器在 `packages/protocol/src`，Go 信封校验在 `apps/relay/internal/protocol`，两侧用 parity 测试对齐事件枚举（`TestKnownTypesParityWithSchema`）。
- 包为 source-only 内部包（`exports` 直接指向 `src/index.ts`），由 Vite/Vitest 直接消费，无构建顺序问题。
- Relay 的 `/ws` 在 Phase 0 只做信封校验并回 `ERROR`；房间逻辑在 Phase 1 接入。
- 环境变量清单见 `apps/relay/.env.example` 与 `apps/web/.env.example`；`scripts/go.mjs` 支持 `LISTO_GO_BIN` 覆盖 go 路径。

## 验收证据

- 依赖安装、类型检查、测试、构建命令的完整输出摘要 → `docs/TEST_EVIDENCE.md` PH0-001 ~ PH0-005。
- web/relay 启动后的健康检查响应 → `npm run smoke` 输出（PH0-005）。
- 协议正例、错误版本、越权事件的测试结果 → PH0-002（TS 16 例）、PH0-003（Go 单测 + ws 拒绝路径）。

## 出口条件

另一位 agent 能根据 `README.md` 在干净环境启动两个服务，并理解所有房间事件的字段和版本规则。
