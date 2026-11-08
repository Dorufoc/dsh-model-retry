# dsh-model-retry

**为 DeepSeek Harness 提供按模型的重试策略：次数、冷却方式，以及自动审查这类「直接模型调用」的瞬时错误重试。**

[English](README.en.md) · [更新记录](CHANGELOG.md) · [报告问题](https://github.com/your-github-name/dsh-model-retry/issues) · [安全策略](SECURITY.md)

[![Plugin](https://img.shields.io/badge/plugin-0.2.0-6f83ff?style=flat-square)](CHANGELOG.md)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-8b5cf6?style=flat-square)](#版本支持政策)
[![License](https://img.shields.io/badge/license-MIT-536990?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square)](#开发与测试)

DSH 自带的重试能力只到 provider 粒度，且退避算法固定为「指数 + 抖动」。这个插件补上 DSH 目前做不到的几件事，并顺带修掉一个会卡住工具链的问题：

- **按模型**设置重试次数，`0` 表示**无限重试**；
- 冷却时间可选**固定间隔**或**递增间隔**（每次在上次基础上再加 N 秒）；
- 计数**按步**独立，每一步模型调用重新从 1 开始；
- 顺带修掉一个会卡死工具链的问题：自动审查的审查模型返回 429/5xx 时，整次审查失败会被当成「拒绝执行工具」，插件对这类**瞬时错误**重试，而**真实的审查拒绝永不重试**。

## 为什么需要它

DSH 的重试策略由 `@deepseek-ai/dsh-llm-retry` 执行，它有三个能力边界：

| 边界 | 具体表现 | 本插件的做法 |
| --- | --- | --- |
| 粒度是 provider | 同一 provider 下所有模型共享一份策略 | 按 `provider/model` 单独配置 |
| 退避只能指数 | `initialDelayMs × 2^(n-1)` 加抖动，无固定/线性 | `fixed` 与 `increment` 两种冷却 |
| `maxRetries: 0` 是「不重试」 | 与「无限重试」语义相反 | `retries: 0` 明确表示无限 |

因此插件**接管**了这条链路：停用内置 `llm-retry`，由本插件实现同形状的执行器，并发出与原生一致的 `llm/retry` / `llm/retry-started` 会话事件——聊天里的重试卡片、会话日志格式都不变。

> ⚠️ **安装后 `llm-retry` 行会被停用**，重试由本插件统一负责。未配置任何模型时行为与原生完全一致（沿用 provider 的 `retryPolicy`）。

## 功能

- **按模型的次数与冷却**：`retries`、`delayMode`、`delaySeconds`、`incrementSeconds`、`maxDelaySeconds`，以及可重试错误码白名单。
- **按步计数**：同一步内多次失败共享计数，进入下一步归零。
- **自动审查不再因限流被拒**：429、5xx、超时、传输中断、空响应会重试；认证/参数错误仍立即失败。
- **两种可编辑入口**：设置 → 模型 → provider 卡片里的「失败重试」；以及独立的「模型重试」设置页。
- **安全默认值**：`unconfigured: inherit`，没配置就不改变任何行为。
- **无构建步骤**：纯 JavaScript，仓库即是可安装的 bundle。

## 版本支持政策

| 项目 | 当前说明 |
| --- | --- |
| 插件版本 | `0.2.0` |
| 验证环境 | DSH Desktop `0.2.1-rc.2`，`desktop` profile |
| 预期兼容 | 同一 RC 系列；DSH 仍处于候选发布阶段，跨 RC 可能发生破坏性变更 |
| Node | `>=20`（用到 `AbortSignal.any`） |

DSH 处于开发者预览期，插件依赖的上游扩展点（`agent/request-error`、`llm/stream`、会话事件格式）可能变化。遇到不兼容请开 issue 并附上 DSH 版本。

## 安装

### 从 GitHub 安装（推荐）

```powershell
dsh plugin --profile web add github:your-github-name/dsh-model-retry
dsh --profile web --dump-config
```

确认输出中出现 `name: dsh-model-retry` 后，**重启 Web Host 并刷新页面**。

桌面版使用独立的 `desktop` profile，需要单独安装（先完全退出应用，再用桌面版内置命令）：

```powershell
dsh plugin --profile desktop add github:your-github-name/dsh-model-retry
dsh plugin --profile desktop list
```

### 从本地目录安装

```powershell
dsh plugin --profile desktop add D:\path\to\dsh-model-retry
```

或在应用内的插件管理器里安装本地目录。

### 生效方式

插件模块在 Host 启动时载入。DSH 的模块热重载是 opt-in 且默认关闭（`dsh-base` 里 hmr 行的 `root: []`），因此**修改或首次安装后都需要重启对应的 Host 或桌面应用**，刷新页面不会重新加载 Host 模块。

### 卸载

```powershell
dsh plugin --profile web remove dsh-model-retry
```

卸载后内置 `llm-retry` 会重新启用，重试行为恢复原生。重启后生效。

## 使用

### 在设置界面里配置

- **设置 → 模型 → 任一 provider 卡片**：展开「失败重试」，逐个模型设置次数与冷却。因为「添加模型」就是在同一张卡片的模型表里加行，这里同时覆盖「添加时配置」和「事后修改」。
- **设置 → 模型重试**：全量视图，按 provider 分组，另含全局默认模板与未配置模型的处理策略。

### 用配置文件配置

写入目标 profile 的 `cordis.patch.yml`：

```yaml
- id: model-retry
  name: dsh-model-retry
  config:
    # inherit = 沿用该 provider 的 retryPolicy（DSH 原生行为，默认）
    # off     = 未单独配置的模型不重试
    unconfigured: inherit

    # 新增模型时预填的模板；已配置的模型以自身条目为准
    defaults:
      retries: 5
      delayMode: fixed
      delaySeconds: 2
      incrementSeconds: 2
      maxDelaySeconds: 120

    models:
      yundu/gpt-6-astra:          # 键是 `<provider>/<model>`
        retries: 0                # 0 = 无限重试
        delayMode: increment
        delaySeconds: 1
        incrementSeconds: 2
        maxDelaySeconds: 60
      sensenova/kimi-k3:
        retries: 5
        delayMode: fixed
        delaySeconds: 3
        maxDelaySeconds: 30
```

### 字段

| 字段 | 作用 |
| --- | --- |
| `unconfigured` | `inherit`（默认）未配置的模型沿用 provider 策略；`off` 表示不重试。 |
| `defaults` | 新增模型时预填的**模板**；运行时不会覆盖已配置模型的条目。 |
| `models.<provider>/<model>` | 该模型自己的策略；未写的字段取策略默认值。 |
| `retries` | 重试次数上限。**`0` 表示无限重试**；按步计数，新的一步从 1 重新开始。默认 `5`。 |
| `delayMode` | `fixed`：每次间隔相同；`increment`：每次在上次间隔上再加 `incrementSeconds`。 |
| `delaySeconds` | 固定间隔秒数，或递增模式的首次间隔。 |
| `incrementSeconds` | 递增模式下每次额外增加的秒数。 |
| `maxDelaySeconds` | 单次冷却上限；`0` 表示不封顶。默认 `120`。 |
| `retryableCodes` | 允许重试的错误码，默认 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`。 |

冷却时间序列：

| 配置 | 第 1 / 2 / 3 次重试前等待 |
| --- | --- |
| `delayMode: fixed, delaySeconds: 2` | 2s / 2s / 2s |
| `delayMode: increment, delaySeconds: 1, incrementSeconds: 2` | 1s / 3s / 5s |

服务端返回的 `Retry-After`（`providerRetryAfterMs`）在不超过 `maxDelaySeconds` 时优先。注意该字段目前只有官方 DeepSeek 适配器会透出，`openai-completions` 等路由不会。

## 自动审查为什么会被「误杀」

工具自动审查会用当前模型做一次**单次**直接调用（`ctx.llm.stream()`）来判断风险。一旦这次调用因限流或服务端异常结束，审查链路把它当成「审查失败」，进而**拒绝执行被审查的工具**：

```
Auto review of tool "read" failed; its body was not executed:
auto-review: reviewer ended with error RATE_LIMIT: 429 ... TPM exhausted
```

插件在同一条 `llm/stream` 瀑布上补了一层重试：

- 只重试可重试错误码（429 / 5xx / 超时 / 传输中断 / 空响应），认证与参数错误仍然 fail-fast；
- 只重试**尚未产出任何内容**的失败；已经吐出过内容不重开，避免重复输出；
- **真实的审查决策（正常 `stop` + JSON）永不重试**；
- agent loop 的请求由按步重试负责，这里通过 `isAgentLoopRequest` 明确跳过，不会重复重试；
- 预算沿用同一套按模型策略；未配置时沿用 provider 的 `retryPolicy`。

如果配额窗口比默认退避更长（默认约 15 秒），给审查所用模型配置更长的冷却，例如：

```yaml
models:
  deepseek-account/deepseek-flash:
    retries: 5
    delayMode: increment
    delaySeconds: 30
    incrementSeconds: 30     # 30/60/90/120/150 秒
    maxDelaySeconds: 300
```

## 工作原理（简版）

```
每次模型调用失败
  └─ agent/request-error
       ├─ 该模型未配置 ──▶ 复刻内置算法（指数 + 抖动 + Retry-After）
       ├─ unconfigured: off ──▶ 不重试
       └─ 已配置 ──▶ 固定 / 递增冷却，按步计数
            ├─ 冷却可被「停止」立即打断
            ├─ append llm/retry → 等待 → append llm/retry-started
            └─ 返回 retry，让 agent loop 重发这次尝试

直接模型调用（自动审查 / 会话标题 / 压缩）
  └─ llm/stream 瀑布
       └─ 瞬时错误且尚未产出内容 ──▶ 按同一策略等待后重试
```

完整设计、上游证据链与验收记录见 [docs/design.md](docs/design.md)；可复现的验证方法见 [docs/verification.md](docs/verification.md)。

## 仓库结构

```
.
├── index.js                  # Host 半：重试执行器与配置契约
├── client.js                 # 浏览器半：设置界面控件（预构建 classic-script bundle）
├── cordis.patch.yml          # bundle 补丁：停用 llm-retry、插入 model-retry
├── icon.svg                  # 插件图标
├── locale/{en,zh}.json       # 插件管理器展示用的标题/描述
├── docs/
│   ├── design.md             # 设计稿与实现说明
│   ├── verification.md       # 验证方法、场景与期望数字
│   └── research/             # 上游机制调研记录（含文件行号证据）
├── scripts/
│   ├── mock-provider.mjs     # 可编排的 OpenAI 兼容 mock 服务
│   ├── session-log.mjs       # 会话日志解析与不变量校验
│   ├── run.mjs               # 验证 CLI（selftest / mock / control / assert）
│   └── asar.mjs              # 维护者工具：读取 DSH 的 app.asar
└── test/
    ├── engine.test.mjs       # 按步重试执行器的离线断言
    └── stream-retry.test.mjs # 直接调用重试的离线断言
```

## 开发与测试

需要 Node `>=20`。验证分为两层：

```powershell
# 1) mock 服务的自检（不依赖 DSH 运行时）
node scripts/run.mjs selftest

# 2) 离线单元断言（需要能解析 DSH 的 peer 包）
npm test
```

`npm test` 里的两个文件会 `import` 本插件，因此需要 `@deepseek-ai/schemastery`、`@deepseek-ai/cosmokit`、`@deepseek-ai/dsh-llm` 可解析——最简单的方式是在 DSH 源码检出或已安装运行的 Harness 环境里跑；解析不到时测试会打印 `SKIP` 并以 0 退出，而不是伪装通过。

端到端的真实重试验证（mock provider + 真实 agent loop + 会话日志断言）见 [docs/verification.md](docs/verification.md)。

## 常见问题

**安装后没有任何变化？**
插件默认 `unconfigured: inherit`，不配置模型时行为与原生一致。去「设置 → 模型」里配置，或按上面的 YAML 写 `models`。

**配置了但似乎没生效？**
Host 模块只在启动时载入，改完配置**重启**对应的 Host 或桌面应用。用 `dsh --profile <name> --dump-config` 可以确认 `model-retry` 行和你的配置层都在。

**会和内置重试冲突吗？**
不会。插件通过补丁停用 `llm-retry`，由自己接管同一条扩展点；两者不会同时生效。

**无限重试会不会卡死？**
不会。点「停止」、轮次取消、agent 销毁都会立即中断正在等待的重试。

**插件会联网吗？**
不会。它不发起网络请求，也不收集遥测，只读取自身的配置和 DSH 的公开扩展点。

**能和别的重试类插件共存吗？**
如果另一个插件也接管了 `agent/request-error` 或 `llm/stream`，两者会按注册顺序竞争。请只保留一个重试执行器。

## 许可证

[MIT](LICENSE) © 2026 dsh-model-retry contributors

DSH、DeepSeek Harness 及相关名称归其各自所有者所有；本插件为独立的社区项目，与 DeepSeek 官方无隶属关系。
