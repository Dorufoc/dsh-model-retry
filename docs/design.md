# DSH「按模型失败重试」插件设计

> 状态：设计稿（未实现、未安装）
> 目标仓库：DeepSeek Harness Desktop `0.2.1-rc.2`，profile `desktop`
> 调研证据：`docs/research/host-retry.md`、`docs/research/client-model-ui.md`
> 命名：插件包 `dsh-model-retry`，Loader 行 id 与设置命名空间均为 `model-retry`

---

## 1. 需求

| 编号 | 需求 | 说明 |
| --- | --- | --- |
| R1 | 每个模型可配置**失败重试次数** | `0` = 无限重试；`N` = 最多重试 N 次 |
| R2 | 每个模型可配置**重试冷却时间策略** | `fixed`：每次间隔固定 N 秒；`increment`：每次在上次间隔基础上再加 M 秒 |
| R3 | 计数**按步（step）独立** | 每次模型调用单独计数，不按轮次（turn）累计；步结束即归零 |
| R4 | **添加模型时**可配置 | 在「设置 → 模型」新增模型的行内流程中可设置 |
| R5 | **设置窗口的模型编辑页**可随时再编辑 | 不只在添加时，已存在的模型也能改 |

补充语义（由 R1/R2 推导，需要在 UI 上明示）：

- `retries = 0` 不是「不重试」，而是「无限重试」。DSH 原生 `maxRetries: 0` 是「不重试」，语义相反，**不可直接复用**（见 §3.3）。
- 递增模式的数列是 `delay₁ = base`，`delayₙ = base + (n-1) × increment`，并有 `maxDelaySeconds` 封顶。
- 服务器给出的 `Retry-After`（`failure.providerRetryAfterMs`）优先于本地计算的间隔。

---

## 2. 结论先行

1. **DSH 已经有一套完整的重试设施，但它是「按 provider」且「指数退避」的**，无法表达 R1 的 `0=无限` 语义，也无法表达 R2 的固定/线性冷却。因此**必须由插件自己执行重试**，即关闭内置 `llm-retry` 行，由本插件接管同一条扩展点。
2. 接管是**低风险**的：重试 UI 是**事件驱动**的（读 `llm/retry` / `llm/retry-started` 会话事件），只要发出同名同形状事件，聊天气泡里的重试卡片照常工作；`llmRetry` 会话投影是 host-only 且只被 `llm-retry` 自己读取。
3. **「失败的是哪个模型」在官方事件里没有**：`agent/request-error` 只带 `provider`。但 `agent/request` 瀑布每次尝试都会触发并返回完整 `LlmCallConfig { provider, model }`，插件可据此缓存 `(agent.id, turn, step) → model`，再用 `Session.requestContext()` 兜底。**无需改核心代码。**
4. **每步计数是天然免费的**：`agent/request-error` 发生在 `step()` 的 `while(true)` 重试循环内，而 `step/start` / `turn/end` 会清空计数投影。沿用该语义即可满足 R3。
5. 配置必须放在**插件自己的设置命名空间**，不能塞进 `llm-pi-ai` 的模型条目——模型页保存时会用 schema 投影整体重写 `models[]`，额外键会被丢弃。
6. UI 有两个可用的官方插槽：`settings.models.provider-card`（按 `settingsNs` 派发，**在「设置 → 模型」的 provider 卡片内渲染**，覆盖添加与编辑两条路径）与 `settings.section`（独立设置页，用于全局总览与默认值）。

---

## 3. 现有机制（含证据）

### 3.1 重试策略是 provider 级、注册期捕获

`@deepseek-ai/dsh-llm` 的 `RetryPolicySchema` 只有两种模式：

```ts
// dsh-llm/lib/types/retry-policy.js
normalPolicySchema = { mode: 'normal', maxRetries: 5, retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT], backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } }
alwaysPolicySchema = { mode: 'always', backoff: {…} }
```

- 该策略在 `llm.registerAdapter()` 时按 provider 路由捕获一次；`prepareCall()` 把它放进 `PreparedLlmCall.retryPolicy`。
- `llm-pi-ai` 的 `providers.<route>.retryPolicy` 是唯一的用户配置入口（README：`retryPolicy | normal, 5 retries | Provider-owned retry policy executed by dsh-llm-retry`）。
- 改 `retryPolicy` 会原子地 `registration.replace()` 重新注册路由，**无需重启**（`dsh-llm-pi-ai/README.md:111`）。但粒度仍是 provider。

### 3.2 内置执行器的退避算法是硬编码指数 + 抖动

```js
// dsh-llm-retry/lib/index.js:44-49
function localDelay(config, retry, random) {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
  return Math.min(exponential * jitter, config.maxDelayMs)
}
```

`ResolvedRetryBackoff` 只暴露 `{ initialDelayMs, maxDelayMs, jitterRatio }`，且 `resolveRetryPolicy` 对未知键直接抛错。**固定间隔与线性递增在这个契约里无法表达**，任何「改配置」的方案（方案 B）上限就是指数退避。

### 3.3 `0 = 无限` 与 `maxRetries: 0` 语义冲突

