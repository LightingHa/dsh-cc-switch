# 更新日志 / Changelog

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)，条目格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.0.0] - 2026-10-15

首个公开发布版本，在 DeepSeek Harness **0.2.0-rc.2**（桌面 desktop profile）上实测通过。

### 新增

- 读取 `~/.cc-switch/cc-switch.db`（SQLite，用 WAL 安全快照读，避免和正在写入的 cc-switch 抢锁），也兼容旧版 `~/.cc-switch/config.json`。
- 支持 cc-switch 的全部 app 类型：`claude`、`claude-desktop`、`codex`、`gemini`、`grokbuild`、`opencode`、`openclaw`、`hermes`、`pi`、`mcode`。
- 把每个供应商转成 pi-ai 支持的三种协议路由：`openai-completions`、`openai-responses`、`anthropic-messages`；各家 TOML / JSON / 嵌套配置的差异在 `convert.js` 里归一化。
- API Key 通过 `ctx.credentials` 写入凭据存储（只写入本插件生成的引用名，绝不覆盖启动环境变量提供的同名凭据），路由通过 `ctx.settings.mutate` 写入 `llm-pi-ai.providers`，热加载生效，无需重启。
- 注册 `cc_switch` 工具，提供 6 个动作：`status`（现状）、`sync`（同步）、`plan`（只预演）、`probe`（实测体检）、`list`（列出供应商）、`skip-list`（只看没导入的原因）。
- `probe` 体检：逐条实测首字节耗时、总耗时、流是否正常收尾、HTTP 状态与上游错误正文；探测请求只要求 16 token 输出，几乎不消耗配额；所有输出里的 Key 一律打码。
- 幂等同步：与 settings 解析后的 pi-ai 默认值做**子集**比较，重复同步不再产生多余写入。
- 只写自己拥有的路由（`ccswitch-` 前缀 + `~/.dsh/cc-switch-state.json` 清单）；删除也只删清单里记录过的路由与凭据。
- 自动同步：加载后延迟同步 + 监听 cc-switch 数据库变化（`syncOnLoad` / `loadDelayMs` / `watchSeconds` 可调，`syncOnLoad: false` 完全关闭）。
- 配额共用提醒：检测到「已有路由与本插件生成的路由用同一端点、同一把 Key」时，报告会点明二者共用配额，429 限流时切换无效。
- 写入重试：settings 补丁并发写导致的瞬时失败自动重试 3 次。
- 离线脚本：`npm run inspect`（不许写入的演练报告）、`npm run probe`（不开 DSH 也能体检端点）。
- 80 个测试：单元（转换 / 计划 / 体检）+ 宿主集成（假 settings 与 credentials 服务）+ 清单契约（加载器规则）。

### 已知限制

- 官方 OAuth 供应商（Anthropic 官方、Claude Desktop 官方）会被跳过：它们没有第三方 `base_url`，也不适合把 OAuth 令牌搬进 pi-ai。
- Gemini 官方不导入：走的是原生 `generateContent`，pi-ai 只有上述三种协议。
- 本插件只做「翻译 + 写入」，不实现任何 wire 协议，也不挂载第二个 pi-ai 实例（否则会触发 `DUPLICATE_ADAPTER`）。
- 上游中转的第一字节延迟波动很大时，对话仍可能被掐断（表现为 `stream_read_error`）——那是上游的问题，可用 `overrides` 给单条路由调大超时。