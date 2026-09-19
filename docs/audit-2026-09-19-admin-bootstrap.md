# 审计：管理员判定（admin bootstrap）

- 日期：2026-09-19
- 范围：LibreChat fork（`Chloemlla/LibreChat`）中「谁会成为管理员」的全部判定路径
- 结论：**首次部署没有任何显式、可见、必然可达的管理员创建路径**。管理员身份是「第一个自助注册者」这一隐式副作用的产物，且这条路径在多种常见配置下根本走不到。本次新增首访初始化页（init page）把这件事变成显式操作，并补齐了 CLI 侧的唯一缺口。

---

## 一、现状：管理员是怎么被判定出来的

| 入口 | 判定 | 位置 |
|---|---|---|
| 本地注册 `POST /api/auth/register` | `!tenantId && (await countUsers()) === 0` → `ADMIN` | `api/server/services/AuthService.js:417`、`:430` |
| 社交登录（Google/GitHub/Discord/Facebook/Apple） | **不判定**，走 schema 默认值 `USER` | `api/strategies/process.js:90`、`packages/data-schemas/src/schema/user.ts:64` |
| LDAP | `(await countUsers()) === 0` → `ADMIN`（**无** `!tenantId` 约束） | `api/strategies/ldapStrategy.js:153` |
| OpenID | 仅当配置了 `OPENID_ADMIN_ROLE` 且 token 命中 | `api/strategies/openidStrategy.js:743` |
| CLI `npm run create-user` | 间接复用 `registerUser`，因此同样只在**库为空**时给 `ADMIN` | `config/create-user.js` |

也就是说，判定依据是**「用户表是不是空的」**，而不是「这个部署是否已经完成初始化」，更不是「操作者有没有被授权」。

---

## 二、缺陷清单

| 编号 | 位置 | 类型 | 详细错误信息 | 改法 | 状态 |
|---|---|---|---|---|---|
| ADM-01 | `api/server/services/AuthService.js:417` | 隐式特权授予 | 管理员由「第一个自助注册者」隐式产生：部署方无法预知、无法指定、日志里只有一行 `Register User`。且判定基准是「用户数为 0」而非「是否已初始化」，语义与安全边界脱节 | 新增显式初始化入口（`POST /api/setup`），判定基准改为「是否已存在 `ADMIN` 角色的账号」 | 已修（本次） |
| ADM-02 | `api/server/middleware/validateRegistration.js:8` | 死锁 | `ALLOW_REGISTRATION` 未开启时注册路由**无条件** 403，没有首次部署例外。`ALLOW_REGISTRATION=false` + 空库 ⇒ 界面上永远无法创建第一个管理员，只能进容器跑 CLI | 初始化页走独立路由 `POST /api/setup`，**不经过** `validateRegistration`；`ALLOW_REGISTRATION` 只约束普通注册 | 已修（本次） |
| ADM-03 | `api/strategies/process.js:90` + `packages/data-schemas/src/schema/user.ts:64` | 功能缺失 | `createSocialUser` 的写入对象里没有 `role` 字段，落库即 schema 默认 `USER`。纯社交登录部署（`ALLOW_SOCIAL_REGISTRATION=true`、`ALLOW_REGISTRATION=false`）永远产生不了管理员 | 初始化页在无管理员时始终可用，不受登录方式限制 | 已修（本次，改由独立入口覆盖） |
| ADM-04 | `api/strategies/ldapStrategy.js:153` | 判定不一致 | 与 `AuthService` 同名的判定少了 `!tenantId` 约束：多租户部署下第一个 LDAP 登录者会拿到平台级 `ADMIN` | 未改。改动会反转现有 LDAP 部署的行为（从「首个 LDAP 用户是管理员」变成「永远不是」），需要产品决策，本次只记录 | 挂起 |
| ADM-05 | `config/create-user.js` | 运维死角 | CLI 复用 `registerUser`，因此**在非空库上永远造不出管理员**；`additionalData` 也没有透传角色的开关。库里有普通用户但没有管理员时（ADM-03 的直接后果），CLI 也救不回来 | 新增 `--role=ADMIN`，经 `registerUser` 的显式角色通道落库 | 已修（本次） |
| ADM-06 | `api/server/services/AuthService.js:388`→`:431` | 隐式类型/权限通道 | `additionalData` 里的任意字段会被展开进 `newUserData` **且位于 `role` 之后**，等于一个未校验的提权通道（`registerUser(user, { role: 'ADMIN' })` 今天就能生效，但代码里看不出来） | 把 `role` 从 `trustedAdditionalData` 里显式取出，并收窄为 `SystemRoles.ADMIN \| SystemRoles.USER` 才采用 | 已修（本次） |
| ADM-07 | `api/server/services/AuthService.js:417` | 竞态（TOCTOU） | 两个并发的首次注册请求会各自读到 `countUsers() === 0`，同时落库两个 `ADMIN`。没有唯一约束、没有标记位、没有事务 | 未改。窗口仅在「空库 + 同时两个访客」时存在，且普通注册路径（上游行为）本就有同样窗口。初始化页沿用同一语义；若需彻底消除需引入一次性标记集合（见「四、残留风险」） | 挂起 |
| ADM-08 | `api/server/services/AuthService.js:417` | 静默提权 | 若管理员被删光（或全部用户被清空），下一个注册者会**静默**成为 `ADMIN` | 部分缓解：初始化页的判定基准是「无 `ADMIN` 账号」而非「无用户」，因此不会因为「有普通用户」而失效；但「管理员被删光后初始化页重新开放」这一性质仍然存在（此时部署本身已无人可管）。彻底关闭需一次性标记，见「四」 | 部分缓解 |
| ADM-09 | `api/server/routes/config.js:96` | 可观测性 | `startupConfig` 只暴露 `registrationEnabled`，前端无从得知「这个部署还没有管理员」，因此首次访问只能显示一个普通登录页 | 新增 `GET /api/setup/status`，前端首访据此渲染初始化页 | 已修（本次） |
| ADM-10 | `api/server/index.js`（启动日志） | 运维不可见 | 未初始化的部署在日志里与正常部署完全一致：监听正常、readiness 通过，唯一缺的是没人能管理它。运维只能靠自己想起「第一个注册的人会成为管理员」这条隐式规则 | 启动后检查管理员数量，为 0 时打印一条带 `/setup` 链接的 `warn` 指引 | 已修（本次） |