原生 `normal` 模式下 `previousRetry >= maxRetries` 时停止，所以 `maxRetries: 0` 表示「一次都不重试」。而用户要的 `0` 表示「无限」。原生表达「无限」的只有 `mode: 'always'`。因此存储值 `0` 必须在解析时映射为 `mode: 'always'`（或本插件自己的无限分支），**不能**透传成 `maxRetries: 0`。

### 3.4 `agent/request-error` 契约（接管点）

```ts
'agent/request-error'(
  payload: { agent; turn; step; provider: string; failure: LlmFailure;
             retryPolicy: ResolvedRetryPolicy | undefined; signal: AbortSignal },
  next: () => Promise<{ kind: 'retry' } | undefined>
): Promise<{ kind: 'retry' } | undefined>
```

- 发送点：`dsh-agent-loop/lib/index.js:1136-1143`，`retryPolicy: preparedCall?.retryPolicy`。
- **无处理器时 `next()` 返回 `undefined` → 抛 `LlmError` → 该轮以 error 结束**（`:1143-1146`）。这正是关闭 `llm-retry` 后的默认行为，可由我们接管。
- 同一位置可拿到 `request.provider` / `request.model`（`:1139`、变量 `request`），但**事件只透出 `provider`**。

### 3.5 模型名可以在公开扩展点上拿到

```js
// dsh-agent-loop/lib/index.js:1051, 1052, 1191-1195
while (true) {
  const { config, preparedCall } = await this.prepareRequest(turn, step, signal)
  …
}
// prepareRequest 内：
const proposedConfig = await this.dispatch.waterfall('agent/request', { turn, step, signal },
  () => Promise.resolve(seedConfig))
```

- `agent/request` **每次尝试都会触发**，返回 `LlmCallConfig { provider, model, reasoningEffort?, temperature?, maxTokens?, stop? }`。
- 因此监听 `agent/request`、把结果按 `(agent.id, turn, step)` 缓存，即可在 `agent/request-error` 里确定失败模型；兜底用持久化的 `request/context` 事件（`Session.requestContext()`）。
- 压缩/会话标题调用不经过这个瀑布，不会污染缓存。

### 3.6 每步计数已经由会话投影实现

```js
// dsh-llm-retry/lib/index.js:88-107
if (event.type === 'step/start' || event.type === 'turn/end') return {}
if (event.type !== 'llm/retry') return state
… key = retryStateKey(provider, policyKey) …
```

`step/start` 重置 ⇒ 计数天然按步。这正是 R3 要的语义，直接沿用。

### 3.7 重试 UI 是事件驱动，不是投影驱动

- `llm/retry` / `llm/retry-started` 都在 `@deepseek-ai/dsh-session` 的 `KNOWN_SESSION_EVENT_TYPES` 里（`dsh-session/lib/types/known-event-types.js:46-47`）。
- 读它们的是 `@deepseek-ai/dsh-client-ui-chat`（重试卡片）与 `dsh-client-ui-trajectory`，两者都**直接读事件**，不读 `llmRetry` 投影。
- `llmRetry` 投影在全仓库只有 `dsh-llm-retry` 自己引用。
  ⇒ **只要发出同名同形状事件，关闭内置 `llm-retry` 不会造成任何 UI 回归。**

事件形状（必须逐字段对齐，格式校验器会检查 `provider` 与当前 `request/header` 一致、`retry` 从 1 开始、`retryId` 稳定、`retry-started` 与已排期的尝试配对）：

```js
// 排期（normal 模式）
agent.session.append('llm/retry', { retryId, turn, step, provider, mode: 'normal',
  policyKey, retry, maxRetries, delayMs, failure })
// 排期（always 模式，无 maxRetries）
agent.session.append('llm/retry', { retryId, turn, step, provider, mode: 'always',
  policyKey, retry, delayMs, failure })
// 冷却结束、即将发起下一次尝试
agent.session.append('llm/retry-started', { retryId, turn, step, retry })
```

### 3.8 设置只能写 volatile 字段，命名空间 = profile 条目 id

- `SettingsForms.write()` 对每个写入路径调用 `isVolatilePath`，非 volatile 直接抛 `Config field "…" is not volatile`（`dsh-settings/lib/index.js:501-537`）。
- `ns` 就是 Loader 条目 id（`llm-pi-ai` 之类），不存在「任意命名空间」。
- schemastery 提供 `Schema.prototype.volatile()`（`schemastery/src/index.ts:480-482`），且**volatile 节点必须是固定对象路径、不能嵌在另一个 volatile 内**（`validateVolatileSchema`，`:491-505`）。`inner`（dict 值 / 数组元素 / `sKey`）会被标记为 blocked。
  ⇒ 正确写法是给 **dict 本身**加 volatile：`models: z.dict(ModelPolicy).volatile()`；子字段随父生效，`isVolatilePath` 会短路返回 true。
- **本构建不存在 `ctx.settings.get()`，也没有 `settings/updated` 事件**（全 asar grep 零命中，Service/Event 目录也没有）。已安装的 `dsh-reasoning-effort@0.2.8` 用了 `ctx.settings.get()`，其读取路径在当前构建是失效的——**不要照抄**。
  - 读取：读取自身 `Config` 的 volatile 字段 `config.models.get()`。
  - 写入：`settings.mutate(id, ops, revision)`（客户端侧经 Remote）。

