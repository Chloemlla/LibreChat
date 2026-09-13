# Interactive Widget Cards

> 中文版见 [`widget-cards.zh.md`](./widget-cards.zh.md)。

A model turn can hand back an **interactive card** instead of prose: a coordinate plot you can click,
a simulation with sliders, a small form. The mechanism mirrors the two-layer design used by hosted
assistant platforms — the model emits a *specification*, and a separate compile step turns that
specification into a component the browser can run.

## Two layers

**1. Protocol layer (prompt pre-injection).** Every agent turn carries a directive that tells the
model the tag format, the JSON shape and when a card is worth emitting. The directive is appended to
the agent's `additional_instructions` in `packages/api/src/agents/initialize.ts`, next to the existing
artifacts directive, so it reaches every endpoint and every runtime agent. It is `null` unless the
feature is enabled, so a disabled deployment sends nothing.

**2. Render layer (compile + sandbox).** The client's markdown pipeline recognizes the tag, calls
`POST /api/widgets/generate` once to compile the specification into a single-file React component,
and mounts that component inside a sandboxed iframe. Nothing the model writes is evaluated in the
application's own document.

## Wire format

````text
<GenerateWidget height="600px">
{"widgetSpec": {"height": "600px", "prompt": "**Objective:** …\n**Data State:** …\n**Inputs:** …\n**Behavior:** …"}}
</GenerateWidget>
````

- One JSON object, one `widgetSpec` key, one `prompt` string. Unknown keys are ignored.
- **No blank line inside the block.** Markdown ends a raw-HTML block at a blank line, so a blank line
  after the opening tag splits the block and the tag can no longer be paired with its spec. The
  directive in the prompt states this; the parser additionally tolerates a ```json fence around the
  JSON body.
- `height` is advisory. It is applied as the initial iframe height; the frame reports its own content
  height and the card grows to match.

## The tag is not stripped while it streams

An unpaired tag stays in the message as literal text (raw HTML is not rendered — `rehype-raw` is not
enabled in this repository), then is replaced by the card once the closing tag arrives. A tag whose
body fails to parse also stays as text: an unparseable card must not silently swallow the message.

## Configuration

```yaml
interface:
  widgets: true