---

## 三、本次实现

### 判定口径

> 部署处于「未初始化」状态 ⇔ **当前没有任何账号持有 `ADMIN` 角色**。

选它而不是「用户数为 0」，是因为后者在 ADM-03 场景下会永久失效：只要有一个普通用户（例如社交登录进来的）先落地，部署就再也造不出管理员。同时，租户请求（`getTenantId()` 非空）一律视为已初始化——租户管理员由平台发放，不由租户自己开。

### 后端

- `packages/api/src/setup/index.ts`：`createSetupHandlers({ countAdmins, registerUser, getTenantId })`
  - `GET /status` → `{ required: boolean }`；读不到计数时**失败即关闭**（500，前端回落到普通登录页）
  - `POST /` → 仅当未初始化时以 `{ role: ADMIN, emailVerified: true }` 调用注册路径；已初始化返回 403
- `api/server/routes/setup.js`：路由装配（依赖注入 `countUsersByRole` / `registerUser` / `getTenantId`），链路为 `registerLimiter → requireSameOrigin → validateTurnstile → handler`
- `api/server/index.js`、`api/server/experimental.js`：挂载 `/api/setup`（与 `/api/auth` 同为 pre-auth 区域）
- `api/server/services/AuthService.js`：`registerUser` 显式接收并收窄角色（ADM-06）
- `config/create-user.js`：新增 `--role=ADMIN`（ADM-05）

### 前端

- `client/src/components/Auth/Setup.tsx`：初始化页（姓名/邮箱/用户名/密码/确认密码 + Turnstile），成功后倒计时回登录页；直接访问时若部署已初始化则自动跳回 `/login`
- `client/src/routes/index.tsx`：新增 `/setup` 路由（初始化页的正式地址，可分享/可 bookmark）
- `client/src/components/Auth/Login.tsx`：`GET /api/setup/status` 返回 `required: true` 时以初始化页替换登录表单；**同时屏蔽 OpenID 自动跳转**——未初始化的部署没有账号可供 IdP 认证
- `client/src/locales/en/translation.json`：4 个 `com_auth_setup_*` 文案

### 启动日志指引

服务器起来后如果仍然没有管理员，启动日志里会直接打印一条可点击的指引（`api/server/index.js`、`api/server/experimental.js`，后者只在 worker 1 打印一次）：

```
[Setup] This deployment has no administrator account yet. Open http://<DOMAIN_CLIENT|host:port>/setup to create the first administrator.
```

- 地址优先取 `DOMAIN_CLIENT`（对外地址），未配置时回落到进程实际绑定的 `host:port`
- 文案由 `packages/api/src/setup/index.ts` 的 `describeSetupRequirement()` 产出；它**永不抛错**（读不到计数就记 error 日志并返回 null），不会因为一句提示把服务器启动搞挂
- 已有管理员时返回 `null`，正常启动不会多出这行

---

## 四、残留风险（明确未修）

1. **ADM-07 竞态**：初始化接口与注册接口共用「计数为 0」这一非原子前置条件。彻底修复需要在 `data-schemas` 引入一个一次性标记文档（唯一索引 + `upsert` 抢占，成功后才落管理员，失败回滚标记）。本次不做，理由是新增集合会带来索引/迁移面，而窗口只在「空库 + 并发首访」出现，且不劣于上游注册路径的既有语义。
2. **ADM-08 删除后重开**：管理员被删光后初始化接口重新开放。此时部署已无任何可管理人员，重新初始化是「可用」而非「可利用」；若要彻底关闭，同样依赖上面的一次性标记。
3. **ADM-04 LDAP 判定不一致**：未动。
4. **Turnstile 与自动登录**：初始化成功后不自动登录，而是回到登录页（Turnstile token 一次性，复用必然失败）。若部署关闭了 `ALLOW_EMAIL_LOGIN`，初始化出的本地账号无法从表单登录——这属于部署配置问题，本次不额外拦截。

---

## 五、验证

- 静态：`node --check` 全部改动 JS；`prettier`（printWidth 100 / singleQuote / trailingComma all / endOfLine auto）比对全部改动文件；`translation.json` JSON 解析
- 单测：`packages/api/src/setup/index.spec.ts`（9 例：状态判定 4 例 + 初始化 5 例），已加入 `.github/workflows/fork-verification.yml` 的 `packages/api` 回归清单
- 本地不跑构建/类型检查（仓库 `AGENTS.md` 规定），以 CI 的 `Build and typecheck`（含 `tsc --noEmit`）+ `Regression (packages/api)` 为裁决
- 未覆盖：`Setup.tsx` 无组件测试（现有 Auth 测试需要大量 mock，风险高于收益），UI 状态由 CI 构建 + 人工路径确认