### 3.9 「设置 → 模型」页的真实形态

- **没有「添加模型」弹窗**。模型是 provider 卡片里的行内行；「添加模型」= 向草稿 `models[]` 追加 `{ id: '' }`，随 provider 一起用**一次** `settings.mutate('llm-pi-ai', [{op:'set', path:['providers', route], value: profile}], revision)` 落盘。
- 添加 provider 是一张行内卡片（目录选择 / 自定义 API 两种模式），只有「拉取模型列表」「删除确认」是 Modal。
- 可注册的插槽（已用 client `Slots.listSubTree` 实地确认）：

| 插槽 | 类型 | 用途 | 与需求的关系 |
| --- | --- | --- | --- |
| `settings.models.provider-card` | keyed（key = `settingsNs`） | provider 卡片内的厂商扩展区，**已保存的卡片与添加目录面板都会派发** | **R4 + R5 的主入口** |
| `settings.models.footer` | list | provider 行与添加控件之后的扩展区 | 全局入口备选 |
| `settings.section` | list | 新的设置页 | 全局总览页 |

`settings.models.provider-card` 的 owner props：

```ts
interface ProviderCardExtrasOwnerProps {
  provider: ProviderDirectoryEntry   // 目录行：route id、显示名、settings 地址、live 状态
  configured: boolean                // 该 provider 是否已被某层配置
  keyConfigured: boolean             // api-key 凭据是否已配置
}
```

注意：手工新建、尚未保存的 draft 卡片不派发该插槽（没有目录行）。因此**全新 provider 的首个保存之前看不到重试设置**；保存后立即出现。已存在 provider 里「添加模型」时该区域可见。

### 3.10 可选方案与取舍

| 方案 | 做法 | 判定 |
| --- | --- | --- |
| A | 关闭 `llm-retry`，插件自建执行器 + 自有设置命名空间 | **采用**：唯一能同时满足 R1/R2/R3 的公开路径 |
| B | 保留 `llm-retry`，插件改写 `llm-pi-ai` 的 `retryPolicy` | 否：粒度只有 provider，且冷却只能指数 |
| C | 每个模型一个合成 provider | 否：`DUPLICATE_ADAPTER`、凭据/目录重复、provider 抖动 |
| D | 包装/替换内置 Models 页面组件 | 否：内置组件未导出，`settings.section` 属 `shadows-shipped-ui` 风险 |

---

## 4. 总体架构

一个 bundle，两个半边：

```
dsh-model-retry/
├─ package.json          # dsh.bundle.patch + dsh.client{platform:"web", inject:[…]}
├─ cordis.patch.yml      # 关闭 llm-retry 行；插入 model-retry 行
├─ index.js              # Host：重试执行器 + 配置契约
├─ client.js             # 浏览器：设置区控件（classic-script bundle）
├─ locale/en.json        # meta.title / meta.description
├─ locale/zh.json
├─ icon.svg
└─ README.md
```

### 4.1 装配补丁

```yaml
# cordis.patch.yml
- id: llm-retry
  disabled: true            # 由本插件接管 agent/request-error

- insert:
    - id: model-retry
      name: dsh-model-retry
      config: {}
```

- 载荷层的 `id` 补丁会替换该行字段；`disabled: true` 让内置行不再挂载。
- 校验方式：`plugin_manager list_plugins` 看 `llm-retry` 行的 `fiberPhase`，并确认 `agent/request-error` 上只剩我们的监听器。

### 4.2 数据流

```
用户点「保存」──▶ ctx.remote.settings.mutate('model-retry', ops, revision)
                        │
                        ▼  profile cordis.patch.yml 里的 model-retry 行 config
                 Loader 校验 → Config（models 为 volatile）
                        │
┌───────────────────────┴───────────────────────────────┐
│ Host 每次模型尝试：                                     │
│  agent/request  ──▶ 缓存 (agent.id,turn,step)→{provider,model}
│  （尝试失败）                                           │
│  agent/request-error ──▶ 查 model ▸ 查 policy           │
│        ├─ 未配置 → 复刻内置算法（payload.retryPolicy）    │
│        └─ 已配置 → 本插件算法（fixed / increment，0=无限）│
│              ├─ 冷却可取消（AbortSignal.any）             │
│              ├─ append llm/retry → 等待 → append llm/retry-started
│              └─ return { kind: 'retry' }                │
└────────────────────────────────────────────────────────┘
```

---

## 5. 配置契约（Host `Config`）

存储键 `provider/model`（与 `LlmCallConfig` 一致，天然唯一）：

```yaml
- id: model-retry
  name: dsh-model-retry
  config:
    # 未单独配置的模型：inherit = 完全复刻 DSH 原生行为（安全默认）
    unconfigured: inherit          # inherit | off | <policy>
    # 全局默认模板（新增模型时预填；已配置的模型以自身条目为准）
    defaults:
      retries: 5
      delayMode: fixed
      delaySeconds: 2
      incrementSeconds: 2
      maxDelaySeconds: 120
      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
    models:
      yundu/gpt-6-astra:
        retries: 0                 # 0 = 无限重试
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

schemastery 定义（要点见 §3.8）：

```js
import z from '@deepseek-ai/schemastery'

const DEFAULT_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

