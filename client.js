/**
 * dsh-model-retry — browser half ("client half" of the Cordis plugin pair).
 *
 * WHAT THIS IS
 *   A prebuilt classic-script bundle loaded by the client module system:
 *   `window.__ModuleLoader__.load({ id, factory })`. Executing the script only
 *   REGISTERS the factory; every side effect (stylesheet injection, locale
 *   registration, slot registrations) runs when the factory is materialized and
 *   `apply(ctx)` is called. React comes from the platform seed word
 *   `require('react')` — never bundled (see WP-1 below for the shipped pattern).
 *
 * WHAT IT RENDERS
 *   1. `settings.models.provider-card` (keyed, key `llm-pi-ai`): the per-model
 *      retry editor for exactly one provider's models, inline in that provider's
 *      card on the Models settings page. Because "add model" appends a row to
 *      that same card's models table, this seat covers both "configure while
 *      adding" and "edit later".
 *   2. `settings.section` (id `model-retry`, order 60): a standalone page with a
 *      provider-grouped table of every declared model, global defaults when the
 *      settings interface exposes them, the `unconfigured` strategy selector,
 *      and cleanup groups for stale policy keys.
 *
 * CONTRACTS THIS FILE WAS WRITTEN AGAINST (verified in the shipped asar)
 *   - Slot registry, node half that serves the slot catalog:
 *     `@deepseek-ai/dsh-cordis-client-runner/lib/client.js:5129-5160` documents
 *     `settings.models.provider-card` as keyed with `registerOptions:[{name:"key",
 *     required:true}]` and owner props `{provider, configured, keyConfigured}`;
 *     the `settings.section` catalog entry lives at `:5292-5342` (id/order/label,
 *     owner prop `close`). Example shape in both catalogs:
 *       ctx.slots.inject(SLOT, () => ctx.slots.register({name:SLOT, ...}, C))
 *     and the shipped `ctx.effect(() => ctx.slots.inject(...))` wrapping appears
 *     e.g. `@deepseek-ai/dsh-client-ui-deliverables/lib/client.js:2306`.
 *   - Settings read accessor: `ctx.configForms.describe()` returns the shared
 *     `SettingsDescribeMirror` with `ensure()/load()/getSnapshot()/subscribe()/
 *     acceptView(view)`; its snapshot is `{status, view:{writable, namespaces[]},
 *     error}` and each namespace view is `{ns, schema, value, base, user,
 *     revision, ...}` — `@deepseek-ai/dsh-client-ui-settings/lib/client.js:1287`
 *     (ConfigForms.describe), `:1337-1474` (SettingsDescribeMirror),
 *     `@deepseek-ai/dsh-api-settings-controller/lib/index.js:274-289,393-400`
 *     (namespace view projection).
 *   - Settings write transport: `ctx.remote.settings.mutate(ns, ops, revision)`;
 *     success is `{ok:true, value:<namespace view>}`, failure
 *     `{ok:false, error:{code, message}}` with `settings/conflict` for a stale
 *     revision — `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:3179-3193`
 *     (the shipped Models page's write helper, same response shape).
 *   - Locale: `ctx.locale.register(NS, {zh, en})`, `ctx.locale.bind(NS)`, and
 *     `t()` performs NO interpolation (callers `.replace('{x}', …)`) —
 *     `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:2316-2318,4437-4444`.
 *   - Store/hook shape: a slot occupant re-renders from a snapshot store; this
 *     bundle uses React's `useSyncExternalStore` directly so it needs no
 *     primitives package (a third-party bundle may only require platform seed
 *     words — `dsh-client-modules/lib/index.js:832-841`).
 *
 * STORAGE (host Config, Loader entry id == settings namespace `model-retry`)
 *   unconfigured: 'inherit' | 'off'
 *   defaults:     Policy
 *   models:       { '<provider>/<model>': Policy }        (volatile in the host)
 *   Policy = { retries, delayMode:'fixed'|'increment', delaySeconds,
 *              incrementSeconds, maxDelaySeconds, retryableCodes }
 *   Writes are path ops against `models.<provider>/<model>.<field>` (or the whole
 *   entry on first create), `defaults.<field>`, and `unconfigured`.
 *
 * NOTE ON VISIBILITY (measured)
 *   The settings describe projects `value` through the namespace's VOLATILE form
 *   (`dsh-settings/lib/index.js:118-131,141-147,409-464`), and a write to a path
 *   outside a volatile node is rejected (`:501-537`). The host Config marks all
 *   three fields volatile (`unconfigured`, `defaults`, `models`), so the full
 *   editor renders. This file still DETECTS whether the interface exposes them:
 *   with an older host whose Config lacks that, a read-only explainer replaces
 *   the editor so no write can ever fail. No behavior depends on the guess.
 */

