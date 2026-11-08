# Client / Web-UI half — where "add model" lives, the slot map, and how a plugin injects a per-model retry control

Task: client-model-ui-analyst / shared task-2. Read-only research; evidence = source read directly out of the shipped bundles.

Evidence base and method
- Implementations live inside the Electron asar. Shell/glob/grep cannot traverse it; every file below was read with the `read` tool at an explicit path.
- `<asar>` = `%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh`.
- Live client inspect (`cordis_inspect_query` platform=client, providers `Slots`/`Service`/`Theme`/`Builtin`) **timed out on every call** (10 s, 4 attempts spread over the session, incl. `listSubTree{root:"settings.section"}`). The page is presumably not answering the client-inspect bridge. Everything below therefore comes from the shipped client bundles; where a live-only fact would be needed it is flagged as inference.
- Files read in full or in ranges: `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js` (4527 lines), `.../lib/index.js`, `.../package.json`, `.../locale/en.json`; `@deepseek-ai/dsh-client-ui-settings/lib/client.js`; `@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`; `@deepseek-ai/dsh-client-ui-settings-shell/lib/client.js`; `@deepseek-ai/dsh-client-ui-settings-agent-loop/lib/client.js`; `@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js`; `@deepseek-ai/dsh-client-modules/lib/index.js` + `lib/client.js`; `@deepseek-ai/dsh-api-settings-controller/lib/index.js`; `@deepseek-ai/dsh-settings/lib/index.js`; `@deepseek-ai/dsh-llm-retry/lib/index.js`; `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` (head + tail); `@deepseek-ai/dsh-web-frontend/dist/index.html`; `@deepseek-ai/dsh/package.json`; profile files `%DSH_HOME%\profiles\desktop\{package.json,cordis.yml,cordis.patch.yml}`; third-party `dsh-reasoning-effort/{package.json,cordis.patch.yml,lib/client.js}`; `dsh-plugin-wallpaper-engine/{package.json,lib/client.js,lib/index.js}`.
- `lib/types/**/*.d.ts` is **not** shipped in the asar (read attempts returned "not found"), so contracts are reconstructed from runtime code and call sites.

---

## 1. The real "add model" flow (Q1)

There is **no model dialog**. Providers are cards on the Models settings page; models are **inline rows inside a provider card**, and adding a model is appending one `{ id: "" }` row to the provider profile's `models` array. Everything is persisted in one `settings.mutate` when the card's Apply button is pressed.

### 1.1 The page and its entry in Settings
`@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:4485-4501`

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "models",
  order: 10,
  label: () => t("nav"),
  inject: injected,
  children: {
    "settings.models.provider-card": { kind: "keyed", scope: "root" },
    "settings.models.footer": { kind: "list", scope: "root" }
  }
}, ModelsSection));
```

The Settings shell declares `settings.section` itself as a **list** child of `sidebar.settings` (`dsh-client-ui-settings-general/lib/client.js:1233-1268`):

```js
const disposeSlot = ctx.slots.register({
  name: "sidebar.settings",
  locale: NS,
  store: shellStore,
  children: {
    "settings.launcher":  { kind: "single", scope: "root" },
    "settings.trigger":   { kind: "single", scope: "root" },
    "settings.header":    { kind: "single", scope: "root" },
    "settings.action":    { kind: "list",   scope: "root" },
    "settings.close":     { kind: "single", scope: "root" },
    "settings.section":   { kind: "list",   scope: "root" },
    "settings.onboarding":{ kind: "list",   scope: "root" }
  },
  inject: shellInjected
}, SettingsRoot);
```

### 1.2 Add-provider card = one button + two modes
`client.js:2637-2774`. Clicking `Add model provider` (`add`, line 2772) opens an inline card (not a modal) with a `SegmentedControl` when both modes are offered (`addCatalog` = "Third-party model provider", `addCustom` = "Custom model API"); tabs hold `role=tabpanel` panels and both panels stay mounted once visited (`mounted()`/`visited`, 2359, 2476).

Catalog panel (`2706-2730`): a `<select>` of dormant directory providers + `ProviderEditor` (API-key card; models under its 自定义设置 disclosure).
Custom panel (`2732-2754`): `CustomProviderCard` — one form, fields in this order (`1558-1781`):

| field | control | locale key |
|---|---|---|
| route id | text, placeholder `acme-gateway`, must match `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/` (`ROUTE_PATTERN`, 1544) | `customRoute` |
| display name | text | `customDisplayName` |
| base URL | text, must be http(s) (`isHttpUrl`, 1545) | `baseUrl` |
| protocol | `<select>` from the namespace schema union (`protocolChoices`, 1242-1251) | `customApi` |
| API key | write-only `ApiKeyInput` (verified+eye reveal, 159-196) | `keyInput` |
| models | `ModelListEditor` | `models` |

Create writes the whole profile + key (`1596-1619`):

```js
const profile = {
  ...displayName.length === 0 ? {} : { displayName },
  ...storesKey ? { apiKeyEnv: keyRef } : {},
  api: protocol,
  baseURL: normalizedBaseURL,
  models: models.map((model) => ({ ...model }))
};
const written = await operations.writeSettings(NS$1, [{
  op: "set", path: ["providers", route], value: profile
}], openedAt);
...
const stored = await operations.storeCredential(keyRef, keyValue);
```
with `const NS$1 = "llm-pi-ai"` (1535).

### 1.3 Model list inside any pi-ai provider card
`ModelListEditor` (`876-1174`) — header has `fetchModels` link (`1045`, opens the only model-selection **Modal**, a candidate checklist `fetchTitle`/`fetchSearch`/`fetchAdopt`, 1113-1171), then rows, then the add button:

```js
// client.js:1100-1108
jsx(button, { className: addModelButton, disabled,
  onClick: () => { onChange([...models, { id: "" }]); } },
  [IconPlusOutlineRegular, t("addModel")])
