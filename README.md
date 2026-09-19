# LibreChat

<p align="center">
  <a href="https://librechat.ai">
    <img src="client/public/assets/logo.svg" height="256">
  </a>
  <h1 align="center">
    <a href="https://librechat.ai">LibreChat</a>
  </h1>
</p>


<p align="center">
  <strong>中文</strong> ·
  <a href="https://github.com/danny-avila/LibreChat/blob/main/README.md">English (upstream)</a>
</p>

<p align="center">
  <a href="https://discord.librechat.ai"> 
    <img
      src="https://img.shields.io/discord/1086345563026489514?label=&logo=discord&style=for-the-badge&logoWidth=20&logoColor=white&labelColor=000000&color=blueviolet">
  </a>
  <a href="https://www.youtube.com/@LibreChat"> 
    <img
      src="https://img.shields.io/badge/YOUTUBE-red.svg?style=for-the-badge&logo=youtube&logoColor=white&labelColor=000000&logoWidth=20">
  </a>
  <a href="https://docs.librechat.ai"> 
    <img
      src="https://img.shields.io/badge/DOCS-blue.svg?style=for-the-badge&logo=read-the-docs&logoColor=white&labelColor=000000&logoWidth=20">
  </a>
  <a aria-label="Sponsors" href="https://github.com/sponsors/danny-avila">
    <img
      src="https://img.shields.io/badge/SPONSORS-brightgreen.svg?style=for-the-badge&logo=github-sponsors&logoColor=white&labelColor=000000&logoWidth=20">
  </a>
</p>

<p align="center">
<a href="https://railway.com/deploy/librechat-official?referralCode=HI9hWz&utm_medium=integration&utm_source=readme&utm_campaign=librechat">
  <img src="https://railway.com/button.svg" alt="Deploy on Railway" height="30">
</a>
<a href="https://zeabur.com/templates/0X2ZY8">
  <img src="https://zeabur.com/button.svg" alt="Deploy on Zeabur" height="30"/>
</a>
<a href="https://template.cloud.sealos.io/deploy?templateName=librechat">
  <img src="https://raw.githubusercontent.com/labring-actions/templates/main/Deploy-on-Sealos.svg" alt="Deploy on Sealos" height="30">
</a>
</p>

## 🌟 本分支增强（SynapticArch Fork）

