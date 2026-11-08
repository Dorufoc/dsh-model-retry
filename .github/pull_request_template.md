## 这个 PR 做了什么

<!-- 一句话说明改动目的 -->

## 为什么

<!-- 关联的 issue、观察到的问题，或设计上的必要性 -->

## 怎么验证的

<!-- 勾选并补充实际输出 -->

- [ ] `node scripts/run.mjs selftest`
- [ ] `npm test`（Host 重试语义）
- [ ] 端到端：mock provider + 真实 agent loop + 会话日志断言（见 docs/verification.md）
- [ ] `dsh --profile <name> --dump-config` 中出现 `model-retry` 行

## 影响面

- [ ] 改变了重试语义（错误码、计数、冷却）
- [ ] 改变了配置字段（已同步 README 字段表与 `Config` 的 `description`）
- [ ] 改变了设置界面（已同步中英文文案）
- [ ] 改变了补丁或加载方式（已说明对安装/卸载的影响）
- [ ] 仅文档/注释

## 其他说明

<!-- 兼容性、已知限制、后续计划 -->
