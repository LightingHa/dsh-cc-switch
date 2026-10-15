# dsh-cc-switch

[![npm](https://img.shields.io/npm/v/dsh-cc-switch)](https://www.npmjs.com/package/dsh-cc-switch)
[![test](https://github.com/LightingHa/dsh-cc-switch/actions/workflows/test.yml/badge.svg)](https://github.com/LightingHa/dsh-cc-switch/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/dsh-cc-switch)](./LICENSE)

把 [cc-switch](https://github.com/farion1231/cc-switch) 里配置好的模型供应商**直接接进 DeepSeek Harness**：
读取 cc-switch 的数据库（`~/.cc-switch/cc-switch.db`），把每家供应商转换成 DSH 内置
`@deepseek-ai/dsh-llm-pi-ai` 的 provider 路由，写进「模型」页面用的同一份配置，并把 API Key
存进 harness 的凭据存储。**cc-switch 里有什么模型，DSH 的模型选择器里就能选到什么。**

本插件针对当前 DSH 版本（`0.2.0-rc.2`）的插件契约与 settings/credentials 服务编写，
不使用任何已废弃的配置字段。

---

## 它到底做了什么

```
cc-switch                                            DeepSeek Harness
──────────                                           ─────────────────
providers 表 ──┐
  claude       │   convert.js         plan.js              settings.mutate('llm-pi-ai')
  codex        ├──────────────► 路由 ──────────►  providers: { ccswitch-*: {...} }
  openclaw     │   (协议/端点/模型)  (只增删自己写过的)         │
  mcode / pi … │                                          └─► 持久化到 profile 的 cordis.patch.yml
               │                                              并热加载 —— 不用重启
proxy 日志 ────┘   credentials.set('CCSWITCH_…_API_KEY', <key>) ─► 凭据存储
```

关键点：**本插件不实现任何 HTTP/协议代码，也不注册第二个 LLM 适配器**
（那样会撞上 `DUPLICATE_ADAPTER`）。它只做「翻译 + 写入」，
真正的协议实现仍然由 DSH 自带的 pi-ai 适配器完成，所以升级 DSH 后不会失效。

---

## 安装

### 从插件市场一键安装（推荐）

装过 [dsh-market](https://github.com/dsh-market/dsh-market)（DSH「设置 → 插件」里的可视化插件市场）的话，
直接在市场里搜 `cc-switch` 点安装即可。市场里的条目来自精选列表
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
本插件已按该列表的规则提交（条目文件见仓库里的 `marketplace/LightingHa__dsh-cc-switch.yml`）。

### 用 CLI 安装

```sh
dsh plugin add dsh-cc-switch                       # 默认 profile
dsh plugin --profile desktop add dsh-cc-switch     # 指定 profile
```

安装动作会改 profile 的两处文件：

- `~/.dsh/profiles/<profile>/package.json` → `dependencies` 加 `"dsh-cc-switch"`，
  `dsh.profile.bundles` 加 `"dsh-cc-switch"`
- 在 profile 目录执行一次安装（把包装进 `node_modules`）

**重启 DSH 后生效**（bundle 列表在启动时读取）。也可以在「设置 → 插件」里直接启用，
插件管理器会热挂载条目，不必重启。

### 从源码安装（开发 / 改代码时）

```powershell
$plugin  = "D:/path/to/dsh-cc-switch"         # 换成你 clone 的位置
$profile = "$env:DSH_HOME/profiles/desktop"   # 换成目标 profile

# 1) 在 $profile/package.json 里：
#    dependencies 加 "dsh-cc-switch": "file:$plugin"
#    dsh.profile.bundles 加 "dsh-cc-switch"
# 2) 安装
cd $profile
pnpm install
```

> `file:` 依赖在 pnpm 里是**快照**：改完插件源码必须重装才生效 ——
> 删掉 `node_modules/dsh-cc-switch`，再 `pnpm add "dsh-cc-switch@file:<路径>"`；
> 只跑 `pnpm install` 会提示 “Already up to date” 而不会刷新内容。

### 环境要求

- DSH `>= 0.2.0-rc.1`（在 `0.2.0-rc.2` 上验证）
- Node.js `>= 22.13`（读 cc-switch 的 SQLite 库用到内置的 `node:sqlite`；它在 Node 22.13 才不再需要 `--experimental-sqlite`。DSH 自带的 Node 24 满足）
- 本机装过 [cc-switch](https://github.com/farion1231/cc-switch)，并至少配置了一家第三方供应商

### 装完之后

插件加载后会**自动同步一次**（`syncOnLoad`），之后每 30 秒看一眼 cc-switch 数据库有没有变
（`watchSeconds`），改了自动跟上。首次同步会：

1. 把 cc-switch 里的 API Key 写进凭据存储（名字形如 `CCSWITCH_CODEX_…_API_KEY`）；
2. 把路由写进 `llm-pi-ai` 的 `providers`，持久化到 profile 并热加载。

然后打开「设置 → 模型」，就能看到 `ccswitch-*` 开头的供应商；把它设为默认模型即可开始用。

> 不想让它自动写入？把配置改成 `mode: plan`（见下方配置表），它只会计算并打日志。

---

## 用工具手动控制

插件注册了工具 `cc_switch`：

| action | 作用 |
| --- | --- |
| `status`（默认） | 看当前状态、本次会做什么 |
| `sync` | 立即同步（`dry_run: true` 可只预演） |
| `plan` | 只预演，绝不写入 |
| `probe` | **体检**：按 pi-ai 会打的那个 URL 真发一次最小流式请求，实测每条路由通不通、首字节多久、流有没有正常收尾 |
| `list` | 列出 cc-switch 里识别到的全部供应商与模型 |
| `skip-list` | 只看**没**导入的供应商及原因 |

常用参数：`app_types`（本次只处理这些 app 类型）、`include` / `exclude`（按名称/ID 关键字收窄）。
这些参数只影响本次调用，不改插件配置。

例：`cc_switch` + `action=sync, dry_run=true` → 打印「将新增几条、更新几条、删几条、写几个凭据」。

### 体检输出怎么读

```
🩺 cc-switch 路由体检：共 2 条（可用 2，慢 0，异常 0），单条上限 200s
· ccswitch-openclaw-ark-code-latest（Ark Code Latest / openai-completions / 模型 ark-code-latest）
    ✅ 可用：HTTP 200，首字节 4.8s，共 7.9s，32365 字节
· ccswitch-codex-…（小胡王国 / openai-responses / 模型 gpt-6-astra）
    🐢 可用，但很慢：HTTP 200，首字节 96.3s，共 96.4s，50534 字节
    提示：首字节太久，对话时很容易被上游或网关掐断（表现为流读取失败）…
```

| 结论 | 含义 |
| --- | --- |
| ✅ 可用 | 2xx + 流里出现完成标记（`response.completed` / `[DONE]` / `message_stop`） |
| 🐢 可用，但很慢 | 通了，但首字节超过 `probeSlowFirstByteMs`；长对话容易中途断流 |
| ⚠️ 流没正常结束 | 连接断了却没看到完成标记 —— 上游把流掐了 |
| ⏱️ 超时 | 超过 `probeTimeoutMs` 仍没跑完 |
| ❌ 不可用 | 非 2xx、连不上、DNS/证书失败，或上游在流里返回了错误（错误原文会摘出来，密钥自动打码） |

体检**只读**：不写配置、不写凭据，Key 只出现在请求头里。

---

## 支持的 cc-switch app 类型与映射规则

| app 类型 | cc-switch 里的配置形状 | 映射结果 |
| --- | --- | --- |
| `claude`、`claude-desktop` | `{env:{ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN\|ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL}}` | `anthropic-messages`，模型取 `ANTHROPIC_MODEL` + 各 `ANTHROPIC_DEFAULT_*_MODEL` |
| `codex` | `{auth:{OPENAI_API_KEY}, config:"<TOML>"}` | 解析 TOML 的 `model` / `model_provider` / `[model_providers.*]`；`wire_api=responses` → `openai-responses`，否则按 Codex 自身默认的 chat → `openai-completions` |
| `openclaw` | `{baseUrl, apiKey, api, models[]}`（也认整份 `models.providers`） | 与 pi-ai 字段几乎 1:1；一个 `providers` 条目展开成多条路由 |
| `mcode` | `{custom_provider:{<key>:{api, options:{baseURL,apiKey}, models}}}` | 按条目 `api`，`enabled:false` 的跳过 |
| `pi` | `[models] default` + `[model.<id>] base_url / api_key / api_backend` | 按 `api_backend` |
| `gemini` | `{env:{GEMINI_*/GOOGLE_*}, config}` | **原生 `generateContent` 不在 pi-ai 支持范围内**，默认跳过并说明原因；若在 cc-switch 里开了 OpenAI 兼容（或配置了 `meta.apiFormat`）就按兼容协议导入 |
| `opencode`、`hermes`、`grokbuild`、未知类型 | 结构不定 | 深度扫描 `baseURL` / `apiKey` / `models`，能认出来就导入，认不出就进 `skip-list` 并说明原因 |

识别到的元信息（`meta`）也会用上：

- `apiFormat` / `codexCopilotApiFormat` → 决定协议（`openai_chat` → `openai-completions`）
- `apiKeyField` → 指定用哪个字段当密钥
- `isFullUrl` → 端点是完整接口地址时自动去掉 `/chat/completions`、`/responses`、`/messages` 尾巴
- `customUserAgent` / `requestHeaders` → 转成路由请求头（非法表头会被丢弃，避免整次写入失败）
- `model_catalog_json` → 补充模型清单

**模型清单从哪来**：优先用配置里声明的模型；再合并 cc-switch 代理日志
（`proxy_request_logs`）里这家供应商真实用过的模型名 —— 这能救回那些只声明一个
`model` 的 Codex 供应商；最后用 `model_catalog_json`。三者都没有的供应商会被跳过，
不会生成「选不了的模型」条目。

---

## 配置项

配置写在 profile 的 `cordis.patch.yml` 里（也可以让「设置 → 插件」写入）：

```yaml
- id: cc-switch
  name: dsh-cc-switch
  config:
    mode: apply
    watchSeconds: 30
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后不自动同步，工具仍可用 |
| `dbPath` | `''` | cc-switch 数据库路径；留空自动探测（也认 `CC_SWITCH_DB` / `CC_SWITCH_HOME`） |
| `appTypes` | `claude,claude-desktop,codex,openclaw,mcode,pi,opencode,hermes,grokbuild,gemini` | 要导入的 app 类型 |
| `include` / `exclude` | `''` | 按名称/ID 关键字包含/排除（逗号分隔） |
| `routePrefix` | `ccswitch` | 路由名前缀；**也是「本插件拥有的路由」的判定依据和凭据名前缀** |
| `targetEntry` | `llm-pi-ai` | 写进哪个条目的 `providers` |
| `mode` | `apply` | `apply`=写入；`plan`=只计算不写 |
| `onConflict` | `skip` | 路由名与已有配置撞车时：`skip` 跳过并警告 / `overwrite` 覆盖 |
| `importUnsupported` | `false` | 连端点/协议不全的也写进去（会出现选了就报错的模型，不建议） |
| `pruneOwnedRoutes` | `true` | 清理自己上次写过、这次不再生成的路由与凭据 |
| `writeCredentials` | `true` | 把 API Key 写进凭据存储 |
| `usageModelHints` | `true` | 用代理日志补充模型清单 |
| `syncOnLoad` | `true` | 加载后自动同步一次 |
| `loadDelayMs` | `2500` | 首次同步延迟（避开启动高峰） |
| `watchSeconds` | `30` | 轮询 cc-switch 数据库变化的间隔；`0`=关闭 |
| `statePath` | `''` | 清单文件路径；留空用 `$DSH_HOME/cc-switch-state.json` |
| `overrides` | `{}` | 人工修正：`{ 路由名: 要合并进该路由的字段 }`，例如 `{"ccswitch-codex-xxx":{"api":"openai-completions"}}` |
| `probeTimeoutMs` | `120000` | 体检时单条路由的等待上限；慢中转常常几十秒才吐首字节 |
| `probeSlowFirstByteMs` | `30000` | 体检时首字节超过这个毫秒数就标成「慢」 |
| `toolName` | `cc_switch` | 工具公开名 |
| `debug` | `false` | 打详细日志 |

---

## 安全边界（重要）

- **只写 `routePrefix` 前缀的路由**（默认 `ccswitch-`）。你手写的、别的插件写的路由
  （比如 `ali-bailian`、`huoshan`）永远不会被改动。
- **只删自己写过的**。插件在 `$DSH_HOME/cc-switch-state.json` 里记着自己上次写了哪些
  路由和凭据；只有清单里有的、这次不再生成的，才会被撤销。
- **撞名默认跳过**。万一前缀撞上了别人的配置，默认跳过并在报告里警告，不会静默覆盖。
- **没有变化就不写**。内容一致时完全不动配置（幂等），不会反复触发 reload。
- **凭据只写不覆盖环境变量**。如果某个引用名已经由启动环境提供，插件不会去覆盖它，
  只在报告里提示。
- **密钥不回显**。所有输出里的 Key 都做了掩码。
- 想完全停手：`mode: plan`，或直接禁用插件条目。

### 撤销

在 cc-switch 里删掉供应商 → 下次同步自动撤销对应的路由与凭据。
想一次性全部撤销：删掉 `$DSH_HOME/cc-switch-state.json` 之后**它就不会再删任何东西**了，
所以正确做法是先在 cc-switch 里清空供应商，或手工把 `providers` 里 `ccswitch-` 开头的键删掉。

---

## 常见问题

**选了 cc-switch 的模型，对话却报流读取错误（例如 `stream_read_error`）？**
先跑体检：`cc_switch` + `action=probe`。它按 pi-ai 实际会打的那个 URL 发一次真请求，
把「通不通、首字节多久、流有没有正常收尾」量化出来。

这类报错**几乎都不是本插件的映射问题**（映射错了会直接连不上或 4xx），而是第三方
中转端点自己的毛病：

- **首字节太久**（几十秒到上百秒很常见）：中间的网关/代理等不及就把连接掐了，
  客户端看到的就是流读取失败。cc-switch 的 `proxy_request_logs` 里也能看到同一家
  供应商的 `first_token_ms`。
- **上游在流里返回错误**：中转把它自己的错误塞进 SSE（`{"type":"error",…}`），
  体检会把这段原文摘出来给你看。
- **偶发断流**：同一条路由这次通、下次断 —— 换一条路由或换个模型试试。

想让慢路由更容易熬过去，可以给它单独调大超时（`timeoutMs` 是整请求超时，
`streamIdleTimeoutMs` 是「多久没数据算卡死」，默认 5 分钟）：

```yaml
- id: cc-switch
  name: dsh-cc-switch
  config:
    overrides:
      ccswitch-codex-xxxxxxxx:
        timeoutMs: 600000
        streamIdleTimeoutMs: 600000
```

**官方供应商（Claude Official / Google Official）为什么没导入？**
它们没有第三方 `base_url`，且需要 OAuth 登录，pi-ai 无法用一组静态密钥直接调用。
用 `cc_switch` 的 `skip-list` 可以看到确切原因。要用官方账号，请用 DSH 自带的对应账号插件。

**Codex 供应商怎么只有一个模型？**
cc-switch 的 Codex 配置通常只写一个 `model`。本插件会把 `proxy_request_logs` 里
这家供应商用过的其它模型名一起加进清单（`usageModelHints`），所以实际会更多 ——
以 `cc_switch` `list` 的输出为准。

**Gemini 原生协议呢？**
当前 DSH 的 pi-ai 只支持 `openai-completions` / `openai-responses` / `anthropic-messages`。
走 Gemini 原生 `generateContent` 的端点无法直接接入：请在 cc-switch 里换成
OpenAI 兼容网关，或改用 DSH 自带的 Gemini 插件。

**改了插件源码后为什么没生效？**
两件事都要做：

```powershell
# 1) file: 依赖在 profile 里是快照，普通 pnpm install 不会刷新它
cd $env:DSH_PROFILE_DIR
node "$env:DSH_HOME/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs" `
  add "dsh-cc-switch@file:D:/dshproject/dshtest01/dsh-cc-switch"
# 2) 让 DSH 重新加载插件条目（重启 DSH，或在「设置 → 插件」里关掉再打开）
```

第 1 步之后可以用测试自查是否已经刷新：

```powershell
node --test test/manifest.test.mjs     # 会比对 profile 里的副本与源码是否一致
```

**想加自己的特殊端点**：用 `overrides` 按路由名覆盖字段，或直接在配置里留 `include`
只处理它，然后手工在「模型」页面补字段。

---

## 开发与自检

```powershell
# 全部测试（80 个，含用 node:sqlite 现造的 cc-switch 夹具库、假宿主集成测试、
# 复刻 pi-ai 严格校验的用例、体检的各种上游行为、安装清单契约测试）
npm test

# 也可以只跑一部分
npm run test:unit
npm run test:host
npm run test:manifest

# 不启动 DSH，直接看「会写入什么」
node scripts/inspect.mjs
node scripts/inspect.mjs --json
node scripts/inspect.mjs --app-types codex,openclaw

# 不启动 DSH，直接体检每条路由（真发请求；退出码 2=有路由异常）
node scripts/probe.mjs
node scripts/probe.mjs --app-types codex --timeout 240000
node scripts/probe.mjs --json
```

> 别用 `node --test test/`：Node 24 会把 `test/` 当模块解析而报
> `Cannot find module …\test`，所以 `npm test` 里逐个列文件。

`scripts/inspect.mjs` 是排查利器：它打印每条将写入的路由（协议、端点、模型清单、
掩码后的凭据名）以及**每个没导入的供应商的具体原因**。
`scripts/probe.mjs` 则回答另一半问题：配置对了，**端点到底能不能用**。

代码结构：

| 文件 | 职责 |
| --- | --- |
| `dsh/index.js` | 插件入口：Config、工具、自动同步与文件监听、写入编排 |
| `dsh/ccswitch.js` | 定位并读取 cc-switch（SQLite / 旧版 JSON），归一化成记录 |
| `dsh/convert.js` | 各类 app → pi-ai provider 路由的映射规则 |
| `dsh/plan.js` | 差异计算：新增/更新/删除/冲突/跳过，凭据写入与清理 |
| `dsh/probe.js` | 路由体检：按协议构造最小流式请求，量化首字节耗时与流是否正常收尾 |
| `dsh/state.js` | 清单文件（插件「自己写过什么」的唯一依据） |
| `dsh/toml.js` | Codex `config.toml` 的最小 TOML 解析器（永不抛错） |
| `test/` | 单元测试、宿主集成测试、安装清单契约测试 |

测试里有一条**严格校验**用例：它复刻 pi-ai 写入时的拒绝规则
（`displayName` 非空、协议受支持、`contextWindow`/`maxTokens` 为正整数、模态合法、
模型 id 不重复、表头能被 Fetch 接受……），保证插件生成的配置不会让整次写入失败。

还有一条容易踩的坑被专门测住了：`settings.describe()` 返回的是 **schemastery 解析后**
的配置，pi-ai 会给每个供应商补上 `defaultContextWindow` / `defaultMaxTokens` /
`defaultInput` / `streamIdleTimeoutMs` / `retryPolicy` 等默认字段。所以幂等比较必须
只比对自己生成的字段（`profileMatches`），否则每轮同步都会判定「有变化」并重写配置文件。
反过来，用户手工调过的、插件不生成的字段（例如改了某条路由的 `retryPolicy`）会被保留。

## 发布与维护

### 发一个新版本

```sh
npm version patch          # 或 minor / major；记得同步补 CHANGELOG.md
npm pack --dry-run         # 先看看 tarball 里到底打包了什么
npm publish                # package.json 里 publishConfig.access = public
git push --follow-tags
```

`prepublishOnly` 会自动跑完整测试，测试不过发布会被拦下。

### 上架 / 更新市场条目

市场的目录来自精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
（`dshmarket` 插件每次打开都实时读取 `awesome-dsh-plugin.com/plugins.json`，由该仓库的 CI 每日刷新）：

1. fork 该仓库；
2. 把 `marketplace/LightingHa__dsh-cc-switch.yml` 复制成
   `data/plugins/LightingHa__dsh-cc-switch.yml` —— **一个插件一个文件**；
3. 提 PR。

两个 README 由 CI 从 `data/plugins/*.yml` 生成，**不要手工编辑**（手工改会和别人的 PR 冲突）。
npm 下载量映射由 registry 自动采集：仓库里的 `package.json` 名字只要和 npm 包名一致（`dsh-cc-switch`）就行，
条目里**不要**手写 `npm:` 字段，会被校验器拒绝。

条目本身不用跟着版本更新：`url` / `name` / `category` / `description` 没变就不用再动它。

### 市场收录的硬性条件（改仓库时别破坏）

- `package.json` 必须声明 `dsh.bundle.patch`（只声明 `dsh.client` 不算可安装插件，这是最常见的被拒原因）；
- 根目录有 `cordis.patch.yml`，内容是 `- insert:` 挂一个条目；
- 声明了 `@deepseek-ai/dsh-*` 的 `peerDependencies` 就会被版本检查，不满足时**整包被跳过** ——
  本项目因此不声明这类 peer，只用 `engines.dsh` 说明宿主版本（市场卡片据此显示兼容性）。

## 许可证

MIT