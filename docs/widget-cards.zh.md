# 交互式卡片（Interactive Widget Cards）

> 英文版（canonical）见 [`widget-cards.md`](./widget-cards.md)。

模型的一次回复可以不返回散文，而返回一张**交互式卡片**：一张能点的坐标图、一个带滑块的仿真、一个小表单。这套机制与托管式助手平台的两层设计一致 —— 模型产出的是**规格说明（specification）**，再由一个独立的编译步骤把规格变成浏览器能跑的组件。

## 两层结构

**1. 协议层（提示词预注入）。** 每一轮 agent 调用都携带一段指令，告诉模型标签格式、JSON 结构，以及什么情况下值得发一张卡片。该指令在 `packages/api/src/agents/initialize.ts` 中追加到 agent 的 `additional_instructions`，就放在既有 artifacts 指令旁边，因此对每个 endpoint、每个运行时 agent 都生效。功能关闭时它是 `null`，所以关掉的部署不会发送任何东西。

**2. 渲染层（编译 + 沙盒）。** 客户端的 markdown 管线识别这个标签，向 `POST /api/widgets/generate` 发一次请求，把规格说明编译成单文件 React 组件，再把该组件挂载进一个沙盒 iframe。模型写出的任何内容都不会在应用自身的文档里被求值。

## 报文格式（Wire format）

````text
<GenerateWidget height="600px">
{"widgetSpec": {"height": "600px", "prompt": "**Objective:** …\n**Data State:** …\n**Inputs:** …\n**Behavior:** …"}}
</GenerateWidget>
````

- 一个 JSON 对象、一个 `widgetSpec` 键、一个 `prompt` 字符串。未知键会被忽略。
- **块内不能有空行。** Markdown 以空行作为原始 HTML 块的结束标志，所以开标签后出现空行会把块切断，标签就再也配不上它的规格。提示词里的指令写明了这一点；解析器额外容忍 JSON 体外面包一层 ```json 围栏。
- `height` 只是建议值。它用作 iframe 的初始高度；frame 会回报自身内容高度，卡片随内容增长。

## 标签在流式输出期间不会被剥离

未配对的标签会作为普通文本留在消息里（本仓未启用 `rehype-raw`，原始 HTML 不会被渲染），等闭合标签到达后再被卡片替换。JSON 体解析失败时同样保留为文本：解析不了的卡片绝不能无声吞掉整条消息。

## 配置

```yaml
interface:
  widgets: true
