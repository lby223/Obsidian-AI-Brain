/**
 * lib/sessiontail.mjs —— 功能 A：把「今天你说过的话」补进收件箱
 * ============================================================================
 * 解决的是这个缺陷：对话要不要记，全看模型某一步是否主动调 brain_capture。
 * 它不调，这段对话就消失了。
 *
 * 做法（每一跳都幂等，不重复写）：
 *   1. 扫 ~/.dsh/sessions/ 里今天改动过的 session.v4.jsonl.zstd
 *   2. 从每个会话里只抽人话（source.kind === 'user'）+ 我随后的文字回复
 *   3. 用 state.json 记「每个会话已经记到哪条时间戳」（watermark），只写新增的
 *   4. 新增内容追加进 0.收件箱/YYYY-MM-DD.md 的一个「会话尾巴」小节
 *   5. 交给 03:00 的复盘去提炼——这里只负责「别丢」，不负责「判断值不值得」
 *
 * 为什么不在这里就提炼：
 *   正在进行的会话，磁盘上只有上次 flush 的部分。所以提炼只能在「这段对话之后」
 *   发生。这里做的是"抢救"——把话存下来，判断留给复盘时的模型。
 *
 * 本文件不直接碰 state 文件：读写函数由调用方传进来（index.js 里有 readState/writeState）。
 * ============================================================================
 */
import * as sessions from './sessions.mjs'
import { appendNote, notePath, dayKey } from './vault.mjs'

export const TAIL_HEAD = '## 会话尾巴（插件自动抓的，等你复盘时再判断要不要留）'

const hhmm = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * @param {object} o
 * @param {string} o.vaultPath
 * @param {string} o.sessionsRoot
 * @param {object} o.state                当前 state 对象（会被展开后写回）
 * @param {(s:object)=>void} o.saveState  写回 state
 * @param {(m:string)=>void} [o.log]
 * @param {number} [o.maxUserPerSession]  每个会话每次最多带多少条
 * @param {number} [o.maxSessions]        单次最多处理几个会话文件
 * @param {Date}   [o.now]
 * @returns {{ok:boolean, added:number, sessions:number, skipped:number, error?:string}}
 */
export function captureSessionTail(o) {
  const { vaultPath, sessionsRoot, state, saveState } = o
  const log = o.log || (() => {})
  const now = o.now || new Date()
  const maxUserPerSession = Number(o.maxUserPerSession || 25)
  const maxSessions = Number(o.maxSessions || 6)
  const base = state && typeof state === 'object' ? state : {}
  if (!vaultPath) return { ok: false, added: 0, sessions: 0, skipped: 0, error: '没配知识库路径' }
  if (!sessionsRoot) return { ok: false, added: 0, sessions: 0, skipped: 0, error: '找不到会话目录' }

  const marks = (base.sessionTail && typeof base.sessionTail === 'object') ? { ...base.sessionTail } : {}
  const today = dayKey(now)
  const todayStart = sessions.startOfToday(now)

  let files = []
  try {
    files = sessions.findTodaysSessions(sessionsRoot, { since: todayStart })
  } catch (e) {
    return { ok: false, added: 0, sessions: 0, skipped: 0, error: `扫描会话失败：${e?.message ?? e}` }
  }
  if (!files.length) return { ok: true, added: 0, sessions: 0, skipped: 0 }

  let added = 0
  let touched = 0
  let skipped = 0
  const blocks = []

  for (const f of files.slice(0, maxSessions)) {
    let r
    try {
      r = sessions.readSession(f.file, { skipBefore: Number(marks[f.file] || 0), maxUser: maxUserPerSession })
    } catch (e) {
      skipped++
      log(`会话尾巴：读不了 ${f.workspace || f.file}（${e?.message ?? e}）`)
      continue
    }
    if (!r.pairs.length) continue
    // 只留今天的对话（跨零点的会话不要把昨天的话再抄一遍）
    const pairs = r.pairs.filter((p) => !p.time || p.time >= todayStart)
    if (!pairs.length) continue

    const lines = []
    for (const p of pairs) {
      lines.push(`- **${hhmm(p.time)} 你说**：${p.user.replace(/\n+/g, ' / ')}`)
      if (p.reply) {
        const one = p.reply.replace(/\n+/g, ' / ')
        lines.push(`  - 我当时答：${one.length > 200 ? one.slice(0, 199) + '…' : one}`)
      }
    }
    blocks.push(`### ${f.workspace || '（未知工作区）'} · ${hhmm(f.mtime)} 更新\n\n${lines.join('\n')}`)
    marks[f.file] = r.lastTime || (marks[f.file] || 0)
    added += pairs.length
    touched++
  }

  if (!blocks.length) {
    if (touched) saveState({ ...base, sessionTail: marks })
    return { ok: true, added: 0, sessions: 0, skipped }
  }

  const file = notePath(vaultPath, `0.收件箱/${today}.md`)
  const text = `\n\n${TAIL_HEAD}\n\n#### 抓取于 ${hhmm(now.getTime())}（${touched} 个会话、${added} 条对话）\n\n${blocks.join('\n\n')}\n`
  const w = appendNote(vaultPath, file, text)
  if (!w.ok) return { ok: false, added: 0, sessions: touched, skipped, error: `写收件箱失败：${w.error}` }
  saveState({ ...base, sessionTail: marks })
  log(`会话尾巴：从 ${touched} 个会话补进 ${added} 条对话 → 0.收件箱/${today}.md`)
  return { ok: true, added, sessions: touched, skipped }
}