```
(identical for the DeepSeek catalog editor at `797-805`.)

One row = `ModelRow` (`486-567`):
- always visible: `id` text, `name` text (placeholder = locale `modelId`/`modelName`), `advanced` toggle (chevrons), `removeModel` trash.
- advanced body (`525-564`): `contextWindow` and `maxTokens` text inputs with `inputMode="numeric"` and K/M capacity parsing; `ModelInputTypes` checkboxes (`text`/`image`); `ModelReasoningEfforts` (switch + one row per level: level `<select>` + wire-value text + remove, plus `modelReasoningAdd`).

### 1.4 Persistence and validation inside the card
- Draft state: provider card holds a `draft` object; models are `draft.models` (`1994-2044`): `modelsOverridden = schema.hasPath(draft, ["models"])`; empty list means "inherit the route's built-in catalog" (doc at `810-825`); reset deletes the override (`onReset` → `schema.deletePath(current, ["models"])`, `2041-2043`).
- Apply → **path ops against the stored section**, never a rebuild (`1822-1841`, `1923-1954`):

```js
const ops = props.credentialOnly === true ? [] : materializesNativeProfile ? [{ op:"set", path:[...settingsPath], value:{} }]
  : pathOps(settingsPath, committedOriginal, next);
if (ops.length > 0) {
  const written = await operations.writeSettings(ns, ops, expectedRevision);
  if (written.kind !== "written") return written.kind === "conflict" ? t("conflict") : written.message;
  setCommittedOriginal(schema.getPath(written.view.user, settingsPath));
  setExpectedRevision(written.view.revision);
```
`pathOps` emits `set`/`unset` per changed key with `JSON.stringify` equality (`1822-1838`).

- Client-side validation example (this is the concrete numeric-field pattern asked for in Q8, `client.js:581-660`, `1586-1600`, `2188-2196`):

```js
const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
function parseCapacity(text) {           // "" → undefined (inherit), unreadable → NaN
  const trimmed = text.trim();
  if (trimmed.length === 0) return void 0;
  const match = CAPACITY_PATTERN.exec(trimmed);
  if (match === null) return NaN;
  ...
}
function validateDeepSeekModels(value) { // first invalid row + locale key
  ...
  const contextWindow = model["contextWindow"];
  if (contextWindow !== void 0 && (typeof contextWindow !== "number"
      || !Number.isInteger(contextWindow) || contextWindow <= 0))
    return { index, key: "modelContextInvalid" };
```
```js
const modelFailure = validateModels(schema.getPath(draft, ["models"]));
const ready = route.length > 0 && !routeInvalid && !routeTaken && ... && modelFailure === void 0 && keyFailure === void 0;
const hint = ... : modelFailure !== void 0 ? `${t("model")} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}` : t("customNeedsModels");
```
Errors are `<p className={css.error}>` directly under the field (`1654-1660`, `1696-1699`, `1736-1740`); the same failure both disables submit (`EditorFooter submitDisabled`, `1766-1778`) and is repeated as a hint above the footer (`1762-1765`). Typed numbers are held as **text** in an `editing` Map keyed `${rowIndex}:${field}` so `256K` can be typed; the stored value is always the parsed integer (`713-741`, `913-918`).

### 1.5 The dialog inventory (so nobody looks for a model dialog)
Only two `Modal`s exist in the whole models package: the **fetch-model picker** (`1113-1171`) and the **delete-provider confirm** (`2777-2801`). Add-provider and every model edit are inline cards/rows.

---

## 2. Slot map of the Models settings page (Q2)

### 2.1 Slots this package *registers* into / *declares*
| slot id | kind / scope | registered by | occupant props (from call sites) |
|---|---|---|---|
| `settings.section` (entry `id:"models"`, order 10) | list child of `sidebar.settings` | settings-models `4485-4501` | `inject()` result spread (`controller`, `operations`, `schema`, `t`) + `hooks:{snapshot}` → `useSnapshot` + `renderSlot` (`2324-2336`) |
| `settings.models.provider-card` | keyed (`entryKey`), scope root | child of the models section | `{ provider: row.entry, configured, keyConfigured }` (`2541-2545`, `2616-2620`, `2725-2729`) |
| `settings.models.footer` | list, scope root | child of the models section | `{}` (`2776`) |
| `settings.models.sign-in` | single, scope root, supports `fallback` | child of onboarding step `deepseek-official` (`4508-4517`) | `{ complete, useApiKey }` + fallback (`2968-2973`) |
| `settings.onboarding` (steps `welcome-notice` order -100, `deepseek-official` order 0) | list child of `sidebar.settings` | settings-models `4502-4517` | injected props + `complete` + `renderSlot` (`2894-2895`) |

Key point: **`settings.models.provider-card` is rendered at provider-card granularity in three places** — the setup card, the expanded row, and the add-catalog panel — i.e. it sits *above* the editor and *outside* the model rows. **No slot exists inside a model row, the model list, or the custom-provider form.** Therefore there is no stock extension point "inside the add-model form".

### 2.2 Probe pattern (used by every list consumer)
```js
// settings-general/lib/client.js:1140-1162
sections: {
  getSnapshot: () => {
    const version = ctx.slots.getVersion("settings.section");
    const revision = ctx.locale.getSnapshot().revision;
    if (version !== rowsVersion || revision !== rowsRevision) {
      rowsVersion = version; rowsRevision = revision;
      rows = ctx.slots.entries("settings.section").map((e) => ({
        id: e.options.id ?? "", order: e.options.order ?? 0,
        label: resolveSlotLabel(e.options.label) ?? ""
      })).sort((a, b) => a.order - b.order);
    }
    return rows;
  },
  subscribe: (listener) => {
    const offLedger = ctx.slots.subscribe("settings.section", listener);
    const offLocale = ctx.locale.subscribe(listener);
    return () => { offLedger(); offLocale(); };
  }
}
```
Slot service surface seen in use: `slots.inject(name, registerFn)`, `slots.register(options, Component)`, `slots.entries(name)`, `slots.getVersion(name)`, `slots.subscribe(name, cb)`; occupant side gets `renderSlot(name, props, opts)` where opts seen are `{ entryKey }` (keyed), `{ fallback }` (single), `{ only }` (list filter, `dsh-client-ui-settings-plugins/lib/client.js:68,124`).

### 2.3 Registration options actually accepted
Observed across bundles: `name`, `id`, `order`, `priority` (third-party `dsh-reasoning-effort` uses `priority:-1`, client.js:612), `label` (string or `() => string`), `locale` (dictionary namespace → occupant gets `t`), `inject` (fiber-service list for the occupant / factory), `children` (`{ [slotId]: { kind:"single"|"list"|"keyed", scope:"root" } }`), `store` (root-scoped store handle, `sidebar.settings`).

### 2.4 Neighbouring slot ids (useful surface, from other packages)
`sidebar.settings` (single, shell), `settings.launcher`/`settings.trigger`/`settings.header`/`settings.action`/`settings.close` (shell chrome), `settings.general.item` (general items; `developer-tools` order 15, `current-version` order 100 — settings-general:1079-1094), `settings.plugins.tab` (plugins section tabs; `settings.plugins` registers the section `nav:"Built-in plugins"` and renders `renderSlot("settings.plugins.tab",{},{only:row.id})`), `plugins.item` (Plugins-page cards, e.g. `shell` order 40, `agent-loop` order 30), `conversation.input.model` (composer model control, used by dsh-reasoning-effort), `sidebar.toggle.badge`, `shell.overlay`.

### 2.5 Live-slot cross-check (limitation)
`cordis_inspect_query(platform=client, provider=Slots, method=listSubTree)` timed out 3×, incl. `{root:"settings.section"}`; `Service`/`Theme`/`Builtin` also timed out. So the table above is source-derived, not runtime-derived. If a later session gets the client bridge working, confirm with `Slots.listSubTree`.

---

## 3. Ranked recommendation: where to put the per-model retry group (Q3)

Candidate surface A (only existing slot in the add flow) is `settings.models.provider-card`; there is no model-level slot. Verdicts:

### #1 — C. Own Settings section (`settings.section`, own id) — RECOMMENDED
- Plugin registers its own first-level section with children slots; this is a **proven third-party pattern**: `dsh-plugin-wallpaper-engine/lib/client.js:14130-14135`
  ```js
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      { name: "settings.section", id: "wallpaper-engine", order: 500, label: "Wallpaper Engine" },
      () => React.createElement(WallpaperPickerSection),
    ));
  ```
  (its `package.json` dsh block: `{"bundle":{"patch":"./cordis.patch.yml"},"client":{"inject":["@deepseek-ai/dsh-client-runtime"],"platform":"web","immediately":true}}`).
- Section component gets `t`, `renderSlot` and whatever the plugin injects; it can **read** `llm-pi-ai` read-only through the shared describe mirror (`ctx.configForms.describe()` → `view.namespaces[]`, each `{ns, schema, value, base, user, revision, ...}`, `dsh-api-settings-controller/lib/index.js:274-289,393-400`) to list providers/models, and **write** the plugin's own namespace. Full control of layout: per-model row = retry count + strategy `SegmentedControl` + 2 numeric fields + `0 = 无限重试` caption.
- Cost: the control is one nav click away from Models, not literally in the add-model row.

### #2 — A″. `settings.models.provider-card` occupant (keyed) as a contextual companion
- Real slot, keyed per provider, rendered in the provider card *and in the add-catalog panel*, so it is visible while a user adds models: `client.js:2541-2545`, `2616-2620`, `2725-2729`.
- Props are thin: `{ provider, configured, keyConfigured }` (no models). To render per-model rows the occupant must read the namespace itself (`configForms.describe()` / `ctx.configForms.get(ns)`), and it is **not rendered in the custom-provider panel** and never inside a model row.
- Good as a "retry policy for this provider's models" summary/CTA; unsuitable as the primary surface.

### #3 — B. Wrap/patch the stock section to render stock UI + our field — NOT feasible cleanly
- The stock component is **not exported**: `client.js:4520-4522` exports only `apply`, `inject`, `refreshIfLoaded`; `ModelsSection`/`ProviderEditor`/`ModelListEditor` stay module-private.
- The slot ledger exposes registration and lookup (`entries`), not a render-one-occupant API; registering a second `settings.section` entry would add a **second nav row**, not wrap the first.
- Only workable variant would be copying the whole models page into the plugin (hundreds of lines + its CSS + schema logic) — high drift risk against a moving `llm-pi-ai` schema. Reject.

### #4 — D. Intercept the settings document write — NOT feasible client-side
- `settings/document-updated` is a **broadcast after a read** (`dsh-settings/lib/index.js:435,461`; client subscribes at `client.js:4472-4478`), not a write hook; the browser half can only call `remote.settings.mutate(ns, ops, revision)` and observe the result (`dsh-client-ui-settings/lib/client.js:1165-1182`, models `3179-3193`).
- A host-side interceptor would have to live inside `SettingsForms.write`'s `configEditor.edit` path (`dsh-settings/lib/index.js:501-537`) which is core; there is no plugin seam there. Autogenerating/rewriting a namespace after the fact would race the writer. Reject.

**Combined recommendation:** C primary (own section + own writable namespace), optionally A″ as a small per-provider entry point. The per-model control group itself (from the Lead's spec update):
1. `失败重试次数` — numeric, `0 = 无限重试` (caption under the field), min 0, integer, empty = inherit/default.
2. `重试冷却策略` — `SegmentedControl`/`<select>`: `fixed` | `incremental`.
3. `基础冷却（秒）` — numeric ≥ 0, integer (fixed interval / first wait).
4. `增量（秒）` — numeric ≥ 0, integer; rendered but disabled/hidden when strategy = fixed (mirror the stock pattern `ModelReasoningEfforts` pushes only relevant rows, `339-478`).

**Hard domain constraint (not a UI issue, but the UI must match it):** today retry is **provider-scoped**, captured at adapter registration, not model-scoped:
- `dsh-llm-pi-ai/lib/index.js:2823-2828` — `registrationFacts()` includes `retryPolicy: profile.retryPolicy` per provider route; `applies` to registration.
- `dsh-llm/lib/index.js:2243` — a prepared call exposes `retryPolicy: registration.retryPolicy`.
- `dsh-llm-retry/lib/index.js:44-49,161-173` — backoff is **exponential with jitter**: `initialDelayMs * 2 ** (retry-1)`, clamped by `maxDelayMs`, times a jitter factor; policy shape `{mode:"normal"|"always", maxRetries, retryableCodes[], initialDelayMs, maxDelayMs, jitterRatio}`; `maxRetries` is compared against a per-`(provider, policyKey)` session-projection counter reset on `step/start`, so the stock counter is already **per step** (`retryStateKey`, `92-107`).
- Consequence: "0 = unlimited" maps naturally to `mode:"always"`; "N = at most N" maps to `mode:"normal", maxRetries:N` — but FIXED vs INCREMENTAL (linear `prev + M`) is **not** what the stock exponential formula does, and per-model selection is **not** what the stock plugin reads. The host half must either reimplement this policy (own `agent/request-error` listener) or replace `llm-retry`; the UI should store exactly the fields that host half consumes.

---

## 4. Client services and `dsh.client.inject` (Q4)

### 4.1 What the models page declares
`client.js:4417-4427`:
```js
const inject = [
  "slots", "locale", "remote", "remote.credentials", "remote.llm",
  "remote.settings", "remote.session", "configForms", "settingsSchema"
];
```
and `package.json` → `dsh.client.inject` (module-level rows that must exist first):
```json
"dsh": { "client": { "inject": [
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-api-remotes"
], "platform": "web" } }
```

### 4.2 Data path (browser → Host)
- Reads: `ctx.remote.settings.describe()` → `{writable, hasDocument, namespaces:[{ns, autoGenerate, schema, value, base, user, applies, secrets, revision}]}` (Host: `dsh-api-settings-controller/lib/index.js:393-400`, field projection `274-289`).
- Writes: `ctx.remote.settings.mutate(ns, ops, expectedRevision)`; ops are `{op:"set"|"unset", path:[...], value}` (`client.js:3179-3193`; Host `433-476`, conflicts → `settings/conflict`, other refusals → `settings/rejected`).
- Shared mirror (preferred for a settings page): `ctx.configForms.describe()` → `{ensure(), getSnapshot(), subscribe()}`; per-namespace form: `ctx.configForms.get(entryId)` → controller with `getSnapshot()/subscribe()/set()/unset()/mutate()/dispose()` and `{status: idle|loading|ready|unavailable|saving, value, base, user, revision, writable}` (`dsh-client-ui-settings/lib/client.js:1140-1244,1287-1301`).
- Reactivity: subscribe `ctx.remote.$on("settings/document-updated", ...)`, `credentials/record-updated`, `llm/adapters-updated`, `ctx.on("connection/reset", ...)` (`client.js:4467-4484`).
- Schema introspection for form generation: `ctx.settingsSchema.rehydrate/validate/nodeAtPath/getPath/hasPath/setPath/deletePath` (`client.js:3213-3223`); models page derives protocol choices and reasoning levels from the *live schema* (`1242-1271`).

### 4.3 For a client-only settings page (no llm/credentials access needed)
Measured minimal inject lists from sibling pages:
- `dsh-client-ui-settings-shell`: `["slots","locale","configForms"]` (`lib/client.js:161-165`)
- `dsh-client-ui-settings-agent-loop`: `["slots","locale","configForms"]` (`139-143`)
- third-party `dsh-reasoning-effort` client half: `["slots","locale","modelDirectories","sessions","remote","remote.session"]` (`lib/client.js:593-600`)
- third-party `dsh-plugin-wallpaper-engine`: `dsh.client.inject:["@deepseek-ai/dsh-client-runtime"]`, client `inject` includes `"slots"` etc.

So a client half that only needs its own namespace + slots needs `inject: ["slots", "locale", "configForms"]` (plus `"remote"`/`"remote.settings"` if it talks to `remote.settings` directly) and `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale"]` (add `@deepseek-ai/dsh-api-remotes` when using `remote.*`).

