/**
 * lib/sessions.mjs —— 从 DSH 会话日志里把「人说的话」抽出来（功能 A 的地基）
 * ============================================================================
 * 为什么需要它：
 *   插件本身读不到会话内容。对话要不要记，以前完全取决于模型某一步是否主动调
 *   brain_capture——它不调，这段对话就消失。这个模块让插件能自己回头看：
 *   今天你说过什么、我答了什么，抽出来补进收件箱。
 *
 * 会话文件长什么样（本机实测，2026-10-24）：
 *   ~/.dsh/sessions/<工作区目录>/<会话目录>/session.v4.jsonl.zstd
 *   一、是 **zstd 多帧**拼接：全文件按魔数 0xFD2FB528 逐帧扫，一帧一帧解。
 *       zlib.zstdDecompressSync(整块) 只解第一帧（3MB 文件只解出 204 字节）。
 *   二、是 JSONL，一行一条事件，实测 11934 行全部可 JSON.parse。
 *   三、条目类型：step/start, step/end, assistant/message, tool/call, tool/result,
 *       job/registered, job/settled, user/message, agent/inbox/spliced,
 *       turn/start, turn/end, request/header。
 *   四、**user/message 里绝大多数不是人**：实测 211 条里只有 87 条 source.kind='user'，
 *       其余是 time-context(75) / runtime-context(27) / model-selection / skill-catalog /
 *       agent-instructions …… 不过滤就会把系统注入当成"用户说过的话"记进知识库。
 *
 * 两个必须记住的限制：
 *   ① 正在进行的会话，磁盘上只有**上次 flush** 的部分，最后几分钟读不到。
 *      所以提炼只能在「这段对话之后」发生，不能在对话之中完成。
 *   ② 助手消息里有 tool-call / tool-result 块，抽文字时要跳过，否则会把工具参数
 *      （含密钥）当成"我说的话"。
 * ============================================================================
 */
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 人说的话的 source.kind（其余一律视为系统注入） */
const HUMAN_KINDS = new Set(['user', 'human', 'prompt'])

/** 从多帧 zstd 里解出 JSONL 文本。 */
export function decompressSession(buf) {
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) offsets.push(i)
  }
  if (!offsets.length) throw new Error('不是 zstd 多帧（找不到帧头 0xFD2FB528）')
  let text = ''
  let bad = 0
  for (let k = 0; k < offsets.length; k++) {
    const s = offsets[k]
    const e = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(s, e)).toString('utf8')
    } catch { bad++ }
  }
  return { text, frames: offsets.length, badFrames: bad }
}

/** JSONL 文本 → 事件数组（坏行跳过，不整批失败）。 */
export function parseEvents(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (o && typeof o === 'object') out.push(o)
    } catch { /* 跳过坏行 */ }
  }
  return out
}

const partText = (p) => {
  if (typeof p === 'string') return p
  if (!p || typeof p !== 'object') return ''
  if (p.type === 'text') return p.text || ''
  // tool-call / tool-result / image 等一律不要——工具参数里可能有密钥、命令、路径
  return ''
}

/**
 * 一条消息里所有 text 块拼起来（跳过工具块）。
 * ⚠️ 两种存放位置都出现过，别只认一种：
 *   user/message      → data.content        （实测 2026-10-24）
 *   assistant/message → data.message.content
 */
export const msgText = (data) => {
  const blocks = data?.content || data?.message?.content || []
  return blocks.map(partText).join('').trim()
}

/** 这条 user/message 是不是真人说的。 */
export const isHuman = (ev) => {
  if (ev?.type !== 'user/message') return false
  const k = ev.data?.source?.kind
  return k ? HUMAN_KINDS.has(k) : true
}

/**
 * 事件流 → 对话（只留人说的话 + 我当时写出来的文字）。
 * skipBefore: 只保留 time > skipBefore 的（增量用）
 */
export function toDialog(events, opts = {}) {
  const skipBefore = Number(opts.skipBefore || 0)
  const maxUser = Number(opts.maxUser || 80)       // 每次最多带多少条人话，防爆上下文
  const maxChars = Number(opts.maxChars || 260)
  const users = []
  const replies = []      // 与 users 一一对应：replies[i] 是第 i 条人话之后我说的话
  let userCount = 0
  const timing = (ev) => Number(ev.time || ev.data?.time || 0)

  for (const ev of events) {
    const t = timing(ev)
    if (skipBefore && t && t <= skipBefore) continue
    if (ev.type === 'user/message' && isHuman(ev)) {
      const text = msgText(ev.data)
      if (!text) continue
      userCount++
      users.push({ time: t, text })
      replies.push('')
    } else if (ev.type === 'assistant/message') {
      const text = msgText(ev.data)
      if (!text || !userCount) continue
      const i = userCount - 1          // 挂到「最近一条人话」下面，形成「你说→我答」
      replies[i] = replies[i] ? replies[i] + '\n' + text : text
    }
  }

  const trimmed = users.slice(-maxUser)
  const start = users.length - trimmed.length          // 丢掉前多少条
  const cut = (s) => (s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s)
  const pairs = trimmed.map((u, i) => ({
    time: u.time,
    user: cut(u.text),
    reply: replies[start + i] ? cut(replies[start + i]) : '',
  }))
  return {
    users: users.length,
    kept: pairs.length,
    lastTime: users.length ? users[users.length - 1].time : 0,
    pairs,
  }
}

/** 当前本机时区下的「今天 00:00」时间戳。 */
export const startOfToday = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

/**
 * 扫会话根目录，找「今天改动过」的会话文件。
 * 返回 [{ file, mtime, size, workspace }]，新的在前。
 * 只找文件名是 session.v4.jsonl.zstd 的，且 mtime >= since。
 */
export function findTodaysSessions(sessionsRoot, opts = {}) {
  const since = Number(opts.since || startOfToday())
  const want = String(opts.fileName || 'session.v4.jsonl.zstd')
  const maxDirs = Number(opts.maxDirs || 800)
  const out = []
  if (!existsSync(sessionsRoot)) return out
  let visited = 0
  const walk = (dir, workspace, depth) => {
    if (depth > 3 || visited > maxDirs) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (++visited > maxDirs) return
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        walk(p, workspace || e.name, depth + 1)
        continue
      }
      if (e.name !== want) continue
      let st
      try { st = statSync(p) } catch { continue }
      if (st.mtimeMs < since) continue
      out.push({ file: p, mtime: st.mtimeMs, size: st.size, workspace: workspace || '' })
    }
  }
  walk(sessionsRoot, '', 0)
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/**
 * 读一个会话文件 → { users, kept, lastTime, pairs, frames, badFrames }。
 * 大文件只解尾部（默认 24MB 原始字节），够拿最近几个小时的对话。
 */
export function readSession(file, opts = {}) {
  const tailBytes = Number(opts.tailBytes || 24 * 1024 * 1024)
  const full = readFileSync(file)
  const buf = full.length > tailBytes ? full.subarray(full.length - tailBytes) : full
  // 截掉头部后第一个帧头之前的残片，否则第一帧是坏的（无害，解压会失败被计数）
  const { text, frames, badFrames } = decompressSession(buf)
  const events = parseEvents(text)
  const dlg = toDialog(events, opts)
  return { ...dlg, events: events.length, frames, badFrames, bytes: full.length }
}