```

- Schema: `interfaceSchema` in `packages/data-provider/src/config.ts`; default `true`.
- `loadDefaultInterface` (`packages/data-schemas/src/app/interface.ts`) lists the interface keys it
  copies into the loaded config explicitly, so the new key must be added there or the client never
  sees it. It is the same object `/api/config` sends the client and the one the server injects from,
  so both sides gate on one value.
- Server reads `appConfig.interfaceConfig?.widgets !== false` to decide whether to inject the
  directive; client reads `startupConfig.interface?.widgets !== false` to decide whether to register
  the renderer. `undefined` is the enabled case; with the feature off, a stray tag renders as text.
- `librechat.yaml` is validated with `.strict()`, so the key must exist in the schema before an
  operator can set it.

## Compile endpoint

`POST /api/widgets/generate` — JWT-authenticated, rate limited.

The middleware chain is `requireJwtAuth` → `messageUserLimiter` → `configMiddleware` →
`validateModel.json`. Three of those are load-bearing beyond the obvious:

- **`configMiddleware` is not global.** It is mounted per-router (see `api/server/routes/agents/index.js:1142`), and `req.config` is what both `validateModel`'s `getEndpointsConfig` and the handler's `getProviderConfig({ appConfig: req.config })` read. Omitting it does not fail loudly — it silently resolves no endpoint config, so custom endpoints and user-provided keys stop working.
- **`messageUserLimiter`, not `promptUsageLimiter`.** The latter is the prompts CRUD bucket; a compile is a model call and belongs in the same per-user budget the chat path uses (`api/server/routes/agents/index.js:1160,1164`), so a runaway card costs the same quota as a runaway turn and is denied through the same `MESSAGE_LIMIT` violation path.
- **`validateModel.json`, not `validateModel`.** The chat guard refuses through `handleError` (`packages/api/src/utils/events.ts`), which writes an SSE frame and leaves the status at 200 — a rejection a JSON client reads as a success. The `.json` variant applies the same rule and answers with a status and an `error` body. Both are built on `checkModelAccess` (`packages/api/src/endpoints/access.ts`), so the two shapes cannot drift apart.

```jsonc
// request
{ "spec": "<the widgetSpec.prompt text>", "endpoint": "openAI", "model": "gpt-4o-mini" }
// response
{ "code": "function Widget() { … }" }
```

The user picks `endpoint`/`model` in the card, so the call must be authorized against the same model
access rules the chat path enforces. The compiled component is a single function body — no imports,
no network access — and is returned as a string; nothing is executed server-side.

### Authorization

The route mounts the JSON guard exported by `api/server/middleware/validateModel.js` — the rule
`api/server/routes/assistants/chatV1.js:32` enforces on the chat path, in a shape a JSON client can
read. It reads only `req.body.endpoint` and `req.body.model`, trims and pattern-checks the model,
resolves the endpoint's catalog through `getModelsConfig`, and refuses a model the endpoint does not
offer with an `ILLEGAL_MODEL_REQUEST` violation. Endpoints with `userProvide: true` pass through,
because the user supplies their own credentials and the catalog is not the authority there. The
status follows the reason: 400 for a malformed identifier, 403 for a model the endpoint does not
offer, 503 when the catalog has not loaded.

`buildEndpointOption` is deliberately **not** mounted: it is chat-shaped (`parseCompactConvo`,
model-spec presets, content filter, file usage) and expects a conversation envelope this request
does not have.

### Model choice in the card

The card's selector is feature-local and read-only. It does **not** reuse
`client/src/components/Chat/Menus/Endpoints/ModelSelector.tsx`: that component is bound to the
conversation store (it writes the selected model back into the active conversation), and reaching
into app-global state from a feature that could later be extracted is exactly what the client
state-ownership rule forbids.

Instead the selector reads the endpoint list from the existing `useGetEndpointsQuery()`
(`client/src/data-provider/Endpoints/queries.ts:9`) and the model list from the existing
`useGetModelsQuery()` (`packages/data-provider/src/react-query/react-query-service.ts:190`, backed by
`/api/models`). Both are read-only cache reads — no conversation state is written, and the card
needs no new query hook beyond its own compile mutation. The compiled card caches per
`(endpoint, model, spec)` in the component, so re-rendering a message does not re-bill a compile.

### The call

The handler resolves provider config from the request's own `req.config` and makes one
non-streaming call — the shape already proven by the activity-label path
(`packages/api/src/agents/activityLabels/host.ts` → `runtime.ts`):

```ts
const providerConfig = getProviderConfig({ provider: endpoint, appConfig: req.config });
const options = await providerConfig.getOptions({
  req,
  endpoint,
  model_parameters: { model },
  db, // EndpointDbMethods — { getUserKey, getUserKeyValues } from ~/models
});
const clientOptions = Object.fromEntries(
  Object.entries(options).filter(([key]) => !omitTitleOptions.has(key)),
);
// ...provider-specific cap (see the label path)...
resolveConfigHeaders({ llmConfig: clientOptions, user, tenantId, body: ids });
const client = initializeModel({
  provider: options.provider ?? providerConfig.overrideProvider ?? endpoint,
  clientOptions: { ...clientOptions, streaming: false } as ClientOptions,
});
const response = await client.invoke(buildCodegenPrompt(spec), { signal });
const code = extractText(response?.content);
```

Five details this inherits on purpose:

- **`omitTitleOptions` sanitization.** `getOptions` returns generation parameters sized for a full
  chat turn; the compile call is a bounded codegen task, so the chat caps are stripped exactly as
  the title and label paths strip them, and replaced with a cap sized for a component.
- **`db` is the two-method endpoint interface**, not the whole models module — `getUserKey` /
  `getUserKeyValues` are what make a user-supplied API key work. Without them the compile fails for
  every endpoint the operator did not configure server-side credentials for.
- **`resolveConfigHeaders` runs before construction.** Proxies that key on conversation or user
  metadata need those headers on the compile call too; the call is otherwise unauthenticated at the
  proxy. It also restores the Anthropic `clientOptions` carrier, which holds the SSRF-safe
  `fetchOptions` guarding user-provided base URLs — dropping it re-opens the redirect and DNS-rebind
  paths endpoint validation exists to close.
- **`getProviderConfig` reads `appConfig`, not a singleton.** The module takes it from
  `req.config`, so the handler stays constructible in a test.
- **A timeout signal.** The call is bounded by `AbortSignal.timeout(...)`, so a hung provider
  surfaces as a card error rather than a request that never returns.

Because the endpoint is the *user's* choice rather than the agent's, the provider here can differ
from the agent that produced the spec — which is the point: a cheap model writes the spec, and the
user decides which model compiles it.

## Sandbox

The card is an `<iframe sandbox="allow-scripts" src="/widget-runtime.html">`:

- **`allow-scripts` and nothing else** — no `allow-same-origin`, so the frame runs in an opaque origin
  and cannot reach the parent document, its cookies, its storage or its DOM.
- **A static same-origin runtime, not `srcdoc`.** An `srcdoc` document inherits the embedding page's
  CSP; when an operator enables `CSP_ENABLED` the policy is `script-src 'nonce-…' 'strict-dynamic'`,
  which blocks every script the runtime would load and leaves a dead frame. A separate static document
  is served without the shell's policy, while `frame-src 'self'` still admits it. Production runs
  without CSP today; this choice keeps the feature working when that changes.
- `widget-runtime.html` lives in `client/public/` and is copied into `dist/` by the
  `copyPublicAssets` plugin in `client/vite.config.ts` (production builds set `publicDir: false`, so
  nothing under `public/` is copied automatically).
- Inside the frame a `<meta http-equiv="Content-Security-Policy">` pins the policy further:
  `default-src 'none'`, scripts only from the pinned library URLs, `connect-src 'none'`. A meta policy
  can only narrow what the document may do, and `connect-src 'none'` is what stops generated code
  from posting the spec anywhere.
- **Tailwind is loaded in the frame** (`https://cdn.tailwindcss.com/<pinned version>`, the same CDN the
  artifact pipeline uses), because the codegen directive promises the compiled component Tailwind
  utility classes as its only styling mechanism.

