# AI Brain — DSH 插件设计

给 AI 一个「大脑」：跨会话的持久记忆，背后是一个 Obsidian 库（就是一个 Markdown 文件夹）。

## 定位

- 旧 `skills/obsidian-ai-brain/` 是一份 skill（靠规则触发，不保证被读）。
- 现在做成 **DSH 插件**：常驻、有设置页、有定时任务、能主动注入规则、能自己调模型做复盘。
- 仓库 `Obsidian-AI-Brain` 保留，skill 目录作为「库结构模板 + install.py」继续留用（插件部署库时复用同一套模板）。

## 核心原则（来自用户原话）

1. **不要全文记录**，要像人一样「思考 + 学习」。
2. **不拖慢当前会话**：实时记录是异步、轻量的；复盘在后台自己跑。
3. 记录重点 = 对未来有帮助的知识：好用的结论、有趣的事实、实用的工具、犯过的错误。
4. 每日定时复盘 = 像人睡前总结。

## 命名

- 包名 `dsh-ai-brain`；命名空间 / entry id `ai-brain`（必须等于 loader entry 的 id）。
- 仓库名不改，仍是 `Obsidian-AI-Brain`。

## 四个功能

### A. 注入规则（system prompt section）

用 `ctx.inject(['systemPrompt'], ...)` 注入一段「记忆规则」到每次会话：

- 什么时候值得记（四类：结论 / 事实 / 工具 / 踩坑），什么时候别记。
- 「能迁移的才写」判断门。
- 写完要能被未来会话高效检索（写结论、带报错原文、不啰嗦）。

```js
ctx.inject(["systemPrompt"], (ctx) => {
  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section({
      name: "ai-brain", order: 70, interpolate: false, text: RULES
    });
    return () => { if (typeof dispose === "function") dispose(); };
  });
});
```

### B. 知识库读写工具（直接文件系统，不依赖 Obsidian 进程）

库就是 Markdown 文件夹，插件直接 `fs` 读写（快、稳、无协议往返）。库路径来自配置 `vaultPath`。

工具：
- `brain_search` — 全文/关键词搜笔记（grep）。
- `brain_read` — 读一篇笔记。
- `brain_list` — 列出目录结构 / 最近笔记。
- `brain_capture` — 快速记一条「待复盘」草稿 → 写入当日 inbox（`0.收件箱/YYYY-MM-DD.md`），带来源与时间戳，异步不阻塞。
- `brain_note` — 直接写一篇正式笔记到指定目录（带 frontmatter）。

返回值一律过 `safe()`（宿主只吃无损 JSON）。

### C. 每日定时复盘（插件自己调 OpenAI 兼容模型）

- 配置：`reviewEnabled`、`reviewTime`（HH:mm）、`apiBaseUrl`、`apiKey`、`model`、`reviewPrompt`。
- 定时器：每分钟检查一次，到点且当天未跑 → 触发。
- 流程：
  1. 读当日 inbox（`0.收件箱/YYYY-MM-DD.md`）里所有草稿。
  2. 调 LLM，把草稿提炼成正式笔记（判断该归到 `1.项目` / `2.领域` / `2.领域/踩坑` 等，生成标题 + 正文 + frontmatter）。
  3. 写库、归档 inbox、记一条复盘日志。
- OpenAI 兼容客户端：`fetch(baseUrl + '/chat/completions', {Authorization: Bearer key})`。

### D. 设置页 + AI 逛互联网

**设置页**：DSH 自带，不需要注册路由。条件：
1. loader entry `id` 必须等于命名空间 `ai-brain`。
2. 模块导出 `Config`（schemastery）。
3. **每个字段都 `.extra('volatile', true)`**，否则写设置抛错。
4. **不加 `.max(n)` 之类校验**（校验失败 → cordis 拒收 entry → 整条插件不激活）；范围钳制放代码里。

**AI 逛互联网**：
- 配置：`browseEnabled`、`browseTime`、`browseMode`（`off` = 不做要求 / `kb` = 贴近知识库扩展学习）。
- 机制：到点 spawn 一个 headless DSH 会话（`ELECTRON_RUN_AS_NODE=1`），提示词让它按 `browseMode` 去逛、把有用结论 `brain_capture` 回来。
- 登录型站点（如 B 站）：依赖 headless profile 里已挂好的对应 MCP（bili-scroll 那套），插件本身不重造登录逻辑，只负责「到点触发 + 收结果」。v1 先支持公开网页 + 留好扩展点。

## 配置参数（Config 全量）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| vaultPath | string | '' | 库路径（必填，装了才生效） |
| rulesExtra | string | '' | 追加到注入规则的额外说明 |
| reviewEnabled | bool | true | 每日复盘开关 |
| reviewTime | string | '23:00' | 复盘时间 HH:mm |
| apiBaseUrl | string | '' | OpenAI 兼容 baseUrl |
| apiKey | string | '' | key |
| model | string | '' | 模型名 |
| reviewPrompt | string | '' | 自定义复盘提示词（空=内置默认） |
| browseEnabled | bool | false | 逛互联网开关 |
| browseTime | string | '' | 逛互联网时间 |
| browseMode | string | 'off' | off / kb |

## 目录结构（插件包）

```
package.json
cordis.patch.yml
index.js            # host 端入口（apply + Config + 工具 + 定时）
lib/
  rules.mjs         # 注入的规则文本
  vault.mjs         # 库读写（fs 封装）
  llm.mjs           # OpenAI 兼容客户端
  scheduler.mjs     # 定时器 + 复盘/逛互联网触发
  hostdeps.mjs      # 桌面版依赖探测（schemastery/dsh-tools 拿不到就降级）
scripts/install.py  # 复用旧 skill 的库结构部署脚本
skills/obsidian-ai-brain/  # 保留：库模板 + install.py（旧 skill 资产）
README.md
DESIGN.md
```

## 桌面版坑（必须处理）

- 桌面版 profile `autoInstallPeers:false` ⇒ optional peer 永不装。`@deepseek-ai/schemastery` 必须进 `dependencies`（不能只 peer）。
- `defineTool`/`ctx` 拿不到时要降级（不 import 失败就整条不激活）。
- spawn node 要 `ELECTRON_RUN_AS_NODE=1`。
- 运行数据放 `~/.dsh/ai-brain/`，不写插件包目录。

## 安装

```
dsh plugin --profile desktop add link:<本仓库目录>
# 或 github:lby223/Obsidian-AI-Brain
# 装完重启一次（bundle 层要重启才组装）
```
