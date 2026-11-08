# 参与贡献

感谢你愿意改进 dsh-model-retry。这个插件刻意保持「无构建步骤、纯 JavaScript、依赖 DSH 自身运行时」的形态，请在改动时尽量维持这一点。

## 开始之前

1. 阅读 [README](README.md) 与 [设计稿](docs/design.md)，确认你要改的是哪一层：
   - **Host 半**（`index.js`）：重试执行器与配置契约；
   - **浏览器半**（`client.js`）：设置界面控件；
   - **补丁**（`cordis.patch.yml`）：bundle 如何挂进 profile。
2. 确认目标 DSH 版本。插件针对某个 RC 版本验证过，上游扩展点（`agent/request-error`、`llm/stream`、会话事件格式）可能在不兼容的方式下变化。

## 开发循环

```powershell
# 安装到当前 profile（本地目录即链接到本仓库，改代码后重启生效）
dsh plugin --profile desktop add D:\path\to\dsh-model-retry

# 确认 bundle 与插件行都在
dsh --profile desktop --dump-config

# mock 服务自检（不依赖 DSH 运行时）
node scripts/run.mjs selftest

# 离线单元断言（需要能解析 DSH 的 peer 包）
npm test
```

改完 Host 或浏览器半的代码后，**必须重启 Host / 桌面应用**：DSH 的模块热重载是 opt-in 且默认关闭（`dsh-base` 的 hmr 行 `root: []`），刷新页面不会重新载入 Host 模块。

## 改动的验收标准

| 改动类型 | 至少需要 |
| --- | --- |
| Host 重试语义 | `test/engine.test.mjs` 全绿，并在 PR 里说明受影响的错误码与计数规则 |
| 直接调用重试 | `test/stream-retry.test.mjs` 全绿，并说明是否改变了对 agent loop 请求的判定 |
| 配置字段 | `docs/design.md`、`README.md` 字段表、`Config` 的 `description` 三处同步 |
| 设置界面 | 说明中英文文案是否成对更新（`client.js` 内的 `zh` / `en` 字典） |
| 补丁/加载方式 | 说明对 `--dump-config`、安装/卸载路径的影响 |

端到端验证（mock provider + 真实 agent loop + 会话日志断言）请参考 [docs/verification.md](docs/verification.md)。

## 提交与 PR

- 一个 PR 只做一件事；同一议题的 README、CHANGELOG、代码要一起改。
- 提交信息建议使用 Conventional Commits：`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`。
- PR 描述请包含：**问题是什么、为什么这样改、怎么验证的**。涉及行为变化时，附上 `delayMs` 序列或会话日志片段。
- 不要提交 `node_modules/`、构建产物或任何凭据。

## 发布新版本

1. 更新 `package.json` 的 `version`。
2. 在 `CHANGELOG.md` 顶部补充该版本的条目（`Added` / `Changed` / `Fixed`）。
3. 运行 `npm run verify`。
4. 打 tag 并发布：`git tag v0.2.0 && git push --tags`。

## 行为准则

保持技术讨论聚焦、就事论事。不接受包含人身攻击、或要求移除安全默认值（例如把未经确认的重试默认开到无限）的改动。
