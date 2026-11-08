# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0] - 2026-11-08

### Added

- **直接模型调用的瞬时错误重试**：在 `llm/stream` 瀑布上新增一层重试，覆盖自动审查、会话标题、上下文压缩这类单次 `ctx.llm.stream()` 调用。
  - 重试 `RATE_LIMIT`（429）、`SERVER`（5xx）、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`。
  - 只在尚未产出任何内容时重试；已输出的流不会重开。
  - 认证与参数类错误不重试，保持 fail-fast。
  - 通过 `isAgentLoopRequest` 跳过 agent loop 请求，避免与按步重试叠加；该 import 不可用时降级为启发式判断，不影响按步重试。
- 重试预算与按模型策略统一：配置过的模型用自己的策略，未配置的沿用 provider 的 `retryPolicy`。

### Fixed

- 自动审查的审查模型返回 429/5xx 时，整次审查失败会被当成「拒绝执行工具」，导致工具调用被误杀。现在这类**过程性失败**会被重试，而**真实的审查决策永不重试**。

## [0.1.0] - 2026-11-08

### Added

- 按 `provider/model` 配置失败重试：`retries`（`0` = 无限）、`delayMode`（`fixed` / `increment`）、`delaySeconds`、`incrementSeconds`、`maxDelaySeconds`、`retryableCodes`。
- 按步计数：同一步内的多次失败共享计数，进入下一步从 1 重新开始。
- 接管内置重试：通过 bundle 补丁停用 `llm-retry`，发出同形状的 `llm/retry` / `llm/retry-started` 会话事件，聊天重试卡片与会话日志格式保持不变。
- 未配置模型沿用 provider 的 `retryPolicy`（复刻原生指数退避），保证安装后行为不变。
- 设置界面：provider 卡片内的「失败重试」扩展区，以及独立的「模型重试」设置页。
- 可取消的冷却等待：停止、轮次取消、agent 销毁都会立即中断。