```

- Schema：`packages/data-provider/src/config.ts` 中的 `interfaceSchema`；默认 `true`。
- `loadDefaultInterface`（`packages/data-schemas/src/app/interface.ts`）会**逐 key 显式拷贝** interface 配置，所以新增的键必须同时加进这个函数，否则客户端永远看不到它。它正是 `/api/config` 发给客户端的那个对象，也是服务端注入时所依据的那个对象，因此两侧判定的是同一个值。
- 服务端读 `appConfig.interfaceConfig?.widgets !== false` 来决定是否注入指令；客户端读 `startupConfig.interface?.widgets !== false` 来决定是否注册渲染器。`undefined` 视为开启；功能关闭时，溜出来的标签按文本渲染。
- `librechat.yaml` 用 `.strict()` 校验，所以键必须先存在于 schema，运维才能设置它。

## 编译端点

`POST /api/widgets/generate` —— 需要 JWT 鉴权，带限流。

中间件链是 `requireJwtAuth` → `messageUserLimiter` → `configMiddleware` → `validateModel.json`。其中三个的作用超出表面：

- **`configMiddleware` 不是全局中间件。** 它挂在各个 router 上（见 `api/server/routes/agents/index.js:1142`），而 `req.config` 同时是 `validateModel` 里 `getEndpointsConfig` 和 handler 里 `getProviderConfig({ appConfig: req.config })` 的数据来源。漏挂它**不会显式报错** —— 它会静默地解析不到任何 endpoint 配置，于是自定义端点和用户自带的 key 双双失效。
- **用 `messageUserLimiter`，不是 `promptUsageLimiter`。** 后者是 prompts CRUD 的限流桶；一次编译属于模型调用，应计入 chat 路径使用的同一个按用户预算（`api/server/routes/agents/index.js:1160,1164`），这样失控的卡片与失控的对话消耗同样的配额，并走同一条 `MESSAGE_LIMIT` 违规处理路径。
- **用 `validateModel.json`，不是 `validateModel`。** chat 用的那个守卫经 `handleError`（`packages/api/src/utils/events.ts`）拒绝，而它写的是一个 SSE 帧、状态码停在 200 —— 这种「拒绝」在 JSON 客户端眼里是一次成功。`.json` 变体执行同一条规则，但返回状态码加一个 `error` 体。两者都建立在 `checkModelAccess`（`packages/api/src/endpoints/access.ts`）之上，所以两种响应形态不会各自漂移。

```jsonc
// 请求
{ "spec": "<widgetSpec.prompt 的文本>", "endpoint": "openAI", "model": "gpt-4o-mini" }
// 响应
{ "code": "function Widget() { … }" }
```

`endpoint` / `model` 由用户在卡片上选择，因此这次调用必须按 chat 路径同一套模型访问规则做授权。编译出的组件是单个函数体 —— 无 import、无网络访问 —— 以字符串返回；服务端不执行任何东西。

### 授权

路由挂载的是 `api/server/middleware/validateModel.js` 导出的 JSON 守卫 —— 规则与 `api/server/routes/assistants/chatV1.js:32` 在 chat 路径上执行的完全相同，只是换成 JSON 客户端读得懂的响应形态。它只读 `req.body.endpoint` 和 `req.body.model`，对 model 做 trim 和字符集校验，通过 `getModelsConfig` 解析该 endpoint 的模型目录，对目录中不存在的模型以 `ILLEGAL_MODEL_REQUEST` 违规拒绝。`userProvide: true` 的 endpoint 直接放行，因为凭据由用户自带，目录不是这里的权威。状态码随原因而定：标识符畸形是 400，endpoint 不提供的模型是 403，目录尚未加载是 503。

`buildEndpointOption` 是**刻意不挂**的：它是 chat 形态的（`parseCompactConvo`、model-spec preset、内容过滤、文件用量），并且期望一个本请求并不具备的会话信封。

### 卡片里的模型选择

卡片的模型选择器是 feature 内私有且只读的。它**不复用** `client/src/components/Chat/Menus/Endpoints/ModelSelector.tsx`：那个组件绑定在会话 store 上（它会把选中的模型写回当前会话），而从一个将来可能被抽离的 feature 里反向伸手去拿应用全局状态，正是客户端状态归属规则所禁止的。

选择器改为从既有的 `useGetEndpointsQuery()`（`client/src/data-provider/Endpoints/queries.ts:9`）读 endpoint 列表，从既有的 `useGetModelsQuery()`（`packages/data-provider/src/react-query/react-query-service.ts:190`，背后是 `/api/models`）读模型列表。两者都是只读的缓存读取 —— 不写任何会话状态，卡片除自身的编译 mutation 外不需要新的 query hook。编译结果在组件内按 `(endpoint, model, spec)` 缓存，所以消息重渲染不会重复计费一次编译。

### 模型调用

handler 从请求自身的 `req.config` 解析 provider 配置，发一次非流式调用 —— 这一形状已由 activity label 路径验证过（`packages/api/src/agents/activityLabels/host.ts` → `runtime.ts`）：

```ts
const providerConfig = getProviderConfig({ provider: endpoint, appConfig: req.config });
const options = await providerConfig.getOptions({
  req,
  endpoint,
  model_parameters: { model },
  db, // EndpointDbMethods —— 来自 ~/models 的 { getUserKey, getUserKeyValues }
});
const clientOptions = Object.fromEntries(
  Object.entries(options).filter(([key]) => !omitTitleOptions.has(key)),
);
// ...按 provider 处理的输出上限（见 label 路径）...
resolveConfigHeaders({ llmConfig: clientOptions, user, tenantId, body: ids });
const client = initializeModel({
  provider: options.provider ?? providerConfig.overrideProvider ?? endpoint,
  clientOptions: { ...clientOptions, streaming: false } as ClientOptions,
});
const response = await client.invoke(buildCodegenPrompt(spec), { signal });
const code = extractText(response?.content);
```

这里有五个细节是刻意继承的：

- **`omitTitleOptions` 净化。** `getOptions` 返回的是按整轮对话规模设定的生成参数；编译是一次有界的代码生成任务，所以按 title 与 label 路径同样的方式剥掉 chat 的输出上限，并换成一个适合组件的上限。
- **`db` 是那个只含两个方法的 endpoint 接口**，不是整个 models 模块 —— `getUserKey` / `getUserKeyValues` 正是「用户自带 API key」能工作的原因。缺了它们，凡是运维没有在服务端配好凭据的 endpoint，编译都会失败。
- **`resolveConfigHeaders` 在构造之前执行。** 依赖会话或用户元数据做代理鉴权的代理，在编译调用上同样需要这些头；否则这次调用在代理侧就是未鉴权的。它还会恢复 Anthropic 的 `clientOptions` 载体，那里装着保护用户自带 base URL 的 SSRF 安全 `fetchOptions` —— 丢掉它会重新打开 endpoint 校验本来要堵上的重定向与 DNS-rebind 路径。
- **`getProviderConfig` 读的是传进来的 `appConfig`，不是单例。** 模块从 `req.config` 取值，所以 handler 在测试里可以直接构造。
- **超时信号。** 调用由 `AbortSignal.timeout(...)` 兜底，provider 挂死时表现为一张报错的卡片，而不是一个永不返回的请求。

因为 endpoint 是**用户**的选择而非 agent 的，这里的 provider 可以和产出规格的那个 agent 不同 —— 这正是要点：便宜模型写规格，用户决定用哪个模型编译。

## 沙盒

卡片是一个 `<iframe sandbox="allow-scripts" src="/widget-runtime.html">`：

- **只有 `allow-scripts`，别无其他** —— 不给 `allow-same-origin`，因此 frame 运行在不透明源（opaque origin）中，够不到父文档、它的 cookie、存储与 DOM。
- **用同源的静态 runtime 文档，而不是 `srcdoc`。** `srcdoc` 文档会继承嵌入页面的 CSP；当运维开启 `CSP_ENABLED` 时策略是 `script-src 'nonce-…' 'strict-dynamic'`，它会拦掉 runtime 需要加载的每一个脚本，留下一个死掉的 frame。独立的静态文档不携带 shell 的策略，而 `frame-src 'self'` 仍然允许它。当前生产环境未开 CSP；这个选择让该功能在将来开启时依然可用。
- `widget-runtime.html` 放在 `client/public/`，由 `client/vite.config.ts` 里的 `copyPublicAssets` 插件复制进 `dist/`（生产构建设了 `publicDir: false`，所以 `public/` 下的东西不会被自动拷贝）。
- frame 内部再用 `<meta http-equiv="Content-Security-Policy">` 收紧策略：`default-src 'none'`、脚本只允许来自固定版本的库 URL、`connect-src 'none'`。meta 策略只能收窄文档的权限，而 `connect-src 'none'` 正是阻止生成代码把规格发到任何地方的那一条。
- **frame 内会加载 Tailwind**（`https://cdn.tailwindcss.com/<固定版本>`，与 artifact 管线同一个 CDN），因为代码生成指令承诺编译出的组件以 Tailwind 工具类作为它唯一的样式手段。