// 工厂：volatile 节点必须落在固定对象路径，且不能是 dict 的内层，
// 所以 defaults 与 models 的条目不能共用同一个 schema 实例。
function modelPolicySchema() {
  return z.object({
    retries: z.number().step(1).min(0).default(5)
      .description('0 表示无限重试；N 表示最多重试 N 次（按步计数）'),
    delayMode: z.union([z.const('fixed'), z.const('increment')]).default('fixed')
      .description('fixed：固定间隔；increment：每次间隔在上次基础上再加 incrementSeconds'),
    delaySeconds: z.number().min(0).default(2).description('首次重试前等待的秒数'),
    incrementSeconds: z.number().min(0).default(2).description('递增模式下每次额外增加的秒数'),
    maxDelaySeconds: z.number().min(0).default(120).description('单次等待上限（秒），0 = 不封顶'),
    retryableCodes: z.array(z.string()).default([...DEFAULT_CODES]).description('允许重试的错误码'),
  })
}

export const Config = z.object({
  unconfigured: z.union([z.const('inherit'), z.const('off')]).default('inherit')
    .description('未配置的模型：inherit 沿用 provider retryPolicy；off 不重试').volatile(),
  defaults: modelPolicySchema()
    .description('新增模型时预填的模板值；已配置的模型以自身条目为准').volatile(),
  models: z.dict(modelPolicySchema())
    .description('按 provider/model 覆盖的策略').volatile(),
})
```

> **实现后修正（与初稿不同）**
> - `unconfigured` / `defaults` / `models` **三者都必须 volatile**：设置服务只允许写 volatile 路径（`dsh-settings/lib/index.js:501-537`），而 `volatileForm()` 只会把 volatile 子节点投影到前端表单（`:118-131`）。初稿说「defaults 不必 volatile」是错的——那样客户端既看不到也写不了它。
> - `retries` 的 schema 默认值改为 **5**（DSH 原生默认）：若默认是 `0`，只写了 `delaySeconds` 的条目会意外变成「无限重试」。
> - `defaults` 只是**模板**，运行时不参与合并：schemastery 会给每个 dict 条目补齐字段默认值，因此「用 defaults 作为条目基底」在语义上不可实现，而且会造成 defaults 永远不生效的假象。
> - volatile 的 `unconfigured` 在 host 侧拿到的是 `Volatile` 包装对象，必须 `unwrap` 后才能比较（这是实现阶段抓到的一个真实 bug）。

设计取舍：

- `unconfigured: inherit` 是**默认值**，保证「装了插件但没配任何模型」时行为与原生完全一致（含指数退避与 `maxRetries: 5`）。
- `models` 的 key 用 `provider/model` 而不是嵌套两层，避免 provider 名与模型名冲突时的路径歧义。
- 插件用自己的设置页承载 UI，因此 `apply` 里通过可选注入调用 `ctx.settings.configure({ auto: false })` 关掉自动生成页，避免出现两张重复的配置页。

---

## 6. Host 半实现

### 6.1 插件导出

```js
export const name = 'model-retry'
export const inject = ['agents', 'sessions', 'sessionProjections', 'llm']
export function apply(ctx, config) { … }
export const Config = …
```

### 6.2 状态：每步重试计数投影

```js
const retryStateSchema = z.object({
  retry: z.number().int().nonnegative(),
  retryId: z.string(),
})

ctx.sessionProjections.register({
  key: 'modelRetry',                       // 自己的 key，避免与已关闭的 llmRetry 冲突
  stateVersion: 1,
  stateSchema: z.record(z.string(), retryStateSchema),
  init: () => ({}),
  apply: (state, event) => {
    if (event.type === 'step/start' || event.type === 'turn/end') return {}   // ← R3
    if (event.type !== 'llm/retry') return state
    const key = retryStateKey(event.data.provider, event.data.policyKey)
    const entry = state[key]
    if (entry?.retry === event.data.retry && entry.retryId === event.data.retryId) return state
    return { ...state, [key]: { retry: event.data.retry, retryId: event.data.retryId } }
  },
})
```

> 取 `Session` 的方式：事件载荷里的 `Agent` 类型只声明了 `id`，但运行时的 Agent 实例带 `session` 字段（内置 `llm-retry` 就是这么用的）。为稳妥起见，实现里统一走公开 API `ctx.sessions.get(agent.id)` 取 Session，回调里再传入。

`policyKey` 由「生效策略」序列化而来（含 `retries`/`delayMode`/`delaySeconds`/`incrementSeconds`/`maxDelaySeconds`/`retryableCodes` 排序后的值）。同一 step 内策略不变 ⇒ key 稳定 ⇒ 计数连续；用户中途改配置 ⇒ key 变化 ⇒ 计数重置（符合直觉）。

### 6.3 模型解析

```js
const modelByStep = new Map()   // `${agent.id}|${turn}|${step}` → { provider, model, at }

ctx.on('agent/request', async (payload, next) => {
  const config = await next()
  modelByStep.set(stepKey(payload.agent, payload.turn, payload.step), config)
  return config
})

