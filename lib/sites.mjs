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
import { filterUserEnv } from './guard.mjs'

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
 * 这个 URL 是不是指向本机 / 内网？
 * 为什么要拦：streamable-http 是插件替你去连的，填个 http://169.254.169.254/ 之类的地址
 * 就等于把本机当跳板去打内网（SSRF）。自定义站点本来就该是「公网上的 MCP」。
 */
function isInternalUrl(url) {
  let u
  try { u = new URL(url) } catch { return true }
  const h = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  // IPv6 回环 / 链路本地
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 0 || a === 10 || a === 127) return true            // 本网络 / 回环
  if (a === 169 && b === 254) return true                       // 链路本地（云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true              // 私有段
  if (a === 192 && b === 168) return true                       // 私有段
  if (a === 100 && b >= 64 && b <= 127) return true             // CGNAT
  if (a >= 224) return true                                     // 组播 / 保留
  return false
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
    // env 里危险键（NODE_OPTIONS / PATH / LD_PRELOAD…）在这里就丢掉，spawn 前 guard 还会再过滤一次
    const env = filterUserEnv(raw.env)
    if (Object.keys(env).length) site.env = env
    site.cwd = String(raw.cwd || '').trim() || undefined
  } else {
    const url = String(raw.url || '').trim()
    if (!/^https?:\/\//i.test(url)) return null
    if (isInternalUrl(url)) return null   // 拒内网 / 回环，防 SSRF
    site.url = url
    if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
      const h = {}
      for (const [k, v] of Object.entries(raw.headers)) {
        const key = String(k).trim()
        if (!key || /[\r\n]/.test(key) || /[\r\n]/.test(String(v))) continue   // 头里不许有换行（防头注入）
        if (typeof v !== 'string' && typeof v !== 'number') continue
        h[key] = String(v)
      }
      if (Object.keys(h).length) site.headers = h
    }
  }

  return site
}