---

## 5. Locale resources and theme tokens (Q5)

### 5.1 Locale
- `locale/en.json` (and `zh.json`) is **package metadata only**: `{"meta":{"title":"ui-settings-models"}}` — verified for settings-models.
- Real copy ships **inside the client bundle** as `const en = {...}; const zh = {...};` and is registered at apply time:
  ```js
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-settings-models: copy dictionaries");
  const t = ctx.locale.bind(NS);
  ```
  (`client.js:3225-3269` for the dictionaries, `4437-4444` for registration; NS = `"settings.models"` at `4402`).
- Keys are flat camelCase (`add`, `addModel`, `models`, `modelId`, `modelName`, `contextWindow`, `maxTokens`, `modelContextInvalid`, `addCustom`, `customRoute`, ...). `t()` does **not** interpolate — placeholders are substituted by the caller: `t("savedProvider")` + `providerCopy(template, target)` → `template.replace("{provider}", () => label)` (`2316-2318`), and `t("baseUrlEnvironment").replace("{env}", ...)` (`2002`).
- A section nav label is a slot option, not copy from the shell: `label: () => t("nav")`.
- Adding a third language means adding a dictionary to `ctx.locale.register`; the *package* `locale/*.json` files do not carry UI strings.

### 5.2 Theme tokens (exact `--dsw-*` names seen used by form surfaces)
Live `Theme.listTokens` timed out; names below are read from the shipped CSS strings.

