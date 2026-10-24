/**
 * lib/recycle.mjs —— 回收站（AI 判断可以删的笔记，先搬到这里，3 个月后自动真删）
 * ============================================================================
 * 为什么要有它（用户 2026-10-24 定的规则）：
 *   「可以删除 ai 觉得可以删除的内容，在每天复盘思考学习的时候它可以进行判断，
 *     不是一定要删，可以删除他觉得可以删除的」
 *   「删除到回收站里只保留 3 个月，到期直接删除」
 *
 * 分工：
 *   · 规则（tidy.mjs）只管「机器判得准的」——空文件、逐字节重复。
 *   · 模型（复盘）才管「这篇还有没有价值」——它读得懂内容，判断得了冗余/过时/没结论。
 *     但它不直接 unlink，只**搬到** 9.归档/回收站/，附一份理由。
 *   · 3 个月后由 purge() 真删。所以模型有删除权，人还有反悔期。
 *
 * 目录布局：
 *   9.归档/回收站/<YYYY-MM-DD>/<原相对路径>.md
 *   9.归档/回收站/<YYYY-MM-DD>/_清单.md   ← 这一天收了什么、为什么、原来在哪
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, rmdirSync, unlinkSync, statSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { dayKey, stamp } from './schedule.mjs'
import { atomicWrite } from './vault.mjs'

/** 回收站相对路径 */
export const BIN_REL = '9.归档/回收站'
/** 保留多少天（3 个月按 90 天算） */
export const KEEP_DAYS = 90
/** 单次复盘最多搬多少篇进回收站（防止模型一次清空半个库） */
export const MAX_TRASH_PER_RUN = 20

const dayOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 把 'YYYY-MM-DD' 解析成毫秒时间戳（本地零点）；非法返回 null */
const msOfDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''))
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  return Number.isFinite(t) ? t : null
}

/** 这个相对路径能不能进回收站（归档区、配置目录一律不动，防递归） */
const noTrash = (rel) => {
  const r = String(rel || '').replace(/\\/g, '/')
  return !r || r === BIN_REL || r.startsWith(BIN_REL + '/') || r.startsWith('9.归档/') || r.startsWith('.obsidian') || r.startsWith('.trash')
}

/**
 * 把一篇笔记搬进回收站。
 * @returns {{ok:true,to:string}|{ok:false,error:string}}
 */