### Theme

A frame does not inherit the host's theme: `prefers-color-scheme` inside an iframe follows the OS, not
the application's forced theme, so a user on a dark theme with a light OS would get a light card.

The frame therefore runs Tailwind with `darkMode: 'class'` and toggles `dark` on its own root. The host
supplies the flag: it reads the resolved class off the rendered document root (reading what was
rendered, not reaching into a theme store) and sends it with the payload, re-sending when it changes.
The codegen directive tells the model to write `dark:` variants on the same element, so the card
follows either theme.

### Message protocol (host ↔ frame)

| Direction | Message | Meaning |
|---|---|---|
| frame → host | `{ type: 'widget:ready' }` | runtime booted, waiting for a payload |
| host → frame | `{ type: 'widget:render', code, dark }` | compile and mount, with the theme flag |
| host → frame | `{ type: 'widget:theme', dark }` | theme changed; re-mount is not needed |
| frame → host | `{ type: 'widget:height', height }` | content height changed |
| frame → host | `{ type: 'widget:error', message }` | compile or render threw |

The host accepts a message only from its own iframe's `contentWindow`, and the frame never trusts the
host's origin string beyond `*` (it has an opaque origin and receives no secrets).

## Files

New:

| Path | Purpose |
|---|---|
| `packages/api/src/prompts/widgets/index.ts` | protocol directive + codegen system prompt |
| `packages/api/src/widgets/generate.ts` | single non-streaming model call |
| `packages/api/src/widgets/validate.ts` | bounds and sanity checks on the returned code |
| `packages/api/src/widgets/controller.ts` | request handler |
| `packages/api/src/endpoints/access.ts` | the model-access rule both guards apply |
| `api/server/routes/widgets.js` | route wiring (auth, limiter) |
| `client/src/components/Widgets/plugin.ts` | remark plugin: tag → node |
| `client/src/components/Widgets/GenerateWidget.tsx` | card component and its states |
| `client/src/components/Widgets/frame.ts` | iframe props, runtime URL, host-side message reducer |
| `client/public/widget-runtime.html` | the sandbox document |

Edited:

| Path | Change |
|---|---|
| `packages/api/src/agents/initialize.ts` | append the directive after the artifacts block |
| `packages/data-provider/src/config.ts` | `interface.widgets` schema field + default |
| `packages/data-schemas/src/app/interface.ts` | copy `widgets` into the loaded interface config |
| `packages/data-provider/src/api-endpoints.ts`, `data-service.ts`, `keys.ts` | endpoint, caller, mutation key |
| `packages/data-provider/src/types.ts` | `TWidgetGenerateRequest` / `TWidgetGenerateResponse` |
| `packages/data-provider/src/react-query/react-query-service.ts` | `useGenerateWidgetMutation` |
| `api/server/routes/index.js`, `api/server/index.js` | register and mount the route |
| `api/server/middleware/validateModel.js` | build both guards on the shared rule, and expose the JSON shape |
| `client/src/components/Chat/Messages/Content/markdownConfig.ts` | register plugin and component |
| `client/vite.config.ts` | copy `widget-runtime.html` into `dist/` |
| `client/src/locales/en/translation.json` | card strings |
| `librechat.example.yaml` | document the key |

## Non-goals

- No persistence. Cards live in the message that produced them; nothing is stored server-side.
- No interaction sent back into the conversation. Clicks and inputs stay inside the frame.
- No card support in `MarkdownLite` (share, subagent, steer, terms views). Those render a fixed,
  narrower subset; a tag there stays literal text.

## Verification

- Backend: unit specs for the directive builder (on/off), the code validator, the shared model-access
  rule, and the handler's authorization and error paths.
- Frontend: a render test for a message carrying a complete tag, a tag still streaming, and a tag with
  a malformed body; a unit test for the message-protocol reducer.
- CI is the only build and test authority in this repository; nothing is built locally.