### 主题

frame **不会**继承宿主的主题：iframe 内的 `prefers-color-scheme` 跟随操作系统，而不是应用强制设置的主题，所以一个把应用设成暗色、系统却是亮色的用户会得到一张亮色卡片。

因此 frame 以 `darkMode: 'class'` 运行 Tailwind，并在自身根节点上切换 `dark`。这个标志由宿主提供：宿主从已渲染的文档根节点上读取解析后的 class（读的是渲染结果，而不是伸手去拿主题 store），随载荷一起发送，并在它变化时重发。代码生成指令要求模型把 `dark:` 变体写在同一元素上，所以卡片在两种主题下都成立。

### 消息协议（宿主 ↔ frame）

| 方向 | 消息 | 含义 |
|---|---|---|
| frame → 宿主 | `{ type: 'widget:ready' }` | runtime 已启动，等待载荷 |
| 宿主 → frame | `{ type: 'widget:render', code, dark }` | 编译并挂载，附带主题标志 |
| 宿主 → frame | `{ type: 'widget:theme', dark }` | 主题变化；无需重新挂载 |
| frame → 宿主 | `{ type: 'widget:height', height }` | 内容高度变化 |
| frame → 宿主 | `{ type: 'widget:error', message }` | 编译或渲染抛错 |

