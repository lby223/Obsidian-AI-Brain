/**
 * lib/sites.mjs —— 「指定网站」抽象层
 * ============================================================================
 * 一个「指定网站」= 一个可以被 AI 逛、可以登录、可以把学到的知识写进知识库的网站。
 *
 * 内置两种：
 *   1. B站（bili）—— 走 vendor 的 Python MCP（stdio），扫码登录。
 *   2. 自定义 MCP（custom）—— 用户填一个 stdio 或 streamable-http 的 MCP，我们负责起它。
 *
 * 每个源描述清楚五件事：
 *   · id / name：唯一标识 + 显示名
 *   · howToSpawn：怎么起这个 MCP（stdio command/args，或 streamable-http url）
 *   · login：登录状态怎么判、怎么登录（B站扫码；custom 可能不需要）
 *   · whitelist：这一轮只给模型哪些工具（默认只读工具，写工具靠开关）
 *   · prompt：逛这个网站时给 headless 会话的引导词
 *
 * 安全硬约束（用户已确认）：自定义 MCP 只允许 stdio / streamable-http，
 * 禁止 shell 拼接 —— 一律参数数组 spawn、shell:false。
 * ============================================================================
 */

/** 内置 B站 源定义 */
export const BILI_SITE = {
  id: 'bili',
  name: 'B站',
  transport: 'stdio',
  // 实际 command/args 由 bili.mjs 的 ensureVenv 决定（venv python + mcp_server.py）
  whitelistDefault: ['bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info'],
  writeTools: ['bili_reply', 'bili_send_message', 'bili_send_dynamic', 'bili_send_opus', 'bili_upload_video', 'bili_upload_video_multi', 'bili_crawl'],
}

/**
 * 规范化一个「自定义 MCP 源」的配置（从设置页 JSON 里读出来）。
 * 只收白名单字段，transport 只允许 stdio / streamable-http。
 * 返回 null 表示配置不合法（会被忽略）。
 */
export function normalizeCustomSite(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = String(raw.id || '').trim().replace(/[^\w\u4e00-\u9fa5-]/g, '')
  const name = String(raw.name || id || '').trim()
  if (!id || !name) return null
  const transport = String(raw.transport || 'stdio').trim()
  if (!['stdio', 'streamable-http'].includes(transport)) return null

  const site = {
    id, name, transport,
    // 要不要在「指定网站」到点时自动逛它（默认开；列表里能关掉单个网站）
    enabled: raw.enabled !== false,
    whitelist: Array.isArray(raw.whitelist) ? raw.whitelist.filter((x) => typeof x === 'string').map((s) => s.trim()).filter(Boolean) : [],
  }

  if (transport === 'stdio') {
    const command = String(raw.command || '').trim()
    if (!command) return null
    site.command = command
    // args 必须是字符串数组（禁止 shell 拼接 —— 用户要拼什么 shell 语法这里一律当普通参数）
    site.args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : []
    if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) site.env = raw.env
    site.cwd = String(raw.cwd || '').trim() || undefined
  } else {
    const url = String(raw.url || '').trim()
    if (!/^https?:\/\//i.test(url)) return null
    site.url = url
    if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) site.headers = raw.headers
  }

  return site
}