function resolveModel(agent, turn, step, provider) {
  const cached = modelByStep.get(stepKey(agent, turn, step))
  if (cached) return cached
  // 兜底：持久化 request/context 里记录的已冻结配置
  return ctx.sessions.get(agent.id)?.requestContext()?.config
}
```

清理：`agent/disposed` 时按前缀清理该 agent 的缓存；步内条目数量有界（每步 1 条），不必每步清理。

### 6.4 决策主流程

```js
ctx.on('agent/request-error', (payload, next) => track(recover(payload, next)))

async function recover({ agent, turn, step, provider, failure, retryPolicy, signal }, next) {
  if (signal.aborted) return next()

  const model = resolveModel(agent, turn, step, provider)?.model
  const policy = policyFor(provider, model)          // 读 config.models.get()，实时

  if (policy === undefined) {
    // 未配置：完全复刻内置算法，保证零行为变化
    return stockRecover({ agent, turn, step, provider, failure, retryPolicy, signal }, next)
  }
  if (policy.retries !== 0 && !policy.retryableCodes.includes(failure.code)) return next()
  if (policy.retries === 0 && !policy.retryableCodes.includes(failure.code)) return next()

  const policyKey = policyKeyOf(policy)
  const previous = ctx.sessionProjections.stateOf(agent.session, 'modelRetry')[retryStateKey(provider, policyKey)]
  const previousRetry = previous?.retry ?? 0

  // 0 = 无限；N = 最多 N 次
  if (policy.retries !== 0 && previousRetry >= policy.retries) return next()

  const retry = previousRetry + 1
  const retryId = previous?.retryId ?? randomUUID()
  const delayMs = computeDelay(policy, retry, failure)

  return backoff(agent, turn, step, provider, failure, policy, policyKey, retry, retryId, delayMs, signal)
}
```

### 6.5 冷却时间

```js
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

function computeDelay(policy, retry, failure) {
  // 服务器要求优先
  const after = failure.providerRetryAfterMs
  if (Number.isFinite(after) && after > 0 && after <= policy.maxDelaySeconds * 1000) return after

  const base = policy.delaySeconds * 1000
  const step = policy.incrementSeconds * 1000
  const raw = policy.delayMode === 'increment' ? base + (retry - 1) * step : base
  const cap = Math.min(policy.maxDelaySeconds * 1000, MAX_TIMER_DELAY_MS)
  return Math.max(0, Math.min(raw, cap))
}
```

- `increment` 数列：`2s → 4s → 6s → …`（base 2、increment 2）。
- `fixed` 数列：`2s → 2s → 2s → …`。
- 若 `providerRetryAfterMs` 超过封顶：`increment` 模式退回本地计算，`fixed` 模式同理（与原实现「超上限则 normal 直接放弃 / always 用本地」的取舍保持一致，这里统一为「退回本地计算」，更符合 R1/R2 的意图）。
- 注意该字段只有官方 `dsh-llm-deepseek` 路由会提供，`openai-completions` 路由不会（见 §8.2 注）。

### 6.6 可取消等待 + 事件落盘

照抄内置实现的骨架（`dsh-llm-retry/lib/index.js:68-81, 116-150, 175-183`）：

```js
const lifetime = new AbortController()
const active = new Set()

async function backoff(agent, turn, step, provider, failure, policy, policyKey,
                       retry, retryId, delayMs, signal) {
  const fused = AbortSignal.any([signal, lifetime.signal])
  if (fused.aborted) return

  const data = policy.retries === 0
    ? { retryId, turn, step, provider, mode: 'always', policyKey, retry, delayMs, failure }
    : { retryId, turn, step, provider, mode: 'normal', policyKey, retry,
        maxRetries: policy.retries, delayMs, failure }
  agent.session.append('llm/retry', data)

  if (!await cancellableDelay(delayMs, fused)) return
  agent.session.append('llm/retry-started', { retryId, turn, step, retry })
  return { kind: 'retry' }
}

