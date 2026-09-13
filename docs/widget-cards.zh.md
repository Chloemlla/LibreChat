# 交互式卡片（Interactive Widget Cards）

> 英文版（canonical）见 [`widget-cards.md`](./widget-cards.md)。

模型的一次回复可以不返回散文，而返回一张**交互式卡片**：一张能点的坐标图、一个带滑块的仿真、一个小表单。这套机制与托管式助手平台的两层设计一致 —— 模型产出的是**规格说明（specification）**，再由一个独立的编译步骤把规格变成浏览器能跑的组件。

还有第二类卡片，它只在配置了某个 origin 之后才存在：模型发的是 **GeoGebra 命令**，图形交给一个自托管的 GeoGebra 小程序去画，跑在属于它自己的 origin 上的独立 frame 里。见 [GeoGebra 图卡](#geogebra-图卡)。

## 两层结构

**1. 协议层（提示词预注入）。** 每一轮 agent 调用都携带一段指令，告诉模型标签格式、JSON 结构，以及什么情况下值得发一张卡片。该指令在 `packages/api/src/agents/initialize.ts` 中追加到 agent 的 `additional_instructions`，就放在既有 artifacts 指令旁边，因此对每个 endpoint、每个运行时 agent 都生效。功能关闭时它是 `null`，所以关掉的部署不会发送任何东西。

**2. 渲染层（编译 + 沙盒）。** 客户端的 markdown 管线识别这个标签，向 `POST /api/widgets/generate` 发一次请求启动编译 —— 把规格说明编译成单文件 React 组件 —— 再轮询消息上存着的结果直到这次编译落定，然后把该组件挂载进一个沙盒 iframe。模型写出的任何内容都不会在应用自身的文档里被求值。

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

请求里带上卡片所在的那条消息，响应里带回这条消息已存的结果记录 —— 其中就有本次编译刚写下的那条，状态为 `pending`：

```jsonc
// 请求
{
  "messageId": "<承载标签的那条消息>",
  "spec": "<widgetSpec.prompt 的文本>",
  "endpoint": "openAI",
  "model": "gpt-4o-mini"
}
// 响应 —— 202，在编译开始之前就已作答
{
  "widgets": [
    { "spec": "…", "endpoint": "openAI", "model": "gpt-4o-mini", "status": "pending", "startedAt": 1757692800000 }
  ]
}
```

`endpoint` / `model` 由用户在卡片上选择，因此这次调用必须按 chat 路径同一套模型访问规则做授权。编译出的组件是单个函数体 —— 无 import、无网络访问 —— 编译尘埃落定后才写进结果记录的 `code`，依然是服务端不执行任何东西的一个字符串。

### 编译不留在请求里等

一次编译就是**一次非流式**模型调用，而非流式端点在整个调用结束之前不会往 socket 上写一个字节：调用持续多久 —— 这套机制所服务的部署里大约 107 秒 —— 连接上就多久没有任何数据流过。反向代理会把这段沉默判成上游挂死，而 nginx 的 `proxy_read_timeout` 默认值是 60 秒，于是请求在应用自己的预算还远远没用完的时候就被 `504` 结束了。所以编译根本不该待在请求里面。

端点只做「必须在作答之前发生」的事，顺序如下：

1. **校验与授权。** 就是上面那条中间件链，没有变化。
2. **取出消息并写下结果记录。** 请求里的 `messageId` 指名承载标签的那条消息；handler 用 `getMessage({ user, messageId })` 把它取出来 —— 同一次读取既确认了消息归属，也就完成了这次写入的授权 —— 为该 `(spec, endpoint, model)` 写入一条 `status: 'pending'` 的记录，存进消息的 `widgets` 子文档。
3. **以 `202` 返回 `{ widgets }`**，即这条消息当前存着的结果记录，刚写下的那条就在其中。
4. **把那一次编译作为分离的后台任务启动**，且必须等响应已经上线之后才启动，这样无论编译跑多久客户端都不会被挡住。该任务就地更新同一条记录：`ready` 并带上校验通过的 `code`，或 `failed` 并带上 `error`。它**永远不会 reject** —— provider 报错、超时、组件体被校验拒绝，三种结局都是落定的记录，不会留下无人处理的拒绝。

客户端在记录仍是 `pending` 期间轮询 `GET /api/messages/widgets/:messageId`，一旦落定就停止，所以在编译途中的刷新会接着显示加载态，而不是把卡片丢掉。

有三个后果值得点明：

- **重复编译浪费的是一次调用，不是把记录写坏。** 同一个规格、同一个 endpoint 与 model 上的两次启动请求都会真的跑起来，而它们落定的是同一条按 `(spec, endpoint, model)` 定位的记录 —— 写同一个键是**替换**那条记录，不是再追加一条，所以存下来的记录始终自洽，后落定的那次为准。正常情况下卡片也发不出第二次：编译在途时重新生成控件是禁用的。
- **落定之前会重新读一次消息。** 请求手里的那份消息是编译开始之前读的，而编译随后跑了好几分钟 —— 直接写回那份副本，就会丢掉这中间的任何一次写入，其中包括同一条消息上另一张卡片正好编译完成的那次。所以任务是等编译结束后重新读一遍消息，再往读到的内容里 upsert。
- **编译预算是安全网，不再是跟代理赛跑的截止线。** 调用仍由 `interface.widgetCompileTimeoutMs` 兜底（默认 120000 毫秒，上限 5 分钟），但它的职责变成了接住挂死的 provider：响应不再等它，它身后也没有代理超时。超出预算的编译以 `failed` 落定。

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
- **超时信号。** 调用由 `AbortSignal.timeout(...)` 兜底，provider 挂死时把记录落定为 `failed`，而不是让卡片永远停在加载态。

因为 endpoint 是**用户**的选择而非 agent 的，这里的 provider 可以和产出规格的那个 agent 不同 —— 这正是要点：便宜模型写规格，用户决定用哪个模型编译。

### 编译结果随消息落库

卡片是 markdown 组件，本地状态随卸载一并消失，而消息每次重渲染都会重新挂载它 —— 刷新页面就等于丢掉刚编译好的卡片。所以结果记录存在**产出这条标签的那条消息**上，编译请求里的 `messageId` 指的就是它：请求作答之前记录就已写下，卡片再按 `messageId` 通过那个 `GET` 读回来。正因为记录是先落成 `pending`、再就地落定的，一次在途的编译本身也在记录里，编译途中的刷新会接着显示加载态，而不会把卡片丢掉。

- **一条记录承载全部状态。** 每条记录为 `{ spec, endpoint, model, status, code?, error?, startedAt }`：spec 决定它属于哪张卡片，endpoint/model 是还原用户选择所必需的，`status` 取 `'pending' | 'ready' | 'failed'`，`code` 恰在编译为 `ready` 时存在、`error` 恰在为 `failed` 时存在，`startedAt` 是记录写下的时刻，单位是 epoch 毫秒。追加时最旧在前；同一个 `(spec, endpoint, model)` 再写一次会**替换**那条记录并移到末尾，所以末尾那条永远是用户最近一次的选择。超过 8 条从头部淘汰。
- **服务端是唯一的写者。** 原先挂在这条路径上的 `POST`、它的 data-service 调用与 mutation hook 都已移除，只剩那个 `GET`。留着一个不再使用的第二写者并不可行：它一旦与后台任务抢写，就可能拿一条过时的记录盖掉更新的 `pending`，于是存下来的记录描述的是一次并不在跑的编译。
- **`pending` 不会永远 pending。** 协议把任何一次编译上限定为 5 分钟（`WIDGET_COMPILE_TIMEOUT_HARD_MAX_MS`），所以一条超过这个天花板、再宽限一分钟仍是 `pending` 的记录不可能是还在跑 —— 它是进程在编译中途重启留下的孤儿。读路径把它推导为 `failed`，卡片据此渲染成可重试的错误。不需要任何清扫或修复：同一条 `(spec, endpoint, model)` 的下一次编译会替换掉它。
- **本次改动之前写下的记录读出来就是编译完成的。** 状态字段是随异步编译一起来的，所以更早的记录只有 `{ spec, endpoint, model, code }`。读路径把缺失的 `status` 归一为 `ready` —— 一条带着 code、又没有状态字段的记录，只可能出自一次已经跑完的编译。
- **卡片与消息只共享 id。** 卡片从 `MessageContext` 取 `messageId` 自己去读，而不是把整个消息对象穿过 `MessageRenderer`、`ContentParts` 与分享路径层层传下来。
- **还原只做一次，且不与用户抢。** 消息上已有落定的记录时，卡片采纳末尾那条的 endpoint/model 并直接挂载它的 code；用户已经动过选择器就不再还原，重新取数也不会让它重来一遍。
- **读不到就当作没有。** 消息的结果记录读不出来时，卡片按「消息上没有记录」处理，需要时自行编译；一条没送到的记录最多多花一次编译，绝不会变成错误态。
- **写失败不会把卡片晾住。** `pending` 记录写不下去时，请求在任何编译启动之前就以错误结束，因此没有任何模型调用被计费。而**落定**那一次写失败时，已经没有人等着应答了：它只被记进日志，记录停在 `pending`，由上面的过期规则把它变成可重试的失败。
- 授权与写入路径沿用 artifact 路由：`getMessage({ user, messageId })` 确认归属，只读线程由同一个 subagent 守卫拒绝，记录通过 `saveMessage` 写入。字段也随消息导出 —— `CLIENT_MESSAGE_SELECT` 是排除式投影，因此加进去的字段默认就在用户的导出里。
- GeoGebra 图卡不需要这一层：它的命令本来就在消息正文里，重渲染时从标签重新解析即可。

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

## GeoGebra 图卡

第二类卡片返回的不是 React 规格，而是一段 **GeoGebra 作图**。模型直接写 GeoGebra 自己的命令，客户端把命令交给一个自托管的 GeoGebra 小程序，跑在它自己 origin 上的独立 frame 里。用户得到的是一张活的小程序 —— 能操作、能读数 —— 而不是一张画出来的图。

两类卡片共用标签机制、空行规则和消息通道；它们**不共用沙盒**，而这个差别正是图卡必须显式开启的原因。

### 报文格式

````text
<GenerateGGB height="480px">
A=(1,2)
f(x)=x^2
Circle(A,3)
</GenerateGGB>
````

- **一行一条 GeoGebra 命令**，语法就是 GeoGebra 输入框接受的那种。块体是一份命令列表，不是 JSON：没有花括号、没有键，也没有描述这张图的散文。
- **块内不能有空行** —— 规则和原因都与第一类卡片相同。Markdown 以空行结束原始 HTML 块；块里出现空行会把标签和它的命令切断。
- `height` 只是建议值，与第一类卡片一样：图卡自身默认 320px，并被夹到 120–1200 之间。
- 指令要求模型把一张图控制在 40 条命令左右。客户端最多保留前 200 条，并丢弃任何超过 500 个字符的单条命令；只要有丢弃就会给出警告 —— 失控的生成会**看得见地**退化成一张不完整的图，而不是卡死 frame。
- 命令按顺序经 GeoGebra 的 `evalCommand` 执行，所以名字必须先定义后使用；applet 不认识的命令就是什么都不画。命令名在任何语言下都保持英文，跟着对话语言走的只有模型自己起的标签。
- 只有部署配置了 origin，`GenerateGGB` 才会被识别；否则标签保持为普通文本，和未配对的 widget 标签完全一样。

### 为什么这个 frame 必须有独立 origin

widget frame 是 `sandbox="allow-scripts"`，跑在不透明源里 —— 对**模型生成的 React 代码**来说这是正确的沙盒：里面的东西按定义就不可信。

图卡 frame 里跑的是**本部署自己托管的 bundle**，模型只提供命令字符串。但它仍然用不了不透明源：GeoGebra 的 GWT 引导（`web3d.nocache.js`）会把模块装进一个隐藏的**同源子 frame**，而在不透明源下访问那个子 frame 的 `document` 会抛 `SecurityError`，applet 根本起不来。所以这个 frame 是 `sandbox="allow-scripts allow-same-origin"`。

对一份与应用同源的文档来说，这一对权限等于没有沙盒：frame 能读到 `parent.document.title` 和 `parent.document.cookie`。解法不是把沙盒改松，而是**把 frame 挪到别的地方**：改从 `https://ggb.example.com` 提供之后，真正的同源策略开始生效，applet 伸向应用 DOM 与 cookie 的尝试会以 `SecurityError: Blocked a cross-origin frame` 失败，而 GeoGebra 自身照常工作。

**不要把 `allow-same-origin` 抄到 widget frame 上。** 那里的代码由模型输出生成，这个权限等于把应用整个交给它。

### 配置

```yaml
interface:
  geogebraOrigin: 'https://ggb.example.com'
```

- Schema：`packages/data-provider/src/config.ts` 里的 `geogebraOriginSchema`。可选，且**刻意不给默认值**。
- **不配置就等于没有这个能力。** 服务端不注入指令（origin 未配置时 `generateGeogebraPrompt` 返回 `null`），客户端也不注册渲染器。没有第二个开关：origin 本身就是开关。
- 取值必须是 http(s) 的 **origin**：不能带路径、查询串、fragment 或凭据。客户端用它拼 frame 的 `src`，也用它给发进 frame 的消息定址；别的形态要么把 frame 放到运维没打算放的地方，要么让 runtime 的 URL 拼不出来。非 http 协议同理拒绝。结尾的斜杠会被接受并剥掉，因为客户端会在这个值后面拼固定路径。
- 允许 `http://`，不是只准 `https://`。这里的安全属性是 origin 隔离，不是传输加密，而 `http://localhost:3099` 正是本地联调 runtime 的常规做法。
- `loadDefaultInterface`（`packages/data-schemas/src/app/interface.ts`）会像其他键一样把它拷进加载后的 interface 配置；未配置时 `removeNullishValues` 会把键丢掉，于是「没有值」保持为没有值，而不会变成一个空字符串。

### 部署侧要做什么

applet 不从 GeoGebra 的 CDN 加载任何东西 —— frame 自身的 meta CSP 是 `default-src 'none'`，脚本只允许来自它所托管的那个 origin —— 所以 runtime 在构建期拉取、自托管：

1. **构建客户端。** `client/scripts/ggb/fetch.mjs` 下载固定版本的 GeoGebra math-apps 包（`geogebra-math-apps-bundle-5-4-929-3.zip`，约 33 MB），只铺开文档用到的部分 —— `deployggb.js`、`HTML5/5.0/web3d/`、`HTML5/5.0/css/` —— 放进 `client/public/geogebra/`。`HTML5/5.0/web3d/` 这层目录深度是**关键**：`deployggb.js` 从路径推导模块名，所以这棵树必须按原样提供。语言文件裁剪到只留 `en` 与 `zh-CN`。它挂在客户端的 `prebuild` 上，所以构建不可能漏掉 runtime 还悄悄成功：下载失败会直接让构建失败，而不是产出一个到处 404 的 runtime。`SKIP_GGB_FETCH=1` 可显式跳过；拉下来的这棵树已在 gitignore 里。
2. **拷进 `dist/`。** `client/vite.config.ts` 里的 `copyPublicAssets` 插件把 `client/public/ggb-runtime.html` 和 `client/public/geogebra/` 复制进 `client/dist/`（生产构建设了 `publicDir: false`，`public/` 下的东西不会被自动拷贝）。
3. **在那台子域名的根路径上提供这两个路径** —— `ggb-runtime.html` 与 `geogebra/…` —— 让 `https://ggb.example.com/ggb-runtime.html` 和 `https://ggb.example.com/geogebra/…` 都能解析。这一步才是沙盒成立的前提：浏览器必须看到两个不同的 origin。它只是一次静态文件拷贝 —— 不需要服务端渲染、不需要 API、不需要反代，也不需要本仓应用 origin 上的任何东西。
4. **把 `interface.geogebraOrigin` 指向这个 origin**，不带路径。
5. **若开了 `CSP_ENABLED`、而该 origin 是明文 `http://`**，应用的 `frame-src` 必须放行它：默认策略是 `'self' https: blob: data: about:`，能覆盖任何 `https:` 的图卡 origin，却会拦掉 `http://localhost:…`。用 `CSP_FRAME_SRC_EXTRA`（按指令粒度的环境变量覆盖）加上去，而不是放宽默认值。CSP 默认关闭，所以本地开发不受影响。这个失败模式值得先知道：被拦下的 frame 根本不会启动，`ggb:ready` 永不到达，卡片就一直停在加载态，界面上没有任何地方说明原因。

### 命令是不可信输入

标签块里的内容全是模型输出，因此在每一跳都按不可信输入对待：服务端既不解析也不执行它；frame 内每一行都交给 GeoGebra 的命令解释器 `evalCommand`，绝不交给 `eval`、`Function` 或 script 标签。frame 的 meta CSP 以 `default-src 'none'` 打底，发起连接这一项只放行 `'self'` —— 那一条是给 loader 取本 origin 上的 `<hash>.cache.js` 用的，指向别处的地址一个都不在允许列表里，所以哪怕某条命令能被诱导去外发，构造也发不出任何东西。

### geograba：工作台，与运行时的来源

[geograba](https://github.com/Chloemlla/GeoGebra-Script-Lab) 是这条链路的上游前端：一个 Vite + React 的 GeoGebra 脚本工作台，带 Monaco 编辑器、控制面板与日志面板。人用它写一条构造、看它画出来、把错误一条条改掉；本仓负责把同一条构造渲染进对话。图卡 runtime 与它走的是同一套流程：

| geograba | 这一层做什么 | 图卡 runtime 里的对应物 |
|---|---|---|
| `src/engine/Preprocessor.js` | 去注释、滤空行、括号与赋值语法校验、变量依赖提取、风险函数与嵌套深度告警 | `stripComment` 与逐条取舍 |
| `src/engine/Dispatcher.js` | 顺序执行、逐条收集错误、进度回调、30 秒执行预算 | `runCommands` 的循环与 `EXECUTION_TIMEOUT` |
| `src/engine/GeoGebraEngine.js` | 异步起 applet、隐藏原生工具栏、强制英文 API、对象状态回写 | `appletOnLoad` 拿到实例后发 `ggb:ready` |

两者真正分开的地方是**信任模型**，有两处值得记住：

- **命中危险模式之后怎么办。** 工作台的输入是人敲的，所以 `Preprocessor.clean` 命中一条 `DANGEROUS_PATTERNS` 就抛错、整批不执行 —— 作者改掉重来即可。图卡面对的是模型输出，一票否决会让一条坏命令吞掉整张已经画对一半的图，所以 runtime 改成**跳过该条、并入警告**，其余命令照跑。
- **事件处理器那条正则。** 工作台用 `on\w+\s*=`；图卡收紧成一张事件名白名单。因为 `on\w+` 会把合法的 GeoGebra 标签（例如 `one=`）判成 XSS 风险，而那条命令本身毫无问题。

**要把 geograba 直接当成 frame 的 runtime 用**，得先在它那边补三件事，缺一件都不成立：

1. **一个只接收命令的入口。** 仓库里目前没有任何 `postMessage` 或 iframe 桥接 —— 它是一整个编辑器应用，没有「只画一张图，不要编辑器、认证和后端」的页面。图卡需要的正是这样一份文档（形态同 `ggb-runtime.html`），并且要放在能被当作 `ggb-runtime.html` 取到的路径上。
2. **CSP 对齐。** geograba 现在从 `https://www.geogebra.org/apps/deployggb.js` 取 applet，`index.html` 的策略也放行 `geogebra.org`；图卡 frame 则是 `default-src 'none'` 且脚本只来自自己的 origin。要么把这棵 bundle 自托管到那个子域（同 `fetch.mjs` 的做法），要么改写策略 —— 而后者等于让出 `default-src 'none'` 这条底线。
3. **丢掉应用外壳。** 工作台带认证、后端代理与管理台；这些在卡片 frame 里既用不上，也不该出现在那个 origin 上。

所以现在的分工是：**geograba 是上游与联调工具，`ggb-runtime.html` 是同一套流程在不可信输入下的最小实现** —— 语义一致，加固策略不同。真要挂 geograba 的构建产物，先把上面三步做完，再改 `interface.geogebraOrigin`。

## 文件清单

新增：

| 路径 | 作用 |
|---|---|
| `packages/api/src/prompts/widgets/index.ts` | 协议指令 + 代码生成系统提示词 |
| `packages/api/src/widgets/generate.ts` | 单次非流式模型调用 |
| `packages/api/src/widgets/job.ts` | 分离的后台编译任务与它的两条落定路径 |
| `packages/api/src/widgets/validate.ts` | 对返回代码的边界与合理性校验 |
| `packages/api/src/widgets/results.ts` | 结果记录的解析、追加去重与上限；读 handler，以及过期推导与旧记录归一 |
| `packages/api/src/widgets/results.spec.ts` | 上述解析、追加与结果 handler 的测试 |
| `packages/api/src/widgets/controller.ts` | 请求 handler：写下 `pending` 记录、作答 `202`、启动后台任务 |
| `packages/api/src/endpoints/access.ts` | 两个守卫共用的模型访问规则 |
| `api/server/routes/widgets.js` | 路由接线（鉴权、限流） |
| `client/src/components/Widgets/plugin.ts` | remark 插件：标签 → 节点 |
| `client/src/components/Widgets/GenerateWidget.tsx` | 卡片组件及其各状态 |
| `client/src/components/Widgets/GenerateGGB.tsx` | 图卡组件及其各状态 |
| `client/src/components/Widgets/Tag.tsx` | 卡片开关关闭时回退显示的标签原文 |
| `client/src/components/Widgets/frame.ts` | iframe 属性、runtime URL、宿主侧消息 reducer |
| `client/public/widget-runtime.html` | 沙盒文档 |
| `client/scripts/ggb/fetch.mjs` | 构建期拉取、铺开并裁剪 GeoGebra bundle |
| `client/public/ggb-runtime.html` | 图卡 frame 文档 |
| `client/public/geogebra/` | 自托管的 GeoGebra runtime —— 由上面的脚本生成，不是源码 |

修改：

| 路径 | 改动 |
|---|---|
| `packages/api/src/agents/initialize.ts` | 在 artifacts 块之后追加指令 |
| `packages/api/src/prompts/widgets/index.ts` | GeoGebra 指令构造器 |
| `packages/data-provider/src/config.ts` | `interface.widgets` schema 字段 + 默认值；`interface.geogebraOrigin`，可选且无默认值 |
| `packages/data-schemas/src/schema/message.ts`、`src/types/message.ts` | 消息上的 `widgets` 子文档与 `IMessage.widgets` |
| `api/server/routes/messages.js` | `GET /api/messages/widgets/:messageId`，注册在参数化 GET 之前；结果路径上的 `POST` 已移除 |
| `packages/data-schemas/src/app/interface.ts` | 把 `widgets` 与 `geogebraOrigin` 拷进加载后的 interface 配置 |
| `packages/data-provider/src/api-endpoints.ts`、`data-service.ts`、`keys.ts` | 编译端点与结果 `GET` 及其调用方与 key；回存路径已移除 |
| `packages/data-provider/src/types.ts` | `TWidgetGenerateRequest`；`TWidgetCompileStatus`；`TStoredWidget` / `TWidgetResultsResponse`；`TWidgetGenerateResponse` |
| `packages/data-provider/src/react-query/react-query-service.ts` | `useGenerateWidgetMutation`；`useGetWidgetResultsQuery`，记录为 `pending` 期间由卡片传入轮询间隔；回存 mutation 已移除 |
| `api/server/routes/index.js`、`api/server/index.js` | 注册并挂载路由 |
| `api/server/middleware/validateModel.js` | 两个守卫改为建立在共用规则之上，并导出 JSON 形态 |
| `client/src/components/Chat/Messages/Content/markdownConfig.ts` | 注册两套插件与两个组件 |
| `client/src/components/Widgets/index.ts` | 把图卡组件与 widget 组件一起导出 |
| `client/src/components/Widgets/GenerateWidget.tsx` | 记录为 `pending` 期间轮询本消息的结果，并按末尾记录还原 endpoint 与 model；不再回存结果 |
| `client/vite.config.ts` | 把 `widget-runtime.html`、`ggb-runtime.html` 与 `geogebra/` 复制进 `dist/` |
| `client/src/locales/en/translation.json` | 卡片文案 |
| `librechat.example.yaml` | 记录 `interface` 下的各键，含编译预算 |

## 非目标

- **不持久化交互。** 编译出的卡片结果会随消息落库（见[编译结果随消息落库](#编译结果随消息落库)），但点击、滑块、输入这些 frame 内部的交互状态不落库：刷新之后卡片回到它被编译时的状态。图卡没有可落库之物 —— 命令本来就在消息正文里。
- 不把交互回传进对话。点击与输入都留在 frame 内部。
- `MarkdownLite`（分享、subagent、steer、条款页）不支持卡片。那些视图渲染的是一组固定的、更窄的子集；标签在那边保持为普通文本。

## 验证

- 后端：指令构造器的单元测试（widget 开/关；GeoGebra 配置了 origin 与没配两种情况）、代码校验器、共用的模型访问规则、handler 的授权与错误路径。围绕编译生命周期的测试覆盖这台状态机：响应之前先写下的 `pending` 记录、两条落定路径（`ready` 带 `code`、`failed` 带 `error`）、把超龄 `pending` 读成 `failed` 的过期推导、把旧记录读成 `ready` 的归一，以及结果记录的解析、追加去重与上限。
- 前端：一条携带完整标签的消息、一个仍在流式输出中的标签、一个 JSON 体损坏的标签，各自的渲染测试；消息协议 reducer 的单元测试；以及卡片在消息已带落定记录时直接挂载、记录为 `pending` 期间轮询、还原选择，和把 `failed` 记录渲染成可重试错误这几条。
- 本仓以 CI 为唯一的构建与测试权威；本地不做任何构建。CI 覆盖编译、类型与单测，**覆盖不到浏览器里的实际渲染** —— 「刷新后卡片仍在」「编译途中刷新会接着显示加载态」这类端到端行为需要在部署后人工确认一次。