这是 [danny-avila/LibreChat](https://github.com/danny-avila/LibreChat) 的一个持续跟进型分支：上游 `main` 每天自动同步进来，本分支自己的改动都叠在同步结果之上（个别上游提交会被有意回退或替换，见仓库提交历史）。在完整继承 LibreChat 全部能力的前提下，本分支额外做了五组东西——**让模型能直接在聊天里生成可交互的卡片**、**让管理员在界面上编辑数据库中的配置覆写**、**把本应用变成 OAuth 2.0 授权服务器**、**给注册与登录加上人机校验**，以及**一整套自己的 Docker 构建与发布流水线**。下面逐项说明你能得到什么、以及怎么打开它。

### 🧩 交互式卡片：模型直接产出可运行的组件

模型不再只能用文字和 Markdown 回答。当它想给出一张图、一个带滑块的模拟、一个小表单时，会发出一个标签，客户端把标签编译成一个单文件 React 组件，挂进沙箱 iframe 里跑——模型写的东西**永远不会**在应用自身的文档里求值。

- **协议层**：模型在正文后单独一行发出 `<GenerateWidget height="600px">` 标签，标签体是一个只含 `widgetSpec.prompt` 的 JSON 对象。提示词定义在 `packages/api/src/prompts/widgets/index.ts`，由 `packages/api/src/agents/initialize.ts` 追加到 agent 的 `additional_instructions`，因此对每个端点、每个运行时 agent 都生效；未启用时该提示词为 `null`，禁用的部署不会向模型发送任何东西。
- **编译层**：`POST /api/widgets/generate`（`api/server/routes/widgets.js`，实现见 `packages/api/src/widgets/`）。这个接口**只负责排队**：先往消息里写一条 `pending` 记录，然后立刻返回 `202`，真正的编译在后台跑（`packages/api/src/widgets/job.ts` 的 `runWidgetCompile`）。这是刻意的设计——一次编译可能跑上一两分钟，同步等待会被网关掐成 504。
- **结果持久化**：编译结果存在消息的 `widgets` 数组上（`packages/data-schemas/src/schema/message.ts`），状态为 `pending` / `ready` / `failed`。刷新页面卡片还在，不会随客户端内存一起消失；客户端在有条目处于 `pending` 时按轮询间隔拉取结果。
- **编译预算可配**：`interface.widgetCompileTimeoutMs`，默认 `120000` ms（`WIDGET_COMPILE_TIMEOUT_DEFAULT_MS`），硬上限 `300000` ms（`WIDGET_COMPILE_TIMEOUT_HARD_MAX_MS`）；配得比上限大不会报错，而是被夹到上限。这个上限来自 `AbortSignal.timeout` 的 32 位计时器边界，超过它中止会在下一个 tick 触发而不是等满时间。
- **总开关**：`interface.widgets`，默认 `true`。
- **GeoGebra 图形卡片**：第二个标签 `<GenerateGGB height="480px">` 让模型直接写 GeoGebra 命令（一行一条），返回一个能拖动、能读数、能操作的实时图形，而不是一张画好的静态图。它和上面的卡片共用标签机制与消息链路，但**不共用沙箱**——这段运行时需要一个独立域名的 GeoGebra applet，所以它**默认关闭**：只有配置了 `interface.geogebraOrigin`（一个不含路径、查询串和凭据的 http(s) origin，例如 `https://ggb.example.com`）时，标签才会被渲染成卡片，否则原样留作文本。

完整设计说明见 [`docs/widget-cards.md`](./docs/widget-cards.md)（中文版 [`docs/widget-cards.zh.md`](./docs/widget-cards.zh.md)）。

### 🛠 管理端配置覆写页面 + 客户端能力接口

- **在界面上改配置**：设置 → 通用 里多了一个配置覆写页面（`client/src/components/Nav/SettingsTabs/General/AdminConfig.tsx` 及同目录 `overrides/` 下的 `Detail.tsx`、`Dialogs.tsx`、`Sets.tsx`），可以浏览、新增、改写、重置和删除数据库里存着的配置覆写，不必再去手工编辑 `librechat.yaml` 然后重启。入口按 `SystemCapabilities.ACCESS_ADMIN` 显示。
- **后端接口**：处理器在 `packages/api/src/admin/config.ts`，路由挂在 `api/server/routes/admin/config.js`。
- **客户端能读到自己的权限**：新增 `GET /api/user/capabilities`（路由 `api/server/routes/user.js`，实现 `packages/api/src/capabilities/index.ts`），返回调用者自己持有的基础能力清单。前端通过 `client/src/hooks/useHasCapability.ts` 读取，行为是**失败即拒绝**：加载中、请求出错、未登录一律返回 false——少显示一个入口用户可以刷新恢复，多显示一个不该显示的入口不行。
- **启动期读到的是合并配置**：启动消费者读的是「YAML 基础 + 管理面板写入的 `__base__` 覆写」合并后的结果，所以管理端保存的配置在下次启动就会生效，而不是被静默忽略；但决定各 worker 加载哪些模块的那一部分**仍然只读基础配置**，一个 `__base__` 覆写不该决定每个进程导入什么（见 `api/server/index.js` 与 `api/server/experimental.js`）。

### 🔐 Synapse OAuth 2.0 Provider

本分支把 LibreChat 本身变成了一个 OAuth 2.0 授权服务器，第三方应用可以走授权码模式接入，拿到 token 后用 `Authorization: Bearer <access_token>` 调用被授权的 API。

- 授权主体必须是本实例已存在的用户，且当前角色为 `admin` 或 `trusted`；普通用户打不开授权页也不能同意授权。
- 授权用户之后被降级、封停或删除时，已签发的 access token 在校验阶段即失效。
- 不开放后台通配权限 `*`，第三方只能使用客户端登记过的 identity scope 与明确列出的 API scope。
- 实现位于 `packages/api/src/oauth/provider/`，路由 `api/server/routes/oauthProvider.js`，数据模型在 `packages/data-schemas/src/schema/oauth.ts`。接入说明见 [`docs/synapse-oauth-integration.md`](./docs/synapse-oauth-integration.md)。

### 🛡 Turnstile 人机校验

注册与登录路径接入 Cloudflare Turnstile：`api/server/middleware/validateTurnstile.js` 挂在 `api/server/routes/auth.js` 的注册/登录路由上——未配置时直接放行并记 debug 日志，配置后校验 token 并在失败时拒绝；前端由 `client/src/utils/turnstileConfig.js` 读取 `startupConfig.turnstile`（`siteKey` 与 `options`）来初始化组件。全部由配置驱动，不配置就等于没有这层。

### 🚀 本分支自己的构建与发布流水线

- **构建发布**：`.github/workflows/build.yml` 构建镜像后打两个标签推送到镜像仓库——`<分支名>-amd64` 和 `<短 SHA>-amd64`，随后在同一次运行中执行 `scripts/deploy_image.js`，通过 SSH 把新镜像发布到目标主机。固定 `linux/amd64` 平台，标签带 `-amd64` 后缀是为了让发布脚本拿到一个不会在架构间混淆的确定引用。
- **上游同步**：`.github/workflows/sync.yml` 每天定时从 `danny-avila/LibreChat` 的 `main` 同步，并做同步结果检查。
- **合并验证**：`.github/workflows/fork-verification.yml` 对合并后的树做全量工作区构建、TypeScript 类型检查和分组回归测试——上游不保证跑过这些用例，本分支把「合进来的代码到底编不编得过」变成一道必过的门。

---

# ✨ 功能

- 🖥️ **用户界面与体验**：受到 ChatGPT 启发，具有增强的设计和功能

- 🤖 **AI 模型选择**：
  - Anthropic (Claude)、AWS Bedrock、OpenAI、Azure OpenAI、Google、Vertex AI、OpenAI Assistants API (包括 Azure)、OpenAI Responses API (含 Azure)
  - [自定义端点](https://www.librechat.ai/docs/quick_start/custom_endpoints)：无需代理即可使用任何兼容 openAI 的 API
  - 兼容 [本地与远程 AI 提供商](https://www.librechat.ai/docs/configuration/librechat_yaml/ai_endpoints):
    - Ollama、[AMD Lemonade](https://lemonade-server.ai/)、groq、Cohere、Mistral AI、Apple MLX、koboldcpp、together.ai、
    - OpenRouter、Helicone、Perplexity、ShuttleAI、Deepseek、Qwen 等

- 🔧 **[代码解释器 API](https://www.librechat.ai/docs/features/code_interpreter)**：
  - 安全、沙箱执行，支持 Python、Node.js (JS/TS)、Go、C/C++、Java、PHP、Rust 和 Fortran
  - 无缝文件处理：直接上传、处理和下载文件
  - 无隐私问题：完全隔离和安全的执行
  - 开源且可自托管：由 [ClickHouse/code-interpreter](https://github.com/ClickHouse/code-interpreter) 驱动

- 🔦 **代理和工具集成**：
  - **[LibreChat 代理](https://www.librechat.ai/docs/features/agents)**：
    - 无需代码的自定义助手：构建专业化的 AI 驱动助手，无需编码
    - 代理市场：发现并部署社区构建的代理
    - 协作共享：把代理分享给指定的用户和用户组
    - 灵活和可扩展：可使用 MCP 服务器、工具、文件搜索、代码执行等
    - [Skills](https://www.librechat.ai/docs/features/skills)：创建可复用的 `SKILL.md` 指令包，用于手动、自动或常驻的代理工作流
    - [Agent Plugins](https://www.librechat.ai/docs/features/agent_plugins)：以实验性方式把部署级 Skills 和 MCP 服务器打包成启动期加载的插件包
    - [Subagents](https://www.librechat.ai/docs/features/subagents)：把聚焦的工作委派给拥有独立上下文窗口的隔离子代理运行
    - Agent Management API：用绑定部署的 OIDC 客户端自动化代理、文件与 Skill 的管理
    - 附加代码工作区：让代理在受管或个人工作区中查看、搜索、编辑并运行命令（高度实验性）
    - 兼容自定义端点、OpenAI、Azure、Anthropic、AWS Bedrock、Google、Vertex AI、Responses API 等
    - 支持 [模型上下文协议 (MCP)](https://modelcontextprotocol.io/clients#librechat) 的工具
  - 使用 LibreChat 代理和 OpenAI 助手与文件、代码解释器、工具和 API 操作

- 🪄 **带有代码工件的生成 UI**：
  - [代码工件](https://youtu.be/GfTj7O4gmd0?si=WJbdnemZpJzBrJo3) 允许在聊天中直接创建 React、HTML 和 Mermaid 图

## 🚀 v0.8.8-rc3 更新亮点

- **Agent 管理 API（beta）：** 创建、发现、更新和删除 Agent；管理 Agent 文件与 Skills；并通过绑定部署的 OIDC 身份认证机器客户端，同时保留既有的角色与 Agent 访问控制。
- **附加工作区（高度实验性）：** 为每个受管或个人代码工作器选择或保存按 Agent 划分的默认工作区，然后让 Agent 查看目录树、读取和搜索文件、编写改动，并以有时限的方式运行 Bash。个人工作器支持有限的自助注册、就绪状态和按 Agent 配置的 Git 身份。
- **后台工具控制：** 可选择取消普通的后台工具（包括附加的 Bash），同时保持分离的 Subagent 执行不受影响。
- **代码审批控制：** 在管理员允许的前提下，对文件写入和命令执行选择 **Ask**（询问）、**Allow**（允许）或 **Deny**（拒绝），并为可信的附加环境提供 **Full access**（完全访问）模式。File Search 和 Run Code 同样遵循角色授权。
- **手动上下文压缩：** 在上下文窗口填满之前先发起一轮只做摘要的对话，并按部署的摘要策略保留最近的对话内容。
- **上下文用量：** 查看对话、保留的工具流量、Agent 指令、缓存、成本与剩余余量，且不会重复计算类别之间的包含关系。
- **统一附件：** 上传一次，由 LibreChat 决定把内容送给模型还是送给抽取出的文本，并且只在需要时才提供 File Search 和 Code 工具。
- **模型：** 为 OpenAI 与 Agents 端点新增 GPT-6 Astra，支持 Responses API 路由与工具调用。
- **Agent 与聊天界面：** 统一工具活动、推理、搜索与 Agent 工作流；为会话和收藏新增一个可拖动的置顶分区；状态图标可形变；新增高对比度主题；支持富文本消息复制；侧边栏标题更清晰；实时阶段布局更精致。
- **可观测性：** 通过 OpenTelemetry 导出关联的应用日志；配置允许列表内的 Langfuse trace 身份与元数据；为浏览器诊断信息打上客户端构建 ID；把 Insights 限定到已授权的 Agent。
- **可靠性与安全：** 强化 Agent 续跑与检查点恢复、Redis 存活检测、DocumentDB 协调、OpenID 与 MCP OAuth 会话、分享链接限流、租户隔离、附件边界以及上传错误处理。

阅读 [v0.8.8-rc3 完整更新日志](https://www.librechat.ai/changelog/v0.8.8-rc3)。

- 💬 **多模态与文件交互**：
  - 上传并分析图像，支持 Claude 3、GPT-4o、o1、Llama-Vision 和 Gemini 📸
  - 与文件聊天，支持自定义端点、OpenAI、Azure、Anthropic、AWS Bedrock 和 Google 🗃️

- 🌎 **多语言用户界面**：
  - 英语、中文、德语、西班牙语、法语、意大利语、波兰语、巴西葡萄牙语
  - Русский、日语、瑞典语、韩语、越南语、繁体中文、阿拉伯语、土耳其语、荷兰语、希伯来语

- 🎨 **图像生成与编辑**
  - 使用 [GPT-Image-1](https://www.librechat.ai/docs/features/image_gen#1--openai-image-tools-recommended) 进行文本到图像和图像到图像的转换。
  - 使用 [DALL-E (3/2)](https://www.librechat.ai/docs/features/image_gen#2--dalle-legacy)、[Stable Diffusion](https://www.librechat.ai/docs/features/image_gen#3--stable-diffusion-local)、[Flux](https://www.librechat.ai/docs/features/image_gen#4--flux) 或任何 [MCP 服务器](https://www.librechat.ai/docs/features/image_gen#5--model-context-protocol-mcp) 进行文本到图像的生成。
  - 从提示生成惊艳的视觉效果或通过单一指令精炼现有图像。

- 📥 **导入与导出对话**：
  - 从 LibreChat、ChatGPT、Chatbot UI 导入对话
  - 导出对话为截图、markdown、文本、json

- 🔍 **搜索与发现**：
  - 搜索所有消息/对话

- 👥 **多用户与安全访问**：
  - 多用户、安全认证，支持 OAuth2、LDAP 和邮箱登录
  - 内置内容审核与 token 花费工具

- ⚙️ **配置与部署**：
  - 配置代理、反向代理、Docker 和多种部署选项
  - 可完全本地使用或在云端部署

- 📖 **开源与社区**：
  - 完全开源与公众构建
  - 社区驱动的开发、支持与反馈

[有关我们功能的详细审查，请查看我们的文档](https://docs.librechat.ai/) 📚

---

## 🪶 用 LibreChat 完成一站式的 AI 对话

LibreChat 将助理 AI 的未来与 OpenAI 的 ChatGPT 革命性技术结合在一起。庆祝原创样式，LibreChat 使您能够集成多个 AI 模型。它还集成并增强了原始客户端的功能，如对话和消息搜索、提示模板和插件。

使用 LibreChat，您不再需要选择 ChatGPT Plus，而可以使用免费的或按调用计费的 API。我们欢迎对这个高级聊天平台的贡献、克隆和分叉，以增强其能力。

![查看视频](https://raw.githubusercontent.com/LibreChat-AI/librechat.ai/main/public/images/changelog/v0.7.6.gif)
单击缩略图以观看视频☝️

---

## 🌐 资源

**GitHub 仓库：**
  - **RAG API:** [github.com/danny-avila/rag_api](https://github.com/danny-avila/rag_api)
  - **网站:** [github.com/LibreChat-AI/librechat.ai](https://github.com/LibreChat-AI/librechat.ai)

---

## 📝 更新日志

通过访问发行页面和说明来保持对最新更新的了解：
- [发行版](https://github.com/danny-avila/LibreChat/releases)
- [更新日志](https://www.librechat.ai/changelog)

**⚠️ 请在更新之前参阅 [更新日志](https://www.librechat.ai/changelog) 以了解重大变更。**

---

## ⭐ 星标历史

<p align="center">
  <a href="https://star-history.com/#danny-avila/LibreChat&Date">
    <img alt="星标历史图" src="https://api.star-history.com/svg?repos=danny-avila/LibreChat&type=Date&theme=dark" onerror="this.src='https://api.star-history.com/svg?repos=danny-avila/LibreChat&type=Date'" />
  </a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/4685" target="_blank" style="padding: 10px;">
    <img src="https://trendshift.io/api/badge/repositories/4685" alt="danny-avila%2FLibreChat | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/>
  </a>
  <a href="https://runacap.com/ross-index/q1-24/" target="_blank" rel="noopener" style="margin-left: 20px;">
    <img style="width: 260px; height: 56px" src="https://runacap.com/wp-content/uploads/2024/04/ROSS_badge_white_Q1_2024.svg" alt="ROSS Index - 2024 年第一季度增长最快的开源初创公司 | Runa Capital" width="260" height="56"/>
  </a>
</p>

---

## ✨ 贡献

欢迎贡献、建议、错误报告和修复！

对于新功能、组件或扩展，请在发送 Pull Request 之前先打开一个问题进行讨论。

如果你想帮助把 LibreChat 翻译成你的语言，我们非常欢迎你的贡献！改进翻译不仅让世界各地的用户更容易使用 LibreChat，也会提升整体的使用体验。请查看我们的[翻译指南](https://www.librechat.ai/docs/translation)。

---

## 💖 本项目能以现有状态存在，得益于所有贡献者

<a href="https://github.com/danny-avila/LibreChat/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=danny-avila/LibreChat" />
</a>

---

## 🎉 特别鸣谢

感谢 [Locize](https://locize.com) 提供翻译管理工具，支撑了 LibreChat 的多语言能力。

<p align="center">
  <a href="https://locize.com" target="_blank" rel="noopener noreferrer">
    <img src="https://github.com/user-attachments/assets/d6b70894-6064-475e-bb65-92a9e23e0077" alt="Locize Logo" height="50">
  </a>
</p>