ctx.effect(() => async () => {
  disposeListeners()
  lifetime.abort(new Error('model-retry disposed'))
  await Promise.allSettled([...active])
}, 'model-retry: abort and drain active waits')
```

要点：

- 事件形状随生效模式切换（`0 → always` 无 `maxRetries`；`N → normal` 带 `maxRetries: N`），与内置实现一致，前端无需改动。
- `lifetime` 保证插件卸载时无限重试也能立刻中断。
- 无限重试的安全阀：`turn` 的 `signal` 在用户点停止、agent 销毁时 abort（`agent-loop:815-820, 1700-1706`），因此 `0` 不会变成不可取消的死循环。

### 6.7 `unconfigured: inherit` 的复刻实现

```js
async function stockRecover({ agent, turn, step, provider, failure, retryPolicy: policy, signal }, next) {
  if (policy === undefined) return next()
  if (policy.mode === 'normal' && !policy.retryableCodes.includes(failure.code)) return next()

  const policyKey = stockPolicyKey(policy)
  const previous = stateOf(...)[key]
  const previousRetry = previous?.retry ?? 0
  if (policy.mode === 'normal' && previousRetry >= policy.maxRetries) return next()

  const retry = previousRetry + 1
  const delayMs = stockLocalDelay(policy, retry, failure)   // 原样复刻指数 + 抖动
  return backoff(…)
}
```

这段是与上游 `dsh-llm-retry` 的逐行等价移植（指数 + 抖动 + `Retry-After` 上限处理）。好处：关闭内置插件后，**未配置模型的用户感知不到任何差别**；升级 DSH 时对齐这一段即可。

---

## 7. Client 半实现

### 7.1 主入口：provider 卡片内的扩展区

```js
ctx.slots.register({
  name: 'settings.models.provider-card',
  key: 'llm-pi-ai',        // 只挂在 llm-pi-ai 的卡片上
}, RetryExtras)
```

`RetryExtras({ provider, configured, keyConfigured })`：

1. 通过 `ctx.configForms` / `ctx.remote.settings.describe()` 读取：
   - `llm-pi-ai` 表单值 → `providers[provider.provider].models[]`（只读，用于列出该 provider 有哪些模型）；
   - `model-retry` 表单值 → `models` 映射与 `defaults`。
2. 渲染该 provider 的模型列表，每行右侧一组控件：
   - **重试次数**：数字输入（整数 ≥ 0），下方 hint「0 = 无限重试」；
   - **冷却策略**：`SegmentedControl`（固定 / 递增）；
   - **冷却基数（秒）**：数字输入；
   - **递增（秒）**：仅 `increment` 模式显示；
   - **上限（秒）**：折叠在「高级」里，默认 120。
3. 变更即写：单字段 `settings.mutate('model-retry', [{ op:'set', path:['models', `${provider}/${model}`, field], value }], revision)`；「重置为默认」用 `{ op:'unset', path:[…] }`。
4. 未在本 provider 模型表里的历史条目（模型已删除）折叠显示，提供「清理」动作。

因为该插槽在**已保存的 provider 卡片**内渲染，而「添加模型」本身就是在同一张卡片的模型表里追加行，**R4（添加时可配）与 R5（随时可改）由同一个组件同时满足**。

### 7.2 兜底：独立设置页

```js
ctx.slots.register({
  name: 'settings.section',
  id: 'model-retry',
  order: 60,
  label: () => t('section.title'),      // 「模型重试」
}, ModelRetrySection)
```

内容：按 provider 分组的全量模型表（与 §7.1 同一套行组件）+ 全局默认值 + `unconfigured` 策略选择。价值：

- 补上「全新 provider 保存之前看不到卡片扩展区」的空档；
- 提供一处总览，便于批量检查。

顺序建议（`order`）放在「模型」之后，作为紧邻的独立页。

### 7.3 语言与视觉

- 客户端文案走 `ctx.locale.register(NS, { zh, en })`；`locale/*.json` 只放 `meta.title` / `meta.description`。
- 注意 `t()` **不做插值**，需要 `.replace('{n}', …)`。
- 用宿主主题变量，不自定义硬编码颜色：`--dsw-alias-settings-card-fill`、`--dsw-alias-settings-card-stroke`、`--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-border-l2/l3`、`--dsw-alias-state-warn-label`、`--dsw-alias-bg-layer-2`、`--dsw-alias-interactive-bg-hover`、`--dsw-radius-md`、`--dsw-focus-ring-color`。
- 错误态复用设置页风格：字段下 `<p class="error">` + 禁用保存按钮（数字按文本输入、`parse` 后 NaN 拒绝；与内置页面一致）。

### 7.4 客户端打包

- `package.json` 需要 `exports["./client"]` 与 `dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-api-remotes"] }`。
- 浏览器产物是 classic-script bundle：

```js
window.__ModuleLoader__.load({
  id: 'dsh-model-retry',
  factory: (require) => {
    const React = require('react')           // 平台种子，不打包 React
    const { jsx } = require('react/jsx-runtime')
    …
    return module.exports
  },
})
```

- CSS 由 bundle 自行注入 `<style data-plugin="…">`；所有副作用必须放在 `apply` 内并用 `ctx.effect` 回收。

---

## 8. 打包、安装与验证

### 8.1 安装

```powershell
# 在 workspace 里开发，然后
plugin_manager  action: install_bundle  target: <绝对包目录>
```

`install_bundle` 负责 pnpm 安装与 bundle 选择，**不要手写 profile 的 `package.json` / `cordis.patch.yml`**。

### 8.2 验证清单

| # | 断言 | 手段 |
| --- | --- | --- |
| 1 | `llm-retry` 行已停用 | `plugin_manager list_plugins` 看 fiberPhase；`agent/request-error` 上只剩我们的监听器 |
| 2 | 未配置模型行为不变 | 不配置任何模型，制造 5xx，观察仍是 5 次指数退避（间隔 ≈ 0.5/1/2/4/8s ± 抖动） |
| 3 | `retries: 0` 真的无限 | 让 mock 服务持续返回 500，确认不断重试；点「停止」后立刻中断且 `turn/end` 为 aborted |
| 4 | `retries: 3` 上限正确 | 确认 4 次尝试后终态，事件里 `retry` 依次 1..3 |
| 5 | 按步不按轮 | 一步内失败 3 次后成功，下一步再失败时计数从 1 重新开始 |
| 6 | 固定间隔 | 事件 `delayMs` 恒等于 `delaySeconds*1000` |
| 7 | 线性递增 | `delayMs` = base、base+inc、base+2·inc …，且不超 `maxDelaySeconds` |
| 8 | Retry-After 行为 | 见下注：pi-ai 路由**不会**透出该头，官方 DeepSeek 路由才会 |
| 9 | 聊天重试卡片正常 | 触发重试，确认 UI 出现「重试中」卡片并可展开 |
| 10 | provider 卡片内可编辑 | 在「设置 → 模型」某 provider 卡片内增删改，刷新后保留 |
| 11 | 添加模型后立即可配 | 新增一行模型并保存，扩展区立刻列出该模型 |
| 12 | 未保存的 draft 卡片不报错 | 添加 provider 草稿态，确认无异常渲染 |
| 13 | 卸载干净 | `remove_bundle` 后恢复原生重试行为 |

> **关于 Retry-After（实现后修正）**：`failure.providerRetryAfterMs` 只有 `dsh-llm-deepseek` 适配器会填（`dsh-llm-deepseek/lib/index.js:1776`）；`dsh-llm-pi-ai`（`openai-completions` 等）在 `mapStopReason` 里只产出 `{ message, code }`，整个包内 `retry-after` 零命中，pi-ai 自带的内部重试也被 DSH 关掉了（`maxRetries: 0`）。因此在 pi-ai 路由上该分支是死代码——保留它是为了与内置实现一致、并服务官方 DeepSeek 路由。验收断言应写成：pi-ai 路由上「按本地间隔」、DeepSeek 路由上「等于 Retry-After」。

第 2/3/4/6/7/8 条可用一个本地 mock OpenAI 兼容端点（固定 500 / 按次数切换 500→200 / 带 `Retry-After`）来驱动，配合 worker/子代理并发压测更稳。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 关闭内置 `llm-retry` 是**全局**的 | 所有 provider/模型都走本插件 | `unconfigured: inherit` 逐行复刻原生算法；补回归测试 |
| 事件形状/不变量不满足 | 会话格式校验拒绝写入，重试失效 | 严格对齐 §3.7；本地用受支持版本跑一次真实重试验证 |
| `agent/request` 缓存丢失/错配 | 解析不到模型 → 退回 `inherit` | `Session.requestContext()` 兜底；键含 `turn/step` |
| 无限重试 + 固定 1s | 对服务端形成压测 | 默认 `delaySeconds: 2`；UI 明示；保留 `maxDelaySeconds` 与 `Retry-After` |
| volatile 路径约束 | 设置写不进 | `models` 用 `z.dict(...).volatile()`；实现后先用 `settings.mutate` 冒烟 |
| `settings.models.provider-card` 的可用性 | 主 UI 入口失效 | 已用 client `Slots.listSubTree` 实地确认存在；另有 `settings.section` 兜底 |
| DSH 升级后内置算法漂移 | `inherit` 行为与原版出现差异 | 该段代码集中在一个文件、有注释标注对应上游行号，升级时对照 |
| provider 卡片体积变大 | 卡片过长 | 扩展区默认折叠，仅显示「已配置 N 个模型」摘要 |

---

## 10. 实施计划

| 阶段 | 产出 | 完成判据 |
| --- | --- | --- |
| P0 | 包骨架 + patch + locale + icon；`llm-retry` 停用生效 | `list_plugins` 显示新行、旧行停用；不配置时行为不变 |
| P1 | Host 执行器（inherit 复刻 + 每步计数 + 事件落盘） | 验证 2/3/4/5 通过（先用手写 `config.models` 驱动） |
| P2 | fixed / increment 冷却 + Retry-After | 验证 6/7/8 通过 |
| P3 | Client：provider 卡片扩展区（R4+R5） | 验证 10/11/12 通过 |
| P4 | Client：独立设置页 + 全局默认 + `unconfigured` | 可在模型删除后清理残留条目 |
| P5 | 文档、README、双语、视觉收尾 | 验证 9/13 通过，卸载可还原 |

预计 P0–P2 是主体工作量；P3 的关键未知只有一处——`ctx.configForms` 在浏览器半边的确切 API 形态（`describe()` 返回值与 revision 的取用方式），实现时需要对着 `@deepseek-ai/dsh-api-settings-controller` 的 Remote 契约核对一次。

---

## 附录 A：调研工具

仓库内 `scripts/asar.mjs` 可在不启动应用的条件下读取 Desktop 版 `app.asar`（普通 Node 进程即可解析）：

```powershell
$node='%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node scripts/asar.mjs list 'dsh/node_modules/@deepseek-ai/dsh-llm-retry'
& $node scripts/asar.mjs cat  'dsh/node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js'
& $node scripts/asar.mjs grep 'agent/request-error' 'dsh/node_modules/@deepseek-ai/dsh-agent-loop'
& $node scripts/asar.mjs grep 'llm/retry' 'dsh/node_modules' --files-only
```

实现阶段用它核对任何不确定的 API，比翻 bundled `lib/index.js` 快得多。

## 附录 B：实现与验收记录（2026-11-08）

### 已交付

| 文件 | 说明 |
| --- | --- |
| `package.json` | bundle 清单（`dsh.bundle.patch` + `dsh.client`） |
| `cordis.patch.yml` | 停用 `llm-retry`；插入 `model-retry` |
| `index.js` | Host 重试执行器（约 470 行） |
| `client.js` | 浏览器半：provider 卡片扩展区 + 独立设置页 |
| `locale/{en,zh}.json`、`icon.svg`、`README.md` | 展示元数据与文档 |
| `scripts/` | mock provider + 会话日志解析/断言工具（独立于插件） |

已安装到 profile `desktop`（`dsh-model-retry 0.1.0`，link 到本仓库目录）。

### 验收证据

1. **离线引擎仿真**（30 条断言全绿）：上限重试、无限重试、固定/递增/封顶间隔、按步重置、非可重试码、未配置模型的存量等价性、`unconfigured: off`、冷却期间中止、volatile 热更新。
2. **配置契约**：`Config.listConfigs include:model-retry` → `status: schema`，`unconfigured` / `defaults` / `models` 均带 `x-cordis.volatile: true`。
3. **接管生效**：`include:llm-retry` → `enabled: false`；`include:model-retry` → `fiberPhase: active`。
4. **客户端注册**：`Slots.listSubTree(settings.models.provider-card)` → occupant `{ registrant: "Kb", key: "llm-pi-ai", active: true }`。
5. **端到端（真实 agent loop + mock provider + 会话日志断言）**：
   - 方案 `retries: 2, fixed 200ms` → 3 次 HTTP 尝试（间隔 226 / 233 ms），`RETRY CHAIN` 两行 `retry 1/2, delay 200ms, mode normal, max 2, code SERVER, retryId 稳定`，`turn 1: completed`，格式校验 `PASS`。
   - 方案 `retries: 0（无限）, increment 100ms +150ms` → 4 次尝试（间隔 125 / 272 / 417 ms），`retry 1/2/3` 的 `delayMs` 为 `100 / 250 / 400`，`mode: always`、无 `maxRetries`，`turn 1: completed`，格式校验 `PASS`。
   - 测试用的临时 profile 配置已按哈希比对原样还原，mock 已停止。

### 增量：直接模型调用（自动审查）的重试

自动审查、会话标题、上下文压缩走的是 `ctx.llm.stream()` 的单次直接调用，失败即终态；自动审查把这种失败转成「被审查的工具调用被拒绝」，即便审查模型从未作出判断。

在 `llm/stream` 瀑布上补的这层重试：

- 只重试 `RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE`；认证、参数类错误不重试；
- 只重试「**尚未吐出任何 chunk**」的 `finish(error)`；正常 `stop` 的审查决策永不重试；已产生内容不重开；
- 用 `isAgentLoopRequest`（`@deepseek-ai/dsh-llm` 的进程内 WeakSet 标记）跳过 agent loop 请求，避免与按步重试叠加；该 import 失败时降级为启发式判断，不影响按步重试；
- 预算沿用同一套按模型策略，未配置则沿用 provider 的 `retryPolicy`；
- 离线断言 21 条全绿（429 重试、5xx 重试、AUTH 不重试、部分输出不重开、loop 请求跳过、真实 denial 保持、无限重试、继承 stock、冷却中断、已中止直接透传）。

**注意**：`dsh-base` 的 hmr 行 `root: []` ⇒ 模块监听默认关闭，改动 Host 代码后必须**重启 Harness** 才会载入新的模块代（本次改动因此需要一次重启）。

### 仍未验证（如实记录）

- **界面视觉**：Web 页面需要 `dsh web` 打印的带令牌 URL，本机 `http://127.0.0.1:11882` 直接打开会停在 “authentication required”，Electron 窗口也未开放 CDP，因此无法截图。客户端半的**加载与槽位注册**已由第 4 条证明，但**渲染效果、间距、暗色主题**仍待人工目视确认。
- **真实服务端故障**：只验证了 mock 触发的 `SERVER`/`RATE_LIMIT` 路径；限流、超时、`EMPTY_RESPONSE`、以及官方 `dsh-llm-deepseek` 路由上的 `providerRetryAfterMs` 仍是人工项。
- **卸载还原**：`remove_bundle` 后应恢复原生重试，未实测。

### 使用前提

插件默认 `unconfigured: inherit`，安装后**不配置任何模型时行为与原生完全一致**。要启用按模型策略，需要在「设置 → 模型」的 provider 卡片里设置，或在 profile 补丁层写：

```yaml
- id: model-retry
  name: dsh-model-retry
  config:
    models:
      yundu/gpt-6-astra: { retries: 0, delayMode: increment, delaySeconds: 1, incrementSeconds: 2 }
```

## 附录 C：上游对应位置速查

| 用途 | 位置 |
| --- | --- |
| 退避算法（要复刻） | `dsh-llm-retry/lib/index.js:44-49` |
| 重试计数投影（要复刻） | `dsh-llm-retry/lib/index.js:88-107` |
| 事件落盘 + 可取消等待 | `dsh-llm-retry/lib/index.js:68-81, 116-150, 175-183` |
| `agent/request-error` 发送点 | `dsh-agent-loop/lib/index.js:1136-1143` |
| `agent/request` 发送点（取 model） | `dsh-agent-loop/lib/index.js:1191-1195` |
| 重试策略默认值 | `dsh-llm/lib/types/retry-policy.js` |
| 设置 volatile 写入校验 | `dsh-settings/lib/index.js:501-537` |
| schemastery volatile 规则 | `schemastery/src/index.ts:480-482, 491-505` |
| 已知会话事件类型 | `dsh-session/lib/types/known-event-types.js:46-47` |