Models form (`ModelsSection.module.css`, `client.js:58` `css$3`):
- text/labels: `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`, `--dsw-alias-label-tertiary`
- containers: `--dsw-alias-settings-card-fill`, `--dsw-alias-settings-card-stroke`, `--dsw-alias-border-l2`, `--dsw-alias-border-l3`, `--dsw-alias-bg-layer-2`
- states: `--dsw-alias-state-error-primary`, `--dsw-alias-state-success-primary`, `--dsw-alias-state-warn-label`
- shape: `--dsw-radius-xs`, `--dsw-radius-md`, `--dsw-radius-xl`
- hover/mask/elevation: `--dsw-alias-interactive-bg-hover`, `--dsw-alias-bg-mask-1`, `--dsw-elevation-prominent`
Theme/General surfaces (`dsh-client-ui-theme/lib/client.js:27`, `dsh-client-ui-settings-general/lib/client.js:60`): `--dsw-alias-border-l4`, `--dsw-alias-bg-module-platform`, `--dsw-static-neutral-bluish-400`, `--dsw-radius-panel`, `--dsw-focus-ring-width`, `--dsw-focus-ring-color`, `--dsw-alias-state-business-primary`, `--dsh-frame-chrome-top`, `--dsh-frame-overlay-top`, `--dsh-scrollbar-thumb`, `--dsh-scrollbar-thumb-hover`.
A plugin that wants zero-risk styling can also follow the two third-party examples and ship its own stylesheet injected as a `<style data-plugin=… data-plugin-css=…>` tag (`dsh-reasoning-effort/lib/client.js:576-589`, wallpaper-engine reads/writes matching tokens `--we-*`).