window.__ModuleLoader__.load({
	id: 'dsh-model-retry',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		/* Platform seed word: React is provided by the shell, never bundled. */
		const React = require('react')
		const h = React.createElement

		/* ------------------------------------------------------------ constants */

		const PLUGIN_ID = 'dsh-model-retry'
		const LOCALE_NS = 'dsh-model-retry'
		const SETTINGS_NS = 'model-retry'
		const PROVIDER_NS = 'llm-pi-ai'
		const SECTION_ID = 'model-retry'
		const SECTION_ORDER = 60
		const STYLE_ATTR = 'data-plugin'

		/** Must match the schema defaults in plugins/dsh-model-retry/index.js. */
		const POLICY_FALLBACK = Object.freeze({
			retries: 5,
			delayMode: 'fixed',
			delaySeconds: 2,
			incrementSeconds: 2,
			maxDelaySeconds: 120,
			retryableCodes: Object.freeze([
				'EMPTY_RESPONSE',
				'RATE_LIMIT',
				'SERVER',
				'TIMEOUT',
				'TRANSPORT',
			]),
		})

		/* --------------------------------------------------------------- copy */

		const zh = {
			'card.title': '失败重试',
			'card.summaryNone': '未配置',
			'card.summaryCount': '已配置 {n} 个模型',
			'card.noModels': '该 provider 还没有已保存的模型',
			'card.noModelsHint': '先在「模型」中新增并保存模型，再回来设置重试策略。',
			'card.unsaved': '此 provider 尚未保存到设置；保存一次后即可为它的模型配置重试策略。',
			'card.removed': '已移除的模型',
			'card.readOnly': '本部署的设置为只读。',
			'card.noNamespace': '重试设置的命名空间不可用（插件未加载），暂时无法保存。',
			'card.loading': '正在读取设置…',
			'card.loadError': '读取设置失败。',

			'section.title': '模型重试',
			'section.intro':
				'为每个模型单独设置失败重试次数与冷却策略。0 表示无限重试；重试次数按步（step）单独计数。',
			'section.defaults': '全局默认值',
			'section.defaultsHint':
				'新增模型时预填的模板值；已配置的模型以自身条目为准，不受这里的修改影响。',
			'section.defaultsUnavailable':
				'全局默认值与「未配置模型」策略由插件配置（cordis.patch.yml）提供，当前设置接口未开放这两项编辑。每个模型仍可单独覆盖。',
			'section.unconfigured': '未配置模型',
			'section.unconfiguredHint':
				'没有单独配置的模型如何处理：沿用 DSH 原生重试策略，或直接不重试。',
			'section.unconfiguredInherit': '沿用原生重试',
			'section.unconfiguredOff': '不重试',
			'section.providers': '按 provider 配置',
			'section.empty': '还没有可配置的模型',
			'section.emptyHint': '在「设置 → 模型」中添加模型后，它们会出现在这里。',
			'section.removed': '已移除的模型',
			'section.removedHint': '这些条目对应的模型已不在该 provider 的模型列表中，可以清理。',
			'section.orphans': '未知 provider 的条目',
			'section.orphansHint': '这些条目的 provider 已不再配置，可以清理。',
			'section.retryableCodes': '触发的错误码',
			'section.footnote':
				'冷却上限 0 表示不封顶；服务端 Retry-After 优先于本地间隔；设置即时保存。',
			'section.loading': '正在读取设置…',
			'section.loadError': '读取设置失败。',
			'section.readOnly': '本部署的设置为只读。',
			'section.noNamespace': '重试设置的命名空间不可用（插件未加载），暂时无法保存。',

			'field.retries': '失败重试次数',
			'field.delayMode': '冷却策略',
			'field.delaySeconds': '冷却基数（秒）',
			'field.incrementSeconds': '每次额外增加（秒）',
			'field.maxDelaySeconds': '冷却上限（秒）',
			'field.advanced': '高级',

			'hint.retries': '0 = 无限重试',
			'hint.delayMode': '固定：每次等待相同时间；递增：每次在上次基础上增加。',
			'hint.delaySeconds': '固定模式下每次等待的时长；递增模式下为第一次等待的时长。',
			'hint.incrementSeconds': '递增模式下，每次重试在首次等待上额外增加的秒数。',
			'hint.maxDelaySeconds': '0 表示不封顶。',

			'option.fixed': '固定间隔',
			'option.increment': '递增间隔',

			'error.count': '请输入 0 或更大的整数。',
			'error.seconds': '请输入 0 或更大的数字。',

			'action.apply': '保存',
			'action.applying': '保存中…',
			'action.enable': '启用',
			'action.reset': '重置',
			'action.resetting': '重置中…',
			'action.retry': '重试',

			'tag.unconfigured': '未配置',
			'tag.configured': '已配置',

			'status.unlimited': '无限重试',
			'status.retries': '最多 {n} 次',
			'status.fixed': '固定 {base} 秒',
			'status.increment': '{base} 秒起，每次 +{step} 秒',

			'notice.failed': '保存失败：{message}',
			'notice.conflict': '设置已被其他窗口修改，已刷新；请核对后重试。',
		}

		const en = {
			'card.title': 'Failure retry',
			'card.summaryNone': 'Not configured',
			'card.summaryCount': '{n} model(s) configured',
			'card.noModels': 'This provider has no saved models yet',
			'card.noModelsHint': 'Add and save a model under Models, then come back to set its retry policy.',
			'card.unsaved':
				'This provider is not saved to settings yet; save it once to configure retry policies for its models.',
			'card.removed': 'Removed models',
			'card.readOnly': 'Settings are read-only in this deployment.',
			'card.noNamespace': 'The retry settings namespace is unavailable (plugin not loaded); changes cannot be saved.',
			'card.loading': 'Reading settings…',
			'card.loadError': 'Reading settings failed.',

			'section.title': 'Model retry',
			'section.intro':
				'Set a failure-retry count and cooldown strategy per model. 0 means unlimited retries; the counter is per step.',
			'section.defaults': 'Global defaults',
			'section.defaultsHint':
				'A template for new models only; a configured model always uses its own entry.',
			'section.defaultsUnavailable':
				'The global defaults and the "unconfigured models" strategy live in the plugin configuration (cordis.patch.yml); this settings interface does not expose them yet. Each model can still override them individually.',
			'section.unconfigured': 'Unconfigured models',
			'section.unconfiguredHint':
				'What happens to models without their own policy: keep the built-in DSH retry behaviour, or do not retry.',
			'section.unconfiguredInherit': 'Inherit built-in retry',
			'section.unconfiguredOff': 'Do not retry',
			'section.providers': 'Per provider',
			'section.empty': 'No configurable models yet',
			'section.emptyHint': 'Models added under Settings → Models appear here.',
			'section.removed': 'Removed models',
			'section.removedHint':
				'These entries name models that provider no longer declares; they can be cleaned up.',
			'section.orphans': 'Entries for unknown providers',
			'section.orphansHint': 'These entries name providers that are no longer configured; they can be cleaned up.',
			'section.retryableCodes': 'Retried error codes',
			'section.footnote':
				'A cooldown cap of 0 means no cap; a server Retry-After wins over the local interval; edits save immediately.',
			'section.loading': 'Reading settings…',
			'section.loadError': 'Reading settings failed.',
			'section.readOnly': 'Settings are read-only in this deployment.',
			'section.noNamespace': 'The retry settings namespace is unavailable (plugin not loaded); changes cannot be saved.',

			'field.retries': 'Failure retries',
			'field.delayMode': 'Cooldown strategy',
			'field.delaySeconds': 'Base cooldown (s)',
			'field.incrementSeconds': 'Added each retry (s)',
			'field.maxDelaySeconds': 'Cooldown cap (s)',
			'field.advanced': 'Advanced',

			'hint.retries': '0 = unlimited retries',
			'hint.delayMode': 'Fixed: the same wait every time; incremental: each wait adds to the previous one.',
			'hint.delaySeconds': 'The wait in fixed mode, or the first wait in incremental mode.',
			'hint.incrementSeconds': 'Seconds added to the first wait on every further retry in incremental mode.',
			'hint.maxDelaySeconds': '0 means no cap.',

			'option.fixed': 'Fixed',
			'option.increment': 'Incremental',

			'error.count': 'Enter an integer of 0 or more.',
			'error.seconds': 'Enter a number of 0 or more.',

			'action.apply': 'Save',
			'action.applying': 'Saving…',
			'action.enable': 'Enable',
			'action.reset': 'Reset',
			'action.resetting': 'Resetting…',
			'action.retry': 'Retry',

			'tag.unconfigured': 'Not configured',
			'tag.configured': 'Configured',

			'status.unlimited': 'unlimited retries',
			'status.retries': 'up to {n}',
			'status.fixed': 'fixed {base}s',
			'status.increment': 'from {base}s, +{step}s each',

			'notice.failed': 'Save failed: {message}',
			'notice.conflict': 'These settings changed elsewhere; the view was refreshed. Check the values and retry.',
		}

		/* --------------------------------------------------------------- styles */

		const CSS = `
.mretry-section{max-width:760px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-family:inherit}
.mretry-title{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}
.mretry-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.mretry-card{box-sizing:border-box;border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);padding:12px 14px;display:flex;flex-direction:column;gap:0}
.mretry-summary{display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none;font:inherit;color:var(--dsw-alias-label-primary)}
.mretry-summary::-webkit-details-marker{display:none}
.mretry-summary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.mretry-cardTitle{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.mretry-cardMeta{margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.mretry-body{display:flex;flex-direction:column;gap:10px;margin-top:10px}
.mretry-group{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.mretry-groupHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mretry-groupTitle{margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.mretry-groupRoute{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);padding:1px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.mretry-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.mretry-warn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label)}
.mretry-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.mretry-row{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-md);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.mretry-rowStale{background:transparent;border-style:dashed}
.mretry-rowHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.mretry-rowName{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.mretry-rowKey{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.mretry-tag{margin-left:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);padding:1px 6px}
.mretry-tagOn{color:var(--dsw-alias-label-secondary)}
.mretry-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;align-items:start}
.mretry-field{display:flex;flex-direction:column;gap:4px;min-width:0;font:inherit}
.mretry-fieldLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.mretry-input{box-sizing:border-box;width:100%;height:32px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 8px}
.mretry-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px;border-color:var(--dsw-alias-border-l3)}
.mretry-input:disabled{color:var(--dsw-alias-label-tertiary);background:transparent;cursor:default}
.mretry-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}
.mretry-seg{display:inline-flex;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden;align-self:flex-start}
.mretry-segButton{box-sizing:border-box;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:30px;height:30px;padding:0 10px;cursor:pointer;white-space:nowrap}
.mretry-segButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mretry-segButton[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mretry-segButton:disabled{cursor:default;opacity:.6}
.mretry-segButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px}
.mretry-advanced{border:0;margin:0;padding:0}
.mretry-advancedSummary{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer;list-style:none;padding:2px 0}
.mretry-advancedSummary::-webkit-details-marker{display:none}
.mretry-advancedSummary::before{content:"\\25B8";font-size:10px;margin-right:4px}
.mretry-advanced[open]>.mretry-advancedSummary::before{content:"\\25BE"}
.mretry-advancedSummary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.mretry-advancedBody{padding-top:8px}
.mretry-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.mretry-btn{box-sizing:border-box;height:30px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 10px;cursor:pointer}
.mretry-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mretry-btn:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}
.mretry-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
.mretry-btnPrimary{box-sizing:border-box;height:30px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 12px;cursor:pointer}
.mretry-btnPrimary:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary)}
.mretry-btnPrimary:disabled{cursor:default;color:var(--dsw-alias-label-tertiary);opacity:.7}
.mretry-btnPrimary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
.mretry-removed{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px}
.mretry-removedSummary{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer;list-style:none;padding:2px 0}
.mretry-removedSummary::-webkit-details-marker{display:none}
.mretry-removedSummary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.mretry-removedBody{display:flex;flex-direction:column;gap:8px;padding-top:8px}
.mretry-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:space-between}
.mretry-codes{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-word}
`

		/** Inject the plugin stylesheet once; returns an effect disposer. */
		function installStyles() {
			if (typeof document === 'undefined' || document.head === null) return () => {}
			const existing = document.querySelector(`style[${STYLE_ATTR}="${PLUGIN_ID}"]`)
			if (existing !== null) return () => {}
			const tag = document.createElement('style')
			tag.setAttribute(STYLE_ATTR, PLUGIN_ID)
			tag.textContent = CSS
			document.head.appendChild(tag)
			return () => {
				if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
			}
		}

		/* -------------------------------------------------------------- helpers */

		function isRecord(value) {
			return value !== null && typeof value === 'object' && !Array.isArray(value)
		}

		function fill(template, values) {
			let text = typeof template === 'string' ? template : ''
			for (const key of Object.keys(values)) text = text.split(`{${key}}`).join(String(values[key]))
			return text
		}

		function formatNumber(value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return ''
			return String(value)
		}

		/** Integer >= 0, or NaN. Retries are whole counts. */
		function parseIntegerText(text) {
			const trimmed = String(text === undefined || text === null ? '' : text).trim()
			if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return NaN
			const value = Number(trimmed)
			return Number.isSafeInteger(value) && value >= 0 ? value : NaN
		}

		/** Finite number >= 0, or NaN. Cooldowns may be fractional seconds. */
		function parseSecondsText(text) {
			const trimmed = String(text === undefined || text === null ? '' : text).trim()
			if (trimmed.length === 0) return NaN
			const value = Number(trimmed)
			return Number.isFinite(value) && value >= 0 ? value : NaN
		}

		/** Normalize one Policy record read from the Host into display form. */
		function readPolicy(source) {
			if (!isRecord(source)) return null
			const retries = Number.isInteger(source.retries) && source.retries >= 0 ? source.retries : 0
			const delaySeconds =
				typeof source.delaySeconds === 'number' && Number.isFinite(source.delaySeconds) && source.delaySeconds >= 0
					? source.delaySeconds
					: 2
			const incrementSeconds =
				typeof source.incrementSeconds === 'number' &&
				Number.isFinite(source.incrementSeconds) &&
				source.incrementSeconds >= 0
					? source.incrementSeconds
					: 2
			const maxDelaySeconds =
				typeof source.maxDelaySeconds === 'number' &&
				Number.isFinite(source.maxDelaySeconds) &&
				source.maxDelaySeconds >= 0
					? source.maxDelaySeconds
					: 120
			const retryableCodes = Array.isArray(source.retryableCodes)
				? source.retryableCodes.filter((code) => typeof code === 'string' && code.length > 0)
				: []
			return {
				retries,
				delayMode: source.delayMode === 'increment' ? 'increment' : 'fixed',
				delaySeconds,
				incrementSeconds,
				maxDelaySeconds,
				retryableCodes,
			}
		}

		function messageOf(response) {
			if (isRecord(response) && isRecord(response.error) && typeof response.error.message === 'string') {
				return response.error.message
			}
			return 'request failed'
		}

		/** Provider groups (route + declared models) from the llm-pi-ai settings value. */
		function collectProviders(providerValue) {
			const providers = isRecord(providerValue.providers) ? providerValue.providers : {}
			const result = []
			for (const route of Object.keys(providers)) {
				const profile = isRecord(providers[route]) ? providers[route] : {}
				const rows = Array.isArray(profile.models) ? profile.models : []
				const models = []
				const seen = new Set()
				for (const row of rows) {
					if (!isRecord(row)) continue
					const id = typeof row.id === 'string' ? row.id.trim() : ''
					if (id.length === 0 || seen.has(id)) continue
					seen.add(id)
					const name = typeof row.name === 'string' && row.name.trim().length > 0 ? row.name.trim() : id
					models.push({ id, name, key: `${route}/${id}` })
				}
				const displayName =
					typeof profile.displayName === 'string' && profile.displayName.trim().length > 0
						? profile.displayName.trim()
						: route
				result.push({ route, displayName, models })
			}
			result.sort((left, right) => (left.route < right.route ? -1 : left.route > right.route ? 1 : 0))
			return result
		}

		function policySummaryText(t, policy) {
			if (policy === null) return t('tag.unconfigured')
			const count =
				policy.retries === 0
					? t('status.unlimited')
					: fill(t('status.retries'), { n: String(policy.retries) })
			const mode =
				policy.delayMode === 'increment'
					? fill(t('status.increment'), {
							base: formatNumber(policy.delaySeconds),
							step: formatNumber(policy.incrementSeconds),
						})
					: fill(t('status.fixed'), { base: formatNumber(policy.delaySeconds) })
			return `${count} · ${mode}`
		}

		/* -------------------------------------------------------------- runtime */

		let currentRuntime = null

		function createRuntime(ctx) {
			const mirror = ctx.configForms.describe()
			const t = ctx.locale.bind(LOCALE_NS)
			const state = { writing: Object.create(null), notice: null }

			const listeners = new Set()
			let cache = null

			function notify() {
				cache = null
				for (const listener of Array.from(listeners)) {
					try {
						listener()
					} catch (error) {
						/* one throwing subscriber must not stop the rest */
					}
				}
			}

			function subscribe(listener) {
				listeners.add(listener)
				return () => {
					listeners.delete(listener)
				}
			}

			function getSnapshot() {
				if (cache === null) cache = derive()
				return cache
			}

			function setWriting(token, active) {
				const next = Object.assign({}, state.writing)
				if (active) next[token] = true
				else delete next[token]
				state.writing = next
				notify()
			}

			function setNotice(notice) {
				state.notice = notice
				notify()
			}

			function namespaceOf(namespace) {
				const snapshot = mirror.getSnapshot()
				const view = isRecord(snapshot.view) ? snapshot.view : null
				const list = view !== null && Array.isArray(view.namespaces) ? view.namespaces : []
				for (const candidate of list) {
					if (isRecord(candidate) && candidate.ns === namespace) return candidate
				}
				return null
			}

			function revisionOf() {
				const view = namespaceOf(SETTINGS_NS)
				return view !== null && typeof view.revision === 'number' ? view.revision : undefined
			}

			function derive() {
				const snapshot = mirror.getSnapshot()
				const view = isRecord(snapshot.view) ? snapshot.view : null
				const namespaces = view !== null && Array.isArray(view.namespaces) ? view.namespaces : []
				let retryNamespace = null
				let providerNamespace = null
				for (const candidate of namespaces) {
					if (!isRecord(candidate)) continue
					if (candidate.ns === SETTINGS_NS) retryNamespace = candidate
					else if (candidate.ns === PROVIDER_NS) providerNamespace = candidate
				}
				const retryValue = retryNamespace !== null && isRecord(retryNamespace.value) ? retryNamespace.value : {}
				const providerValue =
					providerNamespace !== null && isRecord(providerNamespace.value) ? providerNamespace.value : {}
				const rawPolicies = isRecord(retryValue.models) ? retryValue.models : {}
				const defaultsVisible = Object.prototype.hasOwnProperty.call(retryValue, 'defaults')
				const unconfiguredVisible = Object.prototype.hasOwnProperty.call(retryValue, 'unconfigured')

				const providers = collectProviders(providerValue)
				const declaredKeys = new Set()
				const groups = providers.map((provider) => {
					const models = provider.models.map((model) => {
						declaredKeys.add(model.key)
						return {
							id: model.id,
							name: model.name,
							key: model.key,
							provider: provider.route,
							displayName: provider.displayName,
							policy: readPolicy(rawPolicies[model.key]),
						}
					})
					return {
						route: provider.route,
						displayName: provider.displayName,
						models,
						removed: [],
					}
				})
				const groupsByRoute = new Map(groups.map((group) => [group.route, group]))
				const orphan = []
				for (const key of Object.keys(rawPolicies)) {
					if (declaredKeys.has(key)) continue
					const entry = { key, policy: readPolicy(rawPolicies[key]) }
					const slash = key.indexOf('/')
					const route = slash > 0 ? key.slice(0, slash) : ''
					const group = groupsByRoute.get(route)
					if (group !== undefined) group.removed.push(entry)
					else orphan.push(entry)
				}

				const defaults = defaultsVisible ? readPolicy(retryValue.defaults) : null
				const unconfigured = typeof retryValue.unconfigured === 'string' ? retryValue.unconfigured : null

				return {
					status: typeof snapshot.status === 'string' ? snapshot.status : 'idle',
					error: typeof snapshot.error === 'string' ? snapshot.error : null,
					writable: view !== null && view.writable === true,
					served: retryNamespace !== null,
					revision: retryNamespace !== null && typeof retryNamespace.revision === 'number' ? retryNamespace.revision : undefined,
					groups,
					orphan,
					policies: rawPolicies,
					configuredCount: Object.keys(rawPolicies).length,
					defaults,
					unconfigured,
					defaultsVisible,
					unconfiguredVisible,
					writing: state.writing,
					notice: state.notice,
				}
			}

			/**
			 * One settings mutation with revision fencing. A stale revision is not an
			 * error the user must see: the describe mirror is refetched and the SAME
			 * ops are replayed once with the new revision. Any other refusal is a
			 * plain message. Resolves to whether the Host accepted the write.
			 */
			async function commit(ops, token) {
				if (!Array.isArray(ops) || ops.length === 0) return true
				setWriting(token, true)
				try {
					for (let attempt = 0; attempt < 2; attempt += 1) {
						let response
						try {
							response = await ctx.remote.settings.mutate(SETTINGS_NS, ops, revisionOf())
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error)
							setNotice({ kind: 'error', text: fill(t('notice.failed'), { message }) })
							return false
						}
						if (isRecord(response) && response.ok === true) {
							if (isRecord(response.value)) mirror.acceptView(response.value)
							setNotice(null)
							return true
						}
						const code = isRecord(response) && isRecord(response.error) ? response.error.code : undefined
						if (code === 'settings/conflict' && attempt === 0) {
							try {
								await mirror.load()
							} catch (error) {
								/* the retry below will report the refusal */
							}
							continue
						}
						if (code === 'settings/conflict') {
							setNotice({ kind: 'warn', text: t('notice.conflict') })
							return false
						}
						setNotice({ kind: 'error', text: fill(t('notice.failed'), { message: messageOf(response) }) })
						return false
					}
					setNotice({ kind: 'warn', text: t('notice.conflict') })
					return false
				} finally {
					setWriting(token, false)
				}
			}

			function reload() {
				try {
					const pending = mirror.load()
					if (pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {})
				} catch (error) {
					setNotice({ kind: 'error', text: t('section.loadError') })
				}
			}

			return { mirror, t, notify, subscribe, getSnapshot, commit, reload }
		}

		/* ---------------------------------------------------------------- hooks */

		const useSyncExternalStore =
			typeof React.useSyncExternalStore === 'function'
				? React.useSyncExternalStore
				: function fallback(subscribe, getSnapshot) {
						const [snapshot, setSnapshot] = React.useState(getSnapshot)
						React.useEffect(
							() =>
								subscribe(() => {
									setSnapshot(getSnapshot())
								}),
							[subscribe, getSnapshot],
						)
						return snapshot
					}

		function useRuntimeSnapshot(runtime) {
			return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
		}

		/* ----------------------------------------------------------- primitives */

		function TextField(props) {
			return h(
				'label',
				{ className: 'mretry-field' },
				h('span', { className: 'mretry-fieldLabel' }, props.label),
				h('input', {
					className: 'mretry-input',
					type: 'text',
					inputMode: props.inputMode === undefined ? 'decimal' : props.inputMode,
					value: props.value,
					placeholder: props.placeholder,
					'aria-label': props.ariaLabel === undefined ? props.label : props.ariaLabel,
					'aria-invalid': props.error !== '' && props.error !== undefined ? 'true' : undefined,
					disabled: props.disabled === true || props.readOnly === true,
					onChange: (event) => props.onChange(event.target.value),
				}),
				props.hint ? h('span', { className: 'mretry-hint' }, props.hint) : null,
				props.error ? h('p', { className: 'mretry-error' }, props.error) : null,
			)
		}

		function SegmentedField(props) {
			return h(
				'div',
				{ className: 'mretry-field' },
				h('span', { className: 'mretry-fieldLabel' }, props.label),
				h(
					'div',
					{ className: 'mretry-seg', role: 'group', 'aria-label': props.label },
					props.options.map((option) =>
						h(
							'button',
							{
								key: option.value,
								type: 'button',
								className: 'mretry-segButton',
								'data-active': option.value === props.value ? 'true' : 'false',
								'aria-pressed': option.value === props.value,
								disabled: props.disabled === true,
								onClick: () => props.onChange(option.value),
							},
							option.label,
						),
					),
				),
				props.hint ? h('span', { className: 'mretry-hint' }, props.hint) : null,
			)
		}

		function NoticeLine(props) {
			const notice = props.notice
			if (!isRecord(notice) || typeof notice.text !== 'string' || notice.text.length === 0) return null
			return h(
				'p',
				{ className: notice.kind === 'error' ? 'mretry-error' : 'mretry-warn', role: 'status' },
				notice.text,
			)
		}

		/* -------------------------------------------------------- policy editor */

		/**
		 * One model's retry policy row.
		 *
		 * Numbers are edited as TEXT (so `1.5` can be typed and cleared); a parse
		 * failure is a field-local error that disables this row's Apply. Nothing is
		 * written until Apply, then all changed fields land in ONE `settings.mutate`
		 * call so a half-saved policy cannot exist.
		 */
		function PolicyEditor(props) {
			const runtime = props.runtime
			const t = runtime.t
			const policy = props.policy
			const effective =
				policy !== null
					? policy
					: props.defaults !== null
						? props.defaults
						: readPolicy(POLICY_FALLBACK)

			const [buffers, setBuffers] = React.useState(() => ({}))
			const [mode, setMode] = React.useState(null)
			const currentMode = mode !== null ? mode : effective.delayMode
			const busyToken = `row:${props.modelKey}`
			const busy = props.writing[busyToken] === true
			const canWrite = props.writable === true && busy === false

			const textOf = (field) => {
				if (buffers[field] !== undefined) return buffers[field]
				return formatNumber(effective[field])
			}
			const editField = (field, text) => {
				setBuffers((current) => {
					const next = Object.assign({}, current)
					next[field] = text
					return next
				})
			}

			const retries = parseIntegerText(textOf('retries'))
			const delaySeconds = parseSecondsText(textOf('delaySeconds'))
			const incrementSeconds = parseSecondsText(textOf('incrementSeconds'))
			const maxDelaySeconds = parseSecondsText(textOf('maxDelaySeconds'))
			const errors = {
				retries: Number.isNaN(retries) ? t('error.count') : '',
				delaySeconds: Number.isNaN(delaySeconds) ? t('error.seconds') : '',
				maxDelaySeconds: Number.isNaN(maxDelaySeconds) ? t('error.seconds') : '',
				incrementSeconds:
					currentMode === 'increment' && Number.isNaN(incrementSeconds) ? t('error.seconds') : '',
			}
			const invalid =
				errors.retries !== '' ||
				errors.delaySeconds !== '' ||
				errors.maxDelaySeconds !== '' ||
				errors.incrementSeconds !== ''

			const resolved = {
				retries: Number.isNaN(retries) ? effective.retries : retries,
				delayMode: currentMode,
				delaySeconds: Number.isNaN(delaySeconds) ? effective.delaySeconds : delaySeconds,
				incrementSeconds: Number.isNaN(incrementSeconds) ? effective.incrementSeconds : incrementSeconds,
				maxDelaySeconds: Number.isNaN(maxDelaySeconds) ? effective.maxDelaySeconds : maxDelaySeconds,
			}

			/** Field values whose stored counterpart differs; `null` means "create the entry". */
			const changed = (() => {
				if (policy === null) return null
				const list = []
				if (resolved.retries !== policy.retries) list.push(['retries', resolved.retries])
				if (resolved.delaySeconds !== policy.delaySeconds) list.push(['delaySeconds', resolved.delaySeconds])
				if (resolved.maxDelaySeconds !== policy.maxDelaySeconds)
					list.push(['maxDelaySeconds', resolved.maxDelaySeconds])
				if (currentMode === 'increment' && resolved.incrementSeconds !== policy.incrementSeconds)
					list.push(['incrementSeconds', resolved.incrementSeconds])
				if (currentMode !== policy.delayMode) list.push(['delayMode', currentMode])
				return list
			})()

			const dirty = changed === null || changed.length > 0
			const applyDisabled = canWrite === false || invalid || dirty === false

			const apply = () => {
				if (applyDisabled) return
				const ops =
					changed === null
						? [
								{
									op: 'set',
									path: ['models', props.modelKey],
									value: {
										retries: resolved.retries,
										delayMode: resolved.delayMode,
										delaySeconds: resolved.delaySeconds,
										incrementSeconds: resolved.incrementSeconds,
										maxDelaySeconds: resolved.maxDelaySeconds,
									},
								},
							]
						: changed.map(([field, value]) => ({
								op: 'set',
								path: ['models', props.modelKey, field],
								value,
							}))
				runtime.commit(ops, busyToken).then((ok) => {
					if (!ok) return
					setBuffers({})
					setMode(null)
				})
			}

			const reset = () => {
				if (canWrite === false || policy === null) return
				runtime.commit([{ op: 'unset', path: ['models', props.modelKey] }], busyToken).then((ok) => {
					if (!ok) return
					setBuffers({})
					setMode(null)
				})
			}

			const tag = policy === null ? t('tag.unconfigured') : t('tag.configured')

			return h(
				'div',
				{ className: 'mretry-row' },
				h(
					'div',
					{ className: 'mretry-rowHead' },
					h('span', { className: 'mretry-rowName' }, props.modelName),
					h('span', { className: 'mretry-rowKey' }, props.modelKey),
					h('span', { className: policy === null ? 'mretry-tag' : 'mretry-tag mretry-tagOn' }, tag),
				),
				h(
					'div',
					{ className: 'mretry-grid' },
					h(TextField, {
						label: t('field.retries'),
						hint: t('hint.retries'),
						inputMode: 'numeric',
						value: textOf('retries'),
						error: errors.retries,
						disabled: canWrite === false,
						onChange: (text) => editField('retries', text),
						ariaLabel: `${t('field.retries')} ${props.modelName}`,
					}),
					h(SegmentedField, {
						label: t('field.delayMode'),
						hint: t('hint.delayMode'),
						value: currentMode,
						options: [
							{ value: 'fixed', label: t('option.fixed') },
							{ value: 'increment', label: t('option.increment') },
						],
						disabled: canWrite === false,
						onChange: (next) => setMode(next),
					}),
					h(TextField, {
						label: t('field.delaySeconds'),
						hint: t('hint.delaySeconds'),
						value: textOf('delaySeconds'),
						error: errors.delaySeconds,
						disabled: canWrite === false,
						onChange: (text) => editField('delaySeconds', text),
						ariaLabel: `${t('field.delaySeconds')} ${props.modelName}`,
					}),
					currentMode === 'increment'
						? h(TextField, {
								label: t('field.incrementSeconds'),
								hint: t('hint.incrementSeconds'),
								value: textOf('incrementSeconds'),
								error: errors.incrementSeconds,
								disabled: canWrite === false,
								onChange: (text) => editField('incrementSeconds', text),
								ariaLabel: `${t('field.incrementSeconds')} ${props.modelName}`,
							})
						: null,
				),
				h(
					'details',
					{ className: 'mretry-advanced' },
					h('summary', { className: 'mretry-advancedSummary' }, t('field.advanced')),
					h(
						'div',
						{ className: 'mretry-advancedBody' },
						h(
							'div',
							{ className: 'mretry-grid' },
							h(TextField, {
								label: t('field.maxDelaySeconds'),
								hint: t('hint.maxDelaySeconds'),
								value: textOf('maxDelaySeconds'),
								error: errors.maxDelaySeconds,
								disabled: canWrite === false,
								onChange: (text) => editField('maxDelaySeconds', text),
								ariaLabel: `${t('field.maxDelaySeconds')} ${props.modelName}`,
							}),
						),
					),
				),
				h(
					'div',
					{ className: 'mretry-actions' },
					policy === null
						? null
						: h(
								'button',
								{
									type: 'button',
									className: 'mretry-btn',
									disabled: canWrite === false,
									onClick: reset,
								},
								busy ? t('action.resetting') : t('action.reset'),
							),
					h(
						'button',
						{
							type: 'button',
							className: 'mretry-btnPrimary',
							disabled: applyDisabled,
							onClick: apply,
						},
						busy ? t('action.applying') : policy === null ? t('action.enable') : t('action.apply'),
					),
				),
			)
		}

		/* -------------------------------------------------------- stale entries */

		function RemovedGroup(props) {
			const runtime = props.runtime
			const t = runtime.t
			const entries = props.entries
			if (!Array.isArray(entries) || entries.length === 0) return null
			return h(
				'details',
				{ className: 'mretry-removed' },
				h('summary', { className: 'mretry-removedSummary' }, `${props.title} (${entries.length})`),
				h('p', { className: 'mretry-hint' }, props.hint),
				h(
					'div',
					{ className: 'mretry-removedBody' },
					entries.map((entry) => {
						const token = `stale:${entry.key}`
						const busy = props.writing[token] === true
						const canWrite = props.writable === true && busy === false
						return h(
							'div',
							{ key: entry.key, className: 'mretry-row mretry-rowStale' },
							h(
								'div',
								{ className: 'mretry-rowHead' },
								h('span', { className: 'mretry-rowKey' }, entry.key),
								h('span', { className: 'mretry-tag' }, policySummaryText(t, entry.policy)),
							),
							h(
								'div',
								{ className: 'mretry-actions' },
								h(
									'button',
									{
										type: 'button',
										className: 'mretry-btn',
										disabled: canWrite === false,
										onClick: () => {
											runtime.commit([{ op: 'unset', path: ['models', entry.key] }], token)
										},
									},
									busy ? t('action.resetting') : t('action.reset'),
								),
							),
						)
					}),
				),
			)
		}

		/* -------------------------------------------------- provider card seat */

		function providerSummary(snapshot, group, t) {
			if (group === null) return t('card.summaryNone')
			let count = group.removed.length
			for (const model of group.models) if (model.policy !== null) count += 1
			if (count === 0) return t('card.summaryNone')
			return fill(t('card.summaryCount'), { n: String(count) })
		}

		function ProviderCardSeat(props) {
			const runtime = currentRuntime
			if (runtime === null) return null
			/* The guard sits in a hook-free wrapper so the inner component always
			   calls the same hooks regardless of the runtime's availability. */
			return h(ProviderCardSeatInner, Object.assign({}, props, { runtime }))
		}

		function ProviderCardSeatInner(props) {
			const runtime = props.runtime
			const snapshot = useRuntimeSnapshot(runtime)
			const t = runtime.t
			const owner = isRecord(props) && isRecord(props.provider) ? props.provider : null
			const route = owner !== null && typeof owner.provider === 'string' ? owner.provider : ''
			if (route.length === 0) return null
			/* `configured` is the slot owner's own prop beside `provider`, not a
			   field of the directory entry (Models page passes both explicitly). */
			const configured = props.configured === true
			const group = snapshot.groups.find((candidate) => candidate.route === route) || null
			/*
			 * Writes are disabled until the provider has one saved directory row: the
			 * add-provider draft card has no saved profile yet, so its model list is
			 * local React state and the retry policy can only be set after the first
			 * save (the card explains exactly that).
			 */
			const canWrite = snapshot.writable === true && snapshot.served === true && configured === true
			const body = []
			if (snapshot.status === 'idle' || snapshot.status === 'loading') {
				body.push(h('p', { key: 'loading', className: 'mretry-hint' }, t('card.loading')))
			}
			if (snapshot.error !== null) {
				body.push(
					h(
						'div',
						{ key: 'error', className: 'mretry-inline' },
						h('p', { className: 'mretry-error' }, t('card.loadError')),
						h(
							'button',
							{
								type: 'button',
								className: 'mretry-btn',
								onClick: () => runtime.reload(),
							},
							t('action.retry'),
						),
					),
				)
			}
			if (snapshot.writable !== true) body.push(h('p', { key: 'ro', className: 'mretry-warn' }, t('card.readOnly')))
			if (snapshot.served !== true)
				body.push(h('p', { key: 'ns', className: 'mretry-warn' }, t('card.noNamespace')))
			if (!configured || group === null)
				body.push(h('p', { key: 'draft', className: 'mretry-hint' }, t('card.unsaved')))
			if (group !== null && group.models.length === 0) {
				body.push(h('p', { key: 'empty', className: 'mretry-hint' }, t('card.noModels')))
				body.push(h('p', { key: 'emptyHint', className: 'mretry-hint' }, t('card.noModelsHint')))
			}
			if (group !== null) {
				for (const model of group.models) {
					body.push(
						h(PolicyEditor, {
							key: model.key,
							runtime,
							modelKey: model.key,
							modelName: model.name,
							policy: model.policy,
							defaults: snapshot.defaults,
							writable: canWrite,
							writing: snapshot.writing,
						}),
					)
				}
				body.push(
					h(RemovedGroup, {
						key: 'removed',
						runtime,
						entries: group.removed,
						title: t('card.removed'),
						hint: t('section.removedHint'),
						writable: canWrite,
						writing: snapshot.writing,
					}),
				)
			}
			body.push(h(NoticeLine, { key: 'notice', notice: snapshot.notice }))

			return h(
				'details',
				{ className: 'mretry-card' },
				h(
					'summary',
					{ className: 'mretry-summary' },
					h('span', { className: 'mretry-cardTitle' }, t('card.title')),
					h('span', { className: 'mretry-cardMeta' }, providerSummary(snapshot, group, t)),
				),
				h('div', { className: 'mretry-body' }, ...body),
			)
		}

		/* ------------------------------------------------------- defaults card */

		function DefaultsCard(props) {
			const runtime = props.runtime
			const t = runtime.t
			const snapshot = props.snapshot
			/*
			 * Hooks run before ANY visibility branch: the namespace arrives after the
			 * first describe, so a conditional hook would break the render order when
			 * `defaults`/`unconfigured` appear in the second snapshot.
			 */
			const effective = snapshot.defaults !== null ? snapshot.defaults : readPolicy(POLICY_FALLBACK)
			const [buffers, setBuffers] = React.useState(() => ({}))
			const [mode, setMode] = React.useState(null)
			const currentMode = mode !== null ? mode : effective.delayMode
			const token = 'defaults'
			const busy = snapshot.writing[token] === true
			const canWrite = snapshot.writable === true && busy === false
			const textOf = (field) => (buffers[field] !== undefined ? buffers[field] : formatNumber(effective[field]))
			const editField = (field, text) => {
				setBuffers((current) => {
					const next = Object.assign({}, current)
					next[field] = text
					return next
				})
			}
			const retries = parseIntegerText(textOf('retries'))
			const delaySeconds = parseSecondsText(textOf('delaySeconds'))
			const incrementSeconds = parseSecondsText(textOf('incrementSeconds'))
			const maxDelaySeconds = parseSecondsText(textOf('maxDelaySeconds'))
			const errors = {
				retries: Number.isNaN(retries) ? t('error.count') : '',
				delaySeconds: Number.isNaN(delaySeconds) ? t('error.seconds') : '',
				maxDelaySeconds: Number.isNaN(maxDelaySeconds) ? t('error.seconds') : '',
				incrementSeconds:
					currentMode === 'increment' && Number.isNaN(incrementSeconds) ? t('error.seconds') : '',
			}
			const invalid =
				errors.retries !== '' ||
				errors.delaySeconds !== '' ||
				errors.maxDelaySeconds !== '' ||
				errors.incrementSeconds !== ''
			const resolved = {
				retries: Number.isNaN(retries) ? effective.retries : retries,
				delayMode: currentMode,
				delaySeconds: Number.isNaN(delaySeconds) ? effective.delaySeconds : delaySeconds,
				incrementSeconds: Number.isNaN(incrementSeconds) ? effective.incrementSeconds : incrementSeconds,
				maxDelaySeconds: Number.isNaN(maxDelaySeconds) ? effective.maxDelaySeconds : maxDelaySeconds,
			}
			const changed = []
			if (resolved.retries !== effective.retries) changed.push(['retries', resolved.retries])
			if (resolved.delaySeconds !== effective.delaySeconds) changed.push(['delaySeconds', resolved.delaySeconds])
			if (resolved.maxDelaySeconds !== effective.maxDelaySeconds)
				changed.push(['maxDelaySeconds', resolved.maxDelaySeconds])
			if (currentMode === 'increment' && resolved.incrementSeconds !== effective.incrementSeconds)
				changed.push(['incrementSeconds', resolved.incrementSeconds])
			if (currentMode !== effective.delayMode) changed.push(['delayMode', currentMode])
			const applyDisabled = canWrite === false || invalid || changed.length === 0
			const apply = () => {
				if (applyDisabled) return
				const ops = changed.map(([field, value]) => ({ op: 'set', path: ['defaults', field], value }))
				runtime.commit(ops, token).then((ok) => {
					if (!ok) return
					setBuffers({})
					setMode(null)
				})
			}

			/*
			 * Defensive fallback only: the shipped host Config marks `defaults` and
			 * `unconfigured` volatile, so the branch above never fires for it. Older
			 * hosts that expose only `models` get an explainer instead of a form whose
			 * writes the Host would reject as "not volatile".
			 */
			if (snapshot.defaultsVisible === false && snapshot.unconfiguredVisible === false) {
				return h(
					'section',
					{ className: 'mretry-group' },
					h(
						'div',
						{ className: 'mretry-groupHead' },
						h('h3', { className: 'mretry-groupTitle' }, t('section.defaults')),
					),
					h('p', { className: 'mretry-hint' }, t('section.defaultsUnavailable')),
				)
			}

			const unconfiguredValue = snapshot.unconfigured === 'off' ? 'off' : 'inherit'
			return h(
				'section',
				{ className: 'mretry-group' },
				h(
					'div',
					{ className: 'mretry-groupHead' },
					h('h3', { className: 'mretry-groupTitle' }, t('section.defaults')),
					h('span', { className: 'mretry-hint' }, t('section.defaultsHint')),
				),
				snapshot.unconfiguredVisible
					? h(
							'div',
							{ className: 'mretry-grid' },
							h(SegmentedField, {
								label: t('section.unconfigured'),
								hint: t('section.unconfiguredHint'),
								value: unconfiguredValue,
								options: [
									{ value: 'inherit', label: t('section.unconfiguredInherit') },
									{ value: 'off', label: t('section.unconfiguredOff') },
								],
								disabled: canWrite === false,
								onChange: (next) => {
									if (next === unconfiguredValue) return
									runtime.commit([{ op: 'set', path: ['unconfigured'], value: next }], 'unconfigured')
								},
							}),
						)
					: null,
				snapshot.defaultsVisible
					? h(
							'div',
							null,
							h(
								'div',
								{ className: 'mretry-grid' },
								h(TextField, {
									label: t('field.retries'),
									hint: t('hint.retries'),
									inputMode: 'numeric',
									value: textOf('retries'),
									error: errors.retries,
									disabled: canWrite === false,
									onChange: (text) => editField('retries', text),
									ariaLabel: t('field.retries'),
								}),
								h(SegmentedField, {
									label: t('field.delayMode'),
									hint: t('hint.delayMode'),
									value: currentMode,
									options: [
										{ value: 'fixed', label: t('option.fixed') },
										{ value: 'increment', label: t('option.increment') },
									],
									disabled: canWrite === false,
									onChange: (next) => setMode(next),
								}),
								h(TextField, {
									label: t('field.delaySeconds'),
									hint: t('hint.delaySeconds'),
									value: textOf('delaySeconds'),
									error: errors.delaySeconds,
									disabled: canWrite === false,
									onChange: (text) => editField('delaySeconds', text),
									ariaLabel: t('field.delaySeconds'),
								}),
								currentMode === 'increment'
									? h(TextField, {
											label: t('field.incrementSeconds'),
											hint: t('hint.incrementSeconds'),
											value: textOf('incrementSeconds'),
											error: errors.incrementSeconds,
											disabled: canWrite === false,
											onChange: (text) => editField('incrementSeconds', text),
											ariaLabel: t('field.incrementSeconds'),
										})
									: null,
								h(TextField, {
									label: t('field.maxDelaySeconds'),
									hint: t('hint.maxDelaySeconds'),
									value: textOf('maxDelaySeconds'),
									error: errors.maxDelaySeconds,
									disabled: canWrite === false,
									onChange: (text) => editField('maxDelaySeconds', text),
									ariaLabel: t('field.maxDelaySeconds'),
								}),
							),
							h(
								'div',
								{ className: 'mretry-actions' },
								h(
									'button',
									{
										type: 'button',
										className: 'mretry-btnPrimary',
										disabled: applyDisabled,
										onClick: apply,
									},
									busy ? t('action.applying') : t('action.apply'),
								),
							),
							h(
								'p',
								{ className: 'mretry-codes' },
								`${t('section.retryableCodes')}: ${effective.retryableCodes.join(', ')}`,
							),
						)
					: h('p', { className: 'mretry-hint' }, t('section.defaultsUnavailable')),
			)
		}

		/* --------------------------------------------------------- section page */

		function ModelRetrySection(props) {
			const runtime = currentRuntime
			if (runtime === null) return null
			return h(ModelRetrySectionInner, { runtime })
		}

		function ModelRetrySectionInner(props) {
			const runtime = props.runtime
			const snapshot = useRuntimeSnapshot(runtime)
			const t = runtime.t
			const canWrite = snapshot.writable === true && snapshot.served === true
			const rows = []

			rows.push(h('h2', { key: 'title', className: 'mretry-title' }, t('section.title')))
			rows.push(h('p', { key: 'intro', className: 'mretry-intro' }, t('section.intro')))
			if (snapshot.status !== 'ready') {
				rows.push(h('p', { key: 'loading', className: 'mretry-hint' }, t('section.loading')))
			}
			if (snapshot.error !== null) {
				rows.push(
					h(
						'div',
						{ key: 'error', className: 'mretry-inline' },
						h('p', { className: 'mretry-error' }, t('section.loadError')),
						h('button', { type: 'button', className: 'mretry-btn', onClick: () => runtime.reload() }, t('action.retry')),
					),
				)
			}
			if (snapshot.writable !== true) rows.push(h('p', { key: 'ro', className: 'mretry-warn' }, t('section.readOnly')))
			if (snapshot.served !== true) rows.push(h('p', { key: 'ns', className: 'mretry-warn' }, t('section.noNamespace')))
			if (snapshot.notice !== null) rows.push(h(NoticeLine, { key: 'notice', notice: snapshot.notice }))

			rows.push(h(DefaultsCard, { key: 'defaults', runtime, snapshot }))

			rows.push(h('h3', { key: 'providersTitle', className: 'mretry-title' }, t('section.providers')))
			if (snapshot.groups.length === 0) {
				rows.push(
					h(
						'section',
						{ key: 'empty', className: 'mretry-group' },
						h('p', { className: 'mretry-hint' }, t('section.empty')),
						h('p', { className: 'mretry-hint' }, t('section.emptyHint')),
					),
				)
			}
			for (const group of snapshot.groups) {
				const groupRows = []
				if (group.models.length === 0) {
					groupRows.push(h('p', { key: 'empty', className: 'mretry-hint' }, t('card.noModels')))
					groupRows.push(h('p', { key: 'emptyHint', className: 'mretry-hint' }, t('card.noModelsHint')))
				}
				for (const model of group.models) {
					groupRows.push(
						h(PolicyEditor, {
							key: model.key,
							runtime,
							modelKey: model.key,
							modelName: model.name,
							policy: model.policy,
							defaults: snapshot.defaults,
							writable: canWrite,
							writing: snapshot.writing,
						}),
					)
				}
				groupRows.push(
					h(RemovedGroup, {
						key: 'removed',
						runtime,
						entries: group.removed,
						title: t('section.removed'),
						hint: t('section.removedHint'),
						writable: canWrite,
						writing: snapshot.writing,
					}),
				)
				rows.push(
					h(
						'section',
						{ key: `group:${group.route}`, className: 'mretry-group' },
						h(
							'div',
							{ className: 'mretry-groupHead' },
							h('h3', { className: 'mretry-groupTitle' }, group.displayName),
							group.displayName === group.route
								? null
								: h('span', { className: 'mretry-groupRoute' }, group.route),
						),
						...groupRows,
					),
				)
			}

			rows.push(
				h(RemovedGroup, {
					key: 'orphans',
					runtime,
					entries: snapshot.orphan,
					title: t('section.orphans'),
					hint: t('section.orphansHint'),
					writable: canWrite,
					writing: snapshot.writing,
				}),
			)
			rows.push(h('p', { key: 'footnote', className: 'mretry-hint' }, t('section.footnote')))

			return h('div', { className: 'mretry-section' }, ...rows)
		}

		/* ------------------------------------------------------------- plugin */

		const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.settings']

		function apply(ctx) {
			const runtime = createRuntime(ctx)
			currentRuntime = runtime

			ctx.effect(() => installStyles(), 'model-retry: stylesheet')
			ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'model-retry: dictionaries')

			ctx.effect(() => {
				const disposeMirror = runtime.mirror.subscribe(runtime.notify)
				const disposeLocale =
					typeof ctx.locale.subscribe === 'function'
						? ctx.locale.subscribe(runtime.notify)
						: () => {}
				runtime.mirror.ensure()
				return () => {
					disposeMirror()
					disposeLocale()
				}
			}, 'model-retry: settings mirror')

			ctx.effect(
				() =>
					ctx.slots.inject('settings.models.provider-card', () =>
						ctx.slots.register(
							{
								name: 'settings.models.provider-card',
								key: PROVIDER_NS,
							},
							ProviderCardSeat,
						),
					),
				'model-retry: provider-card seat',
			)

			ctx.effect(
				() =>
					ctx.slots.inject('settings.section', () =>
						ctx.slots.register(
							{
								name: 'settings.section',
								id: SECTION_ID,
								order: SECTION_ORDER,
								label: () => runtime.t('section.title'),
							},
							ModelRetrySection,
						),
					),
				'model-retry: settings page',
			)
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