export function trash(vaultPath, rel, reason) {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (noTrash(r)) return { ok: false, error: '这个位置不进回收站' }
  const from = join(vaultPath, r)
  if (!existsSync(from)) return { ok: false, error: '源不在了' }
  try {
    if (!statSync(from).isFile()) return { ok: false, error: '不是文件' }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }

  const day = dayKey()
  const dirRel = `${BIN_REL}/${day}`
  const dir = join(vaultPath, dirRel)
  // 同名冲突：加序号，别覆盖回收站里已有的东西
  let toRel = `${dirRel}/${r}`
  let to = join(vaultPath, toRel)
  let n = 1
  while (existsSync(to)) {
    toRel = `${dirRel}/${r.replace(/\.md$/i, '')} (${n}).md`
    to = join(vaultPath, toRel)
    n++
    if (n > 50) return { ok: false, error: '同名太多，放弃' }
  }
  try {
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    // 记一笔：谁、为什么、从哪来
    const listRel = `${dirRel}/_清单.md`
    const listPath = join(vaultPath, listRel)
    const fresh = !existsSync(listPath)
    const head = fresh
      ? ['---', `title: 回收站 ${day}`, 'type: log', `date: ${day}`, 'tags: [回收站, 清理]', '---', '', `# 回收站 ${day}`, '', `> 这里的东西是 AI 在复盘时判断「已经没价值」搬进来的。保留 ${KEEP_DAYS} 天，到期自动真删。想留就把它搬回原来的位置。`, '']
      : ['']
    const lines = [
      ...head,
      `## ${stamp()}`,
      '',
      `- \`${r}\` —— 理由：${String(reason || '（模型没写理由）').slice(0, 300)}`,
      `- 还原：搬回 \`${r}\``,
      '',
    ]
    writeFileSync(listPath, lines.join('\n') + '\n', 'utf8')
    return { ok: true, to: toRel }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 列回收站里所有「按日期分的桶」：{ day, dir, ms, ageDays }[]，按时间从旧到新 */
export function buckets(vaultPath, now = Date.now()) {
  const root = join(vaultPath, BIN_REL)
  let names = []
  try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  const out = []
  for (const name of names) {
    const ms = msOfDay(name)
    if (ms == null) continue
    out.push({ day: name, dir: join(root, name), ms, ageDays: Math.floor((now - ms) / 86_400_000) })
  }
  return out.sort((a, b) => a.ms - b.ms)
}

/** 干跑：到期该真删的有几篇、几个桶 */
export function purgePreview(vaultPath, now = Date.now()) {
  const due = buckets(vaultPath, now).filter((b) => b.ageDays >= KEEP_DAYS)
  let files = 0
  for (const b of due) files += countFiles(b.dir)
  return { days: KEEP_DAYS, dueBuckets: due.map((b) => b.day), dueFiles: files }
}

function countFiles(dir) {
  let n = 0
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of ents) {
    if (e.isDirectory()) n += countFiles(join(dir, e.name))
    else n += 1
  }
  return n
}

function rmTree(p) {
  let ents = []
  try { ents = readdirSync(p, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const q = join(p, e.name)
    if (e.isDirectory()) rmTree(q)
    else { try { unlinkSync(q) } catch { /* 单个删不掉就算了 */ } }
  }
  try { rmdirSync(p) } catch { /* 非空/占用就留着 */ }
}

/**
 * 真删到期的东西。
 * 只删「按日期命名的桶」且 ageDays >= KEEP_DAYS 的；桶里的东西全部真删。
 * @returns {{ok:true, deletedBuckets:string[], deletedFiles:number, kept:number}}
 */
export function purge(vaultPath, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const days = Number.isFinite(opts.days) ? opts.days : KEEP_DAYS
  const all = buckets(vaultPath, now)
  const due = all.filter((b) => b.ageDays >= days)
  const deletedBuckets = []
  let deletedFiles = 0
  for (const b of due) {
    const n = countFiles(b.dir)
    // 防呆：确认这个桶真的在回收站之下（防止 buckets 拿错路径）
    try {
      const real = join(b.dir)
      if (!real.startsWith(join(vaultPath, BIN_REL))) { log(`跳过可疑目录：${real}`); continue }
    } catch { continue }
    rmTree(b.dir)
    deletedBuckets.push(b.day)
    deletedFiles += n
    log(`回收站：真删 ${b.day} 那一批（${n} 个文件，已放 ${b.ageDays} 天）`)
  }
  const kept = all.length - deletedBuckets.length
  return { ok: true, deletedBuckets, deletedFiles, kept }
}

/**
 * 列出回收站里现存的所有笔记（给「还原」和体检用）
 * @returns {{rel:string, origRel:string, day:string, from:string}[]}
 */
export function listItems(vaultPath) {
  const out = []
  for (const b of buckets(vaultPath)) {
    const walk = (dir, prefix) => {
      let ents = []
      try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        if (e.isDirectory()) { walk(join(dir, e.name), `${prefix}${e.name}/`); continue }
        if (!/\.md$/i.test(e.name) || e.name === '_清单.md') continue
        out.push({ rel: `${BIN_REL}/${b.day}/${prefix}${e.name}`, origRel: `${prefix}${e.name}`, day: b.day, from: join(dir, e.name) })
      }
    }
    walk(b.dir, '')
  }
  return out
}

/** 把回收站里的某一篇还原回原位（原位已有东西就不覆盖） */
export function restore(vaultPath, itemRel) {
  const r = String(itemRel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!r.startsWith(BIN_REL + '/')) return { ok: false, error: '不是回收站里的路径' }
  const src = join(vaultPath, r)
  if (!existsSync(src)) return { ok: false, error: '源不在了' }
  // 9.归档/回收站/<day>/<origRel>
  const rest = r.slice((BIN_REL + '/').length)
  const slash = rest.indexOf('/')
  if (slash < 0) return { ok: false, error: '路径形状不对' }
  const origRel = rest.slice(slash + 1)
  if (!origRel) return { ok: false, error: '找不到原路径' }
  const dst = join(vaultPath, origRel)
  if (existsSync(dst)) return { ok: false, error: `原位已经有东西（${origRel}），我不覆盖` }
  try {
    mkdirSync(dirname(dst), { recursive: true })
    renameSync(src, dst)
    return { ok: true, to: origRel }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}