**Inference flagged:** token names are stable because they are referenced by built-in CSS; but the authoritative list should be re-queried via the client `Theme.listTokens` inspect provider once the page answers.

---

## 6. Packaging a dynamic client half (Q6)

Authoritative contract: `@deepseek-ai/dsh-client-modules/lib/index.js` (node half composes `window.__DSH_BOOT__`, serves `/plugins/...`) and `lib/client.js` (browser lazy-CJS module table).

### 6.1 Package.json requirements
Scanned per Loader entry (`lib/index.js:720-750`):
```js
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const decl = parseDshClient(packageName, dsh.client);
if (decl === void 0 || decl.platform !== "web") return null;
const clientRel = clientExportOf(packageName, pkg.exports);
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
```
`dsh.client` accepts exactly (`lib/client.js:61-75`): `platform: "web"` (required string), `inject?: string[]`, `external?: string[]`, `immediately?: boolean`; anything else/typed wrong throws. `exports["./client"]` (string or `{default:string}`) must point at the **built** bundle (else `MissingClientBundleError: run pnpm run build before launch`). Manifest `name` is the browser module id; two active Loader sources for one package name is a composition error (`893-896`).

Plugins installed with `plugin_manager install_bundle` are ordinary npm packages in the profile, and the profile lists them under `dsh.profile.bundles` — proven by the live profile:
`%DSH_HOME%\profiles\desktop\package.json` → `dsh.profile.bundles` includes `dsh-whale-widget`, `dsh-reasoning-effort`, `dshmarket`, `dsh-plugin-wallpaper-engine`; each ships a `cordis.patch.yml` inserting its host entry (e.g. `dsh-reasoning-effort/cordis.patch.yml` → `{insert:[{id: reasoning-effort, name: dsh-reasoning-effort, config:{}}]}`).

