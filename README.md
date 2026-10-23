# Obsidian-AI-Brain（dsh-ai-brain）

给 AI 一个**跨会话的持久记忆**：背后是一个 Obsidian 库（就是普通 Markdown 文件夹），
它把「这次会话学到的、下次还该记得的东西」沉淀下来，让 AI 不再每次从零开始。

它原来是一个 skill（`skills/obsidian-ai-brain/`），现在做成了 **DSH 插件**（包名 `dsh-ai-brain`，命名空间 `ai-brain`）：
常驻、有设置页、有定时任务、能主动注入规则、能自己调模型做每日复盘。

---

## ⚠️ 先看这个：它跟 Obsidian 插件不是一回事

| | 本插件（DSH 插件） | Obsidian 插件 |
|---|---|---|
| 谁来加载 | DSH（AI 宿主） | Obsidian |
| 配置界面 | DSH 的「插件设置」页 | Obsidian 的「社区插件」面板 |
| 装在哪 | DSH 的 profile bundles 里 | 库的 `.obsidian/plugins/` |
| 装完看到什么 | 工具里多出 `brain_*`、设置页多一栏 | 一个插件开关 |

它**不要求 Obsidian 开着**：库就是文件夹，插件直接读写文件。Obsidian 只是你（人类）浏览、编辑这个库的顺手工具。

---

## 前置条件

- DSH（桌面版或 web 版均可），Node ≥ 22。
- 一个**已经存在的** Obsidian 库目录（空的也行，但要先建好）。
- 每日复盘要联网、要一个 OpenAI 兼容的模型接口（baseUrl + key + model）。

## 环境依赖

- 无额外系统依赖。纯 JS、无构建步骤。
- 库结构可选地由 `skills/obsidian-ai-brain/scripts/install.py` 帮你铺（幂等，不会覆盖你改过的笔记）。

## 配置参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `vaultPath` | 空 | 库的绝对路径（**必填**，填了才生效） |
| `rulesExtra` | 空 | 追加到「记忆规则」的额外说明 |
| `reviewEnabled` | true | 每日复盘开关 |
| `reviewTime` | `23:00` | 复盘时间 `HH:mm` |
| `apiBaseUrl` | 空 | OpenAI 兼容接口地址 |
| `apiKey` | 空 | key |
| `model` | 空 | 模型名 |
| `reviewPrompt` | 空 | 自定义复盘提示词（空=内置默认） |
| `browseEnabled` | false | 逛互联网开关 |
| `browseTime` | 空 | 逛互联网时间 `HH:mm` |
| `browseMode` | `off` | `off`=不做要求 / `kb`=贴近知识库扩展学习 |

## 下载安装

```bash
dsh plugin --profile desktop add github:lby223/Obsidian-AI-Brain
# 或本地目录：
dsh plugin --profile desktop add link:<本仓库目录>
```

**装完必须重启一次 DSH**（bundle 层要重启才组装）。

装好后：设置页填 `vaultPath` → 重启生效 → 以后对话里就能用 `brain_*` 工具了。

## 使用方式

**实时记录**（AI 在会话里自己判断、自己调）：
- `brain_capture` — 随手记一条草稿到「今日收件箱」，不归类、不阻塞。
- `brain_note` — 直接写一篇正式笔记到指定目录。
- `brain_search` / `brain_read` / `brain_list` — 查以前记过什么。

**每日复盘**（插件自己调模型，不占用你正在聊的会话）：
- 到点读今日收件箱 → 调模型把草稿消化成正式笔记、归类到 `1.项目` / `2.领域` / `2.领域/踩坑` → 归档收件箱。

**逛互联网**（可选）：
- 到点 spawn 一个 headless 会话出去逛，把有用结论写进 `7.探索/<网站>/`。
- 玩站点的（B站 / 自定义 MCP 网站源）：扫码登录后能搜、能看字幕、能抓评论，账号操作（发评论/@/私信）默认全关。

**知识库体检 / 整理**（设置页「记忆」页，或 `brain_tidy` 工具）：
- **体检**（只读）：规则抓硬错 —— 编号撞车、目录自己套自己、空文件、日期写在未来、索引笔记与目录重名、笔记散在目录根下。
- **整理**（受限动作）：只按固定规则表**搬动/改名**，**绝不删文件**，**绝不碰 `3.自我/` 与 `社交人格/`**；单次有上限，清单写进 `9.归档/整理记录/`，想撤回照着搬回来。
- 归类这种事**不确定的只报告、不动手** —— 那是复盘（模型判断）该干的，不是规则该猜的。
- 「复盘后自动整理」默认**关**。

---

## 核心想法

> **不要全文记录，要像人一样思考学习。**

只记四类「能迁移、未来还用得上」的东西：
1. 踩坑/报错（带报错原文 + 确切解法）
2. 环境事实（路径/版本/账号/端口/约定）
3. 决策 + 理由
4. 可复用的做法

判断门：**这件事未来还用得上吗？** 用得上就记，用不上别打扰。

## 目录：一个编号 = 一个动作

```
0.收件箱/      ← 随手记的草稿，等复盘
1.项目/        ← 属于具体项目的事
2.领域/        ← 通用领域知识
2.领域/踩坑/   ← 报错与踩坑
3.自我/        ← 只属于你的（AI 绝不写、绝不搬）
7.探索/        ← 逛互联网的产物（<网站>/ 或 综合/）
4.AI手册/      ← 给 AI 自己的操作规则
5.日记/        ← 日记
6.资料/        ← 模板 / 附件 / 参考
9.归档/        ← 备份、归档
社交人格/      ← 你在网上给 AI 定的人设 + AI 攒的说话样本
```

## 位置要诚实说清

- **实时记录**依赖 AI 在会话里**主动调用** `brain_capture`（它靠注入的规则被引导，但不能 100% 保证每次都记）。
- **每日复盘**是确定性的定时任务，到点就真会跑（只要模型接口配好）。
- **体检能抓的只是「机器判得准」的硬错**，归类好不好看它管不了；整理也只搬「规则确定的」，其余列在报告里等人定。
- 如果你想要「滴水不漏、逐字记录」，这个插件不是干那个的 —— 它故意不全文记录。

## 开发

```
index.js            host 端（apply + Config + 工具 + 定时器 + HTTP）
lib/rules.mjs       注入的规则文本
lib/vault.mjs       库读写（fs 封装，防越界）
lib/llm.mjs         OpenAI 兼容客户端
lib/review.mjs      每日复盘
lib/tidy.mjs        知识库体检 + 受限整理（规则驱动，不用模型）
lib/mcp.mjs         通用 MCP 客户端（stdio + streamable-http）
lib/sites.mjs       网站源抽象（内置 B站 + 自定义 MCP 源）
lib/login.mjs       B站 扫码登录
lib/bili.mjs        B站 venv/依赖/服务端
lib/hostdeps.mjs    桌面版依赖探测（schemastery/dsh-tools 拿不到就降级）
vendor/bilibili-mcp/  内置的 B站 MCP 服务端（Python）
skills/obsidian-ai-brain/  旧 skill（库模板 + install.py）
```

## License

MIT