宿主只接受来自自身 iframe 的 `contentWindow` 的消息；frame 侧除 `*` 之外不信任宿主的 origin 字符串（它处在不透明源中，也不会收到任何机密）。

## 文件清单

新增：

| 路径 | 作用 |
|---|---|
| `packages/api/src/prompts/widgets/index.ts` | 协议指令 + 代码生成系统提示词 |
| `packages/api/src/widgets/generate.ts` | 单次非流式模型调用 |
| `packages/api/src/widgets/validate.ts` | 对返回代码的边界与合理性校验 |
| `packages/api/src/widgets/controller.ts` | 请求 handler |
| `packages/api/src/endpoints/access.ts` | 两个守卫共用的模型访问规则 |
| `api/server/routes/widgets.js` | 路由接线（鉴权、限流） |
| `client/src/components/Widgets/plugin.ts` | remark 插件：标签 → 节点 |
| `client/src/components/Widgets/GenerateWidget.tsx` | 卡片组件及其各状态 |
| `client/src/components/Widgets/frame.ts` | iframe 属性、runtime URL、宿主侧消息 reducer |
| `client/public/widget-runtime.html` | 沙盒文档 |

修改：

| 路径 | 改动 |
|---|---|
| `packages/api/src/agents/initialize.ts` | 在 artifacts 块之后追加上该指令 |
| `packages/data-provider/src/config.ts` | `interface.widgets` schema 字段 + 默认值 |
| `packages/data-schemas/src/app/interface.ts` | 把 `widgets` 拷进加载后的 interface 配置 |
| `packages/data-provider/src/api-endpoints.ts`、`data-service.ts`、`keys.ts` | endpoint、调用方、mutation key |
| `packages/data-provider/src/types.ts` | `TWidgetGenerateRequest` / `TWidgetGenerateResponse` |
| `packages/data-provider/src/react-query/react-query-service.ts` | `useGenerateWidgetMutation` |
| `api/server/routes/index.js`、`api/server/index.js` | 注册并挂载路由 |
| `api/server/middleware/validateModel.js` | 两个守卫改为建立在共用规则之上，并导出 JSON 形态 |
| `client/src/components/Chat/Messages/Content/markdownConfig.ts` | 注册插件与组件 |
| `client/vite.config.ts` | 把 `widget-runtime.html` 复制进 `dist/` |
| `client/src/locales/en/translation.json` | 卡片文案 |
| `librechat.example.yaml` | 记录该键 |

## 非目标

- 不做持久化。卡片只活在产出它的那条消息里；服务端不存任何东西。
- 不把交互回传进对话。点击与输入都留在 frame 内部。
- `MarkdownLite`（分享、subagent、steer、条款页）不支持卡片。那些视图渲染的是一组固定的、更窄的子集；标签在那边保持为普通文本。

## 验证

- 后端：指令构造器（开/关）、代码校验器、共用的模型访问规则、handler 的授权与错误路径各自的单元测试。
- 前端：一条携带完整标签的消息、一个仍在流式输出中的标签、一个 JSON 体损坏的标签，各自的渲染测试；外加消息协议 reducer 的单元测试。
- 本仓以 CI 为唯一的构建与测试权威；本地不做任何构建。