### 6.2 Bundle format
- Plain **classic script** (not an ES module) calling the loader facade; the whole plugin lives in the factory closure:
  ```js
  window.__ModuleLoader__.load({
    id: "dsh-reasoning-effort",            // = package name
    factory: (require) => {
      var module = { exports: {} }; var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      let react = require("react");
      let react_jsx_runtime = require("react/jsx-runtime");
      ...
      exports.apply = apply; exports.inject = inject; return module.exports;
    }
  });
  ```
  (`dsh-reasoning-effort/lib/client.js:1-8`, `629-631`; same wrapper for every first-party bundle.)
- Only the registration runs at script execution; **all side effects (CSS injection included) run on materialization** (`lib/index.js:17-24`). Source-map trailer `//# sourceMappingURL=client.js.map` is served/combined, optional.
- `apply(ctx)` / `inject` are the client Cordis plugin shape: `inject` = **service names** (`ctx.slots`, `ctx.locale`, `ctx.configForms`, `ctx.remote.*`), exactly like the host half.
- Optional package-local dynamic chunks may be requested via `require.async("./client.xxx.js")`; files must match `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$` and be listed in `files` (`lib/index.js:169-170`).
- Externals: `require(spec)` resolves **seed word → materialized module → registered factory**, else throws ("not a platform seed word, not a materialized module, and no registered package factory"). So a third-party bundle may only import (a) platform seed words and (b) DSH packages that are themselves graph rows listed in `dsh.client.inject`/`external`. Third-party evidence: `react`/`react-dom` are seed words — `dsh-plugin-wallpaper-engine/lib/client.js:10051-10055` (`const React = require("react"); const ReactDOM = require("react-dom");`); first-party bundles additionally `require("@deepseek-ai/dsh-client-ui-primitives")`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `react/jsx-runtime` at factory top, and those packages are **not installed as packages in the asar** → they are shell-provided seed words.
- `dsh.client.external` = require-graph edge declarations (ordering among dynamic packages); `dsh.client.inject` = packages that must be registered/loaded before this half activates; `immediately:true` = load in the parser/bootstrap batch.
- React is **not bundled**: JSX must arrive pre-compiled to `jsx/jsxs` from `react/jsx-runtime` (all bundles use `(0, react_jsx_runtime.jsx)(...)`).

### 6.3 Constraints / gotchas for third-party installs
1. Bundle must be built and committed (`lib/client.js`); dev-only TS/TSX will not be compiled by the product.
2. `dsh.client.platform` must be `"web"`; missing/invalid declaration = silently not a client package; declaring it without `exports["./client"]` = **fatal boot composition error**.
3. `dsh.client.inject` package names must resolve to real Loader/client rows, otherwise the row is simply not pre-arrived (and `require` of it then throws at materialization).
4. One package name = one client bundle; two Loader sources for it abort boot.
5. Bundle executes as a classic script and its registration is rejected on duplicate — HMR reload works through rev-hashed URLs, but a manual re-injection throws.
6. The loader catches no factory exceptions: a throw in `apply()` leaves a missing fiber (page shows a boot-audit failure), so feature-detect optional services (`ctx.slots`, `ctx.remote.settings`) if targeting older hosts.

---

## 7. Stock form primitives for the multi-field group (Q7)

All from the browser module `@deepseek-ai/dsh-client-ui-primitives` (module id used by every bundle; not an installable package). Names and props below are taken from real call sites.

| need | primitive | evidence |
|---|---|---|
| numeric field tied to a settings namespace, with hint, override/reset, invalid text | `SettingsValueField` — props `{id, label, hint, overriddenLabel, resetLabel, invalidLabel, numeric, disabled, value, placeholder/overridden state from spread, onEdit(text), onReset}` | `dsh-client-ui-settings-shell/lib/client.js:76-108`; `dsh-client-ui-settings-agent-loop/lib/client.js:71-87` |
| form frame (save/discard/read-only/unavailable/save-failed) + staged model | `SettingsForm` + `SettingsFormModel(scope, [settingsNumberField(field)])`; controller gives `.shell()`, `.field(name)`, `.actions()`, `.bind(project)`, `.dispose()` | shell `71-147`; agent-loop `99-127` |
| per-field number schema with validation | `settingsNumberField("fieldName")` | shell `124`; agent-loop `104` |
| segmented choice (strategy selector) | `SegmentedControl` — `{id, label, value, options:[{value,label,disabled,title}], onChange, disabled}` | models `2644-2663` |
| boolean | `Switch` `{checked,label,disabled,onChange}`; `Checkbox` `{label,checked,disabled,onChange}` | models `396-403`, `241-257` |
| helper/caption under a control | `hint` prop of `SettingsValueField`; otherwise plain `<p>` styled with `--dsw-alias-label-tertiary` (models `advancedHint`/`intro` classes) | models `1762-1765`, `2188-2191` (`advancedHint`), `2499-2502` (`intro`); shell `79` |
| dialog | `Modal` `{open,onClose,title,closeLabel,description,footer,headless,className}`; `Button` `{variant:"primary"|"outline"|"ghost", size:"sm"}`; `closeTopModal(document)` | models `1113-1128`, `2777-2801`; general `1227` |
| tooltip/help | `Tooltip` `{label,side,delayMs,focusDelayMs,portal,openOnClick}` wrapping a `?` button | models `382-395` |
| icons | `IconPlusOutlineRegular`, `IconTrashOutlineRegular`, `IconChevronDownOutlineRegular`, `IconChevronRightOutlineRegular`, `IconLightOutlineMedium`, `IconDarkOutlineMedium`, `IconFollowsystemOutlineMedium` | models `474/456/513`; theme `57-68` |
| plain text/number input | **none exported** — the stock pages use native `<input type="text" inputMode="numeric">`/`<select>` with their own CSS-module classes | models `419-446`, `533-545`, `1705-1717` |

Notes for the retry group: a caption line "0 = 无限重试" belongs in `hint` (or a `<p class=advancedHint>`); the incremental field should be conditionally rendered the way `ModelReasoningEfforts` renders its rows only after the switch is on (`models 404-476`). `SettingsValueField` is the closest match to "numeric field with validation/errors in a settings page", but it is coupled to a `SettingsFormModel` over a served namespace — which reinforces recommendation C (own namespace).

---

## 8. Numeric persistence + validation example (Q8)

Two idioms exist; both are evidence-backed:

1) **Schema/path-op form (models page)** — typed text buffer + parsed integer + row-level error key + submit gating (§1.4 above; `581-660`, `713-741`, `1586-1600`, `2188-2196`). Use this when the control must live inside a provider card and be written with `remote.settings.mutate` path ops.

2) **Shared settings form (shell/agent-loop pages)** — `SettingsFormModel` + `settingsNumberField` + `SettingsValueField numeric`, which owns validation and shows `invalidLabel` + a `saveFailed` banner:
```js
// dsh-client-ui-settings-agent-loop/lib/client.js:104-112, 71-87
constructor(scope) {
  this.form = new SettingsFormModel(scope, [settingsNumberField("maxParallelToolCalls")]);
  this.store = this.form.bind(() => ({ ...this.form.shell(), maxParallelToolCalls: this.form.field("maxParallelToolCalls") }));
}
...
jsx(SettingsValueField, {
  id: "plugin-config-agent-loop-parallel", label: t("maxParallel"), hint: t("maxParallelHint"),
  overriddenLabel: t("overridden"), resetLabel: t("reset"), invalidLabel: t("invalidNumber"),
  numeric: true, disabled: !state.writable, ...state.maxParallelToolCalls,
  onEdit: (text) => { props.edit("maxParallelToolCalls", text); },
  onReset: () => { props.resetField("maxParallelToolCalls"); }
})
```
This idiom gives "min 0 / integer seconds" for free **only if the host namespace schema declares the constraint** (e.g. `z.natural()` / `.min(0).step(1)`), because the field is projected from the namespace's serialized schema; the client validates against `invalidLabel` text and a failed write leaves the draft (`saveFailed`).

---

## 9. Can a plugin read/write an arbitrary settings namespace? (Q9)

**No. The namespace must exist as a configurable Host profile entry whose Config schema declares volatile fields.** Mechanism, Host side:

1. `settings.describe()` iterates **Loader profile entries** (`configEditor.configuration()`) and keeps only entries whose plugin runtime exports a `Config` schema (`entry.fiber.runtime.Config`) that has at least one `.volatile()` field:
   `dsh-settings/lib/index.js:409-464` — `const schema = this.schema(entry); const form = volatileForm(schema); if (form === undefined) return [];`
   `volatileForm` (`118-131`): returns the whole schema when `schema.meta.volatile`, else an object of the volatile child fields; **undefined when nothing is volatile**.
2. Writes are constrained the same way: `SettingsForms.write` (`501-537`) resolves the entry by id, rejects unknown namespaces (`No configurable plugin entry "ns"`), rejects non-volatile paths (`Config field "x" is not volatile`) and applies the change through `configEditor.edit` (i.e. the profile YAML patch document).
3. The Remote wrapper only validates `ns` is a nonempty string and forwards; failures become `settings/rejected` / `settings/conflict` (`dsh-api-settings-controller/lib/index.js:433-476,501-509`).

Therefore the **Host half of our plugin must**:
- be a Loader entry (inserted by its `cordis.patch.yml`) with a stable `id:` — that id **is** the namespace string used by `configForms.get(id)` / `remote.settings.mutate(id, ...)`;
- `export const Config = z.object({ ... })` from the host package root, with the per-model retry fields under a `.volatile()` node (nested dict/array is fine: `volatileForm` recurses, and `isVolatilePath` treats a path beneath a volatile node as editable);
- `export function apply(ctx, config)`; and (optional but idiomatic for a settings page) `ctx.settings.configure({auto:false})` for instances that should not appear in the Plugins auto-form (pattern: `dsh-llm-pi-ai/lib/index.js:2860-2863`).
Then the browser half sees it in `ctx.configForms.describe()`/`remote.settings.describe()` with `schema` + `value` + `revision`, and writes path ops with `revision` for optimistic concurrency.

Practical storage shape implied by the feature (per provider+model, so the host can look it up per prepared call):
```yaml
# entry id: e.g. "llm-model-retry"
models:
  yundu/gpt-6-astra: { retries: 0, strategy: incremental, baseDelaySec: 2, incrementSec: 5 }
```
(`providers`-shaped nesting also possible; a flat `"<provider>/<model>"` dict key keeps the settings schema trivial to make volatile and avoids array-index rewrites.)

**Why not store it inside `llm-pi-ai`'s model entries?** `llm-pi-ai` is itself a configurable entry and its `providers` subtree is writable by the Models page, so a `set` of `providers.<route>.models[i].retry` would pass the volatility check — but the Models page rewrites the whole `models` array from its **schema-projected** view (`projectForm(volatileForm(schema), raw)` in `dsh-settings/lib/index.js:141-147,436`), and `pathOps` sends the array wholesale (`client.js:1822-1841`). Extra keys inside a model entry are therefore liable to be dropped on the next Models-page save, and the value is not validated by our plugin. Also `llm-pi-ai`'s schema is not ours to extend. Treat as unsupported.

---

## 10. Risks / open items

1. **No user-facing retry semantics exist per model today.** `llm-retry`'s policy is per-provider, exponential+jitter, `maxRetries` per step (`dsh-llm-retry/lib/index.js:44-49,92-107,161-173`); the requested FIXED and INCREMENTAL+`M` strategies and the 0=unlimited-per-model semantics need host work. UI must be designed against that host contract; if it lands later, the form fields are wasted.
2. **No per-model slot.** Any "right where you add a model" placement is either provider-granularity (`settings.models.provider-card`) or a separate section. Expect a UX compromise.
3. **Stock ModelsSection is unexported** → wrapping/replacing the stock UI is not plugin-only; keep hands off `llm-pi-ai` UI.
4. **Live client inspection unavailable** in this session (4 decisive timeouts: `Slots.listSubTree` ×2, `Service.listService`, `Theme.listTokens`). Slot ids/props/theme tokens here are source-derived; a page-connected session should re-run `Slots.listSubTree{root:"settings.section"}` and `Theme.listTokens` before building.
5. **Seed-word set not directly readable.** `react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots` are inferred seed words (required by shipped bundles that are themselves rows, and absent as installed packages). Importing any *other* `@deepseek-ai/*` client package from a third-party bundle will throw at materialization unless that package is a graph row — test before relying on it.
6. **Locale copy must be embedded in the bundle** and registered via `ctx.locale.register`; `locale/*.json` alone shows nothing. Also `t()` has no interpolation; use `.replace("{x}", …)` like the stock pages.
7. **Type declarations are not shipped** in the product asar, so plugin authoring must mirror runtime call sites (this report) rather than import `.d.ts` contracts.
8. **Where the added model's identity comes from** for keying retry config: model id (`providers.<route>.models[i].id`) is unique per provider; ids may repeat across providers (`deepseek-flash` exists in several routes — see the live profile `cordis.patch.yml` sensenova list), so the retry key must be `provider + "/" + modelId`, not model id alone.
