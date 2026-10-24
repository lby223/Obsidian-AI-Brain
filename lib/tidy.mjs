// lib/tidy.mjs —— 知识库「体检 + 受限整理」
//
// 设计原则（为什么不用模型来整理）：
//   1. 体检只做「机器判得准」的硬错：编号撞车、同名嵌套目录、空文件、
//      未来日期、索引与目录同名、顶层/编号目录里散落的笔记。
//      这些都能用规则判出来，不需要模型，也不会每次给出不同答案。
//   2. 整理只做「移动/改名」，**绝不删除**，而且只按固定规则表动，
//      单次有上限、有清单、有报告，可回滚。
//   3. 不确定的（比如「这篇该归哪个项目」）只报告 + 给建议，不动手——
//      那是复盘时模型该判断的事。
//
// 规则表（整理时会执行的动作）：
//   R1 同名嵌套目录  X/X/**            → X/**（合并上去，删掉空壳）
//   R2 索引与目录同名 X/X.md           → X/0.索引.md
//   R3 探索散落      N.探索/*.md       → N.探索/综合/
//   R4 领域踩坑      N.领域/*.md（标题含踩坑词） → N.领域/踩坑/
//   R5 项目同名      N.项目/<名>.md 且存在 N.项目/<名>/ → 移入该目录
//
// 禁地（绝不移动）：3.自我/、社交人格/、9.归档/、.obsidian/

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

/** 规范的顶层目录与编号（0.导读.md 里那张表就是这套） */
export const CANON = ['0.收件箱', '1.项目', '2.领域', '3.自我', '4.AI手册', '5.日记', '6.资料', '7.探索', '9.归档']
/** 不打编号、但属于体系的目录 */
export const UNNUMBERED = ['社交人格']
/** 顶层可以裸放的文件 */
const ROOT_KEEP = /^(0\.导读\.md|README\.md)$/i
/** 编号目录里可以裸放的「索引类」笔记 */
const INDEX_OK = /(索引|导读)$/
/** 根下就该放日期笔记的目录：收件箱 / 日记 */
const DATED_DIRS = /^\d+\.(收件箱|日记)$/
/** 纯日期文件名（2026-10-23.md）——这两种地方的根目录本来就长这样 */
const DATED_FILE = /^\d{4}-\d{2}-\d{2}\.md$/i
/** 绝不移动的目录（相对 vaultPath） */
const FORBIDDEN = ['3.自我', '社交人格', '9.归档', '.obsidian', '.trash']
/** 单次整理最多移动多少个（防「一次搬干净整个库」） */
export const MAX_MOVES = 40
/** 踩坑类标题的特征词 */
const PITFALL_RE = /(陷阱|踩坑|报错|失效|不能|别用|卡住|坑)/

const readText = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
const numOf = (name) => { const m = /^(\d+)\./.exec(name); return m ? Number(m[1]) : null }
const dayOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 抓 frontmatter 里的简单 key: value（够用就行，不引 YAML 库） */
const frontmatter = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const o = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return o
}

const forbid = (rel) => FORBIDDEN.some((f) => rel === f || rel.startsWith(f + '/'))

const listDirs = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] } }
const listFiles = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name) } catch { return [] } }

/** 找出体系里那个「探索」目录的实际名字（现在是 7.探索，将来可能是 7.探索） */
const exploreDir = (tops) => tops.find((t) => /^\d+\.探索$/.test(t)) || ''
const domainDir = (tops) => tops.find((t) => /^\d+\.领域$/.test(t)) || ''
const projectDir = (tops) => tops.find((t) => /^\d+\.项目$/.test(t)) || ''

// ── 探索索引：把「全部笔记」清单做成自动维护的一段 ──────────────────────────
// 为什么：索引靠人（或模型）维护一定会漂——2026-10-24 实测库里 15 篇、索引只列了 3 篇。
// 所以把「完整清单」交给规则生成，夹在两个标记之间；手写的分类导读放在标记外，两边互不打扰。
export const IDX_BEGIN = '<!-- AUTO:BEGIN 这一段由「知识库整理」自动生成，手改会被下次覆盖 -->'
export const IDX_END = '<!-- AUTO:END -->'
const AUTO_HEAD = '## 全部笔记（自动维护）'
const ONE_LINER_RE = /^>\s*\*\*一句话结论\*\*[：:]\s*(.*)$/
// 列表里不放链接语法：一句话结论常引用别的笔记，`[[名]]` 会在这里变成意外的链接，
// 而且截断可能留下半个 `[[`（渲染成怪字符）。所以先把链接拍平成纯文本，再截断。
const plain = (s) => String(s || '')
  .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
  .replace(/\[\[([^\]]+)\]\]/g, '$1')
  .replace(/\[\[[^\]]*$/, '')
  .replace(/\]\]/g, '')
const clip = (s, n = 110) => { const t = plain(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/[\s，、；：,;:（(]+$/, '') + '…' : t }

/** 从一篇笔记里抠出「一句话结论」；没有就用第一段正文兜底 */
const digest = (text) => {
  const title = (frontmatter(text).title || '').trim()
  let one = ''
  for (const raw of text.split(/\r?\n/)) {
    const m = ONE_LINER_RE.exec(raw.trim())
    if (m) { one = m[1].trim(); break }
  }
  if (!one) {
    let fences = 0
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '---') { fences++; continue }
      if (fences < 2) continue
      if (!line || line.startsWith('#') || line.startsWith('>') || line.startsWith('|') || line.startsWith('```')) continue
      one = line.replace(/[*`[\]]/g, '').trim(); break
    }
  }
  return { title: title || clip(one, 24), one: clip(one) }
}

/** 递归列出「探索」下的所有 .md（相对探索目录），跳过索引自己 */
const walkNotes = (dir, rel = '') => {
  const out = []
  for (const name of listFiles(join(dir, rel))) {
    if (!name.toLowerCase().endsWith('.md')) continue
    if (INDEX_OK.test(basename(name, '.md'))) continue
    out.push(rel ? `${rel}/${name}` : name)
  }
  for (const sub of listDirs(join(dir, rel))) out.push(...walkNotes(dir, rel ? `${rel}/${sub}` : sub))
  return out
}

/** 生成「全部笔记」那一段（纯函数，可在临时库上测） */
export function exploreIndexBlock(explorePath) {
  const rels = walkNotes(explorePath)
  const groups = new Map()
  for (const rel of rels) {
    const parts = rel.split('/')
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
    const { one } = digest(readText(join(explorePath, rel)))
    if (!groups.has(folder)) groups.set(folder, [])
    groups.get(folder).push({ name: basename(rel, '.md'), one })
  }
  // 根目录排最后（它是「还没归进子目录」的那批）
  const order = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'zh')))
  const lines = [IDX_BEGIN, '', AUTO_HEAD, '', `> 共 ${rels.length} 篇。这一段自动生成，手写的东西放在两个标记外面。`, '']
  for (const g of order) {
    const list = groups.get(g).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    lines.push(`### ${g || '（还没归进子目录）'}（${list.length} 篇）`, '')
    for (const x of list) lines.push(`- [[${x.name}]]${x.one ? ' — ' + x.one : ''}`)
    lines.push('')
  }
  lines.push(IDX_END)
  return { text: lines.join('\n'), total: rels.length, names: rels.map((r) => basename(r, '.md')) }
}

/** 找到探索索引文件（名字里有「索引」的那个），没有就按约定叫「探索索引.md」 */
const indexFileOf = (explorePath) => listFiles(explorePath).find((f) => /索引\.md$/i.test(f)) || '探索索引.md'

/** 把自动段写进索引：有标记就替换标记之间，没有就追加。内容没变就不碰文件（幂等） */
export function rebuildExploreIndex(vaultPath, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const ex = exploreDir(listDirs(vaultPath))
  if (!ex) return { ok: false, error: '找不到「探索」目录' }
  const explorePath = join(vaultPath, ex)
  const idxName = indexFileOf(explorePath)
  const idxPath = join(explorePath, idxName)
  const block = exploreIndexBlock(explorePath)
  const old = existsSync(idxPath) ? readText(idxPath) : ''
  let next
  if (old.includes(IDX_BEGIN) && old.includes(IDX_END)) {
    next = old.slice(0, old.indexOf(IDX_BEGIN)) + block.text + old.slice(old.indexOf(IDX_END) + IDX_END.length)
  } else {
    const head = old.trim()
      ? old.replace(/\s*$/, '') + '\n\n'
      : `---\ntitle: ${ex}\ntype: note\ndate: ${dayOf()}\ntags: [索引, 探索]\n---\n\n# ${ex} —— AI 逛互联网的产物\n\n`
    next = head + block.text + '\n'
  }
  if (next === old) return { ok: true, changed: false, indexRel: `${ex}/${idxName}`, total: block.total }
  try {
    writeFileSync(idxPath, next, 'utf8')
    log(`整理：刷新探索索引 ${ex}/${idxName}（收录 ${block.total} 篇）`)
    return { ok: true, changed: true, indexRel: `${ex}/${idxName}`, total: block.total }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}

// ────────────────────────── 体检 ──────────────────────────

export function scan(vaultPath) {
  const issues = []
  const add = (o) => issues.push(o)
  if (!existsSync(vaultPath)) return { ok: false, error: '库路径不存在：' + vaultPath, issues: [] }

  const tops = listDirs(vaultPath).filter((t) => t !== '.obsidian' && t !== '.trash')

  // ① 编号撞车：两个目录占同一个号
  const byNum = new Map()
  for (const t of tops) { const n = numOf(t); if (n != null) { if (!byNum.has(n)) byNum.set(n, []); byNum.get(n).push(t) } }
  for (const [n, names] of byNum) {
    if (names.length < 2) continue
    const keep = names.find((x) => CANON.includes(x)) || names[0]
    const dup = names.filter((x) => x !== keep)
    add({
      kind: 'number-clash', level: 'error',
      title: `编号「${n}」被两个目录占用：${names.join(' / ')}`,
      paths: names,
      fix: `建议把「${dup.join('、')}」改到规范编号（如 7.探索）。注意要同步改 0.导读.md、install.py 的 FOLDERS、复盘白名单——这不是「整理」能自动做干净的事`,
    })
  }

  // ② 顶层目录不在体系里
  for (const t of tops) {
    if (CANON.includes(t) || UNNUMBERED.includes(t)) continue
    add({ kind: 'dir-unknown', level: 'warn', title: `顶层目录不在编号体系里：${t}`, paths: [t], fix: '要么并进已有编号目录，要么登记到 0.导读.md 的表里' })
  }

  // ③ 顶层裸文件
  for (const f of listFiles(vaultPath)) {
    if (!/\.md$/i.test(f)) continue
    if (ROOT_KEEP.test(f)) continue
    add({ kind: 'stray-root', level: 'warn', title: `顶层散落笔记：${f}`, paths: [f], fix: '顶层只该有 0.导读.md；建议移进对应编号目录（资料类→6.资料/参考/）' })
  }

  // ④ 编号目录内部
  for (const t of tops) {
    if (forbid(t) || t === '.obsidian') continue
    const tp = join(vaultPath, t)
    const subs = listDirs(tp)

    // 同名嵌套目录 X/X
    for (const s of subs) {
      if (s !== t) continue
      add({ kind: 'nested-same-name', level: 'error', title: `${t}/${s}/ 是自己套自己（多半是建目录时多点了一层）`, paths: [`${t}/${s}`], fix: `把里面的东西合并到 ${t}/ 然后删掉空壳（整理能自动做）` })
    }

    // 索引笔记与目录同名 X/X.md
    for (const f of listFiles(tp)) {
      if (!/\.md$/i.test(f)) continue
      if (f === t + '.md') add({ kind: 'index-same-as-dir', level: 'warn', title: `${t}/${f} 和目录同名，在侧栏里看着像目录，容易点错`, paths: [`${t}/${f}`], fix: `改成 ${t}/0.索引.md（整理能自动做）` })
    }

    // 编号目录根下散落的笔记（索引类 / 日期笔记放行）
    for (const f of listFiles(tp)) {
      if (!/\.md$/i.test(f)) continue
      if (INDEX_OK.test(basename(f, '.md'))) continue
      if (DATED_FILE.test(f)) continue
      if (DATED_DIRS.test(t)) continue
      const rel = `${t}/${f}`
      if (!subs.length) continue
      add({ kind: 'stray-in-dir', level: 'warn', title: `${t}/ 根下散着笔记：${f}`, paths: [rel], fix: '整理会按规则表把它移进子目录；拿不准的会列在报告里让你定' })
    }
  }

  // ⑤ 全库扫：空文件 + 正文里的未来日期
  const today = dayOf()
  const walk = (p, rel, depth) => {
    if (depth > 4 || forbid(rel)) return
    for (const d of listDirs(p)) { if (d !== '.obsidian' && d !== '.trash') walk(join(p, d), rel ? `${rel}/${d}` : d, depth + 1) }
    for (const f of listFiles(p)) {
      if (!/\.md$/i.test(f)) continue
      const fp = join(p, f)
      let size = 0
      try { size = statSync(fp).size } catch { continue }
      const r = rel ? `${rel}/${f}` : f
      if (size === 0) { add({ kind: 'empty-file', level: 'warn', title: `空文件（0 字节）：${r}`, paths: [r], fix: '删还是留你自己定——整理不会删文件' }); continue }
      const text = readText(fp)
      const fm = frontmatter(text)
      const d = String(fm.date || '')
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d > today) {
        add({ kind: 'future-date', level: 'warn', title: `日期在未来：${r}（frontmatter date: ${d}，今天是 ${today}）`, paths: [r], fix: '多半是写出它的那次会话把日期编错了；改动有风险，只报告' })
      }
      // 文件名里的日期也要查：agent 写的笔记常常把日期编进文件名，而 frontmatter 由宿主补、是对的
      // （真实事故：逛互联网的笔记全写成 2026-11-05/06/07，比真实日期多出十几天）
      const nameDate = (f.match(/^(\d{4}-\d{2}-\d{2})/) || f.match(/-(\d{4}-\d{2}-\d{2})-/))?.[1]
      if (nameDate && nameDate > today) {
        add({ kind: 'future-date', level: 'warn', title: `文件名里的日期在未来：${r}（${nameDate}，今天是 ${today}）`, paths: [r], fix: '文件名可以安全改名（Obsidian 按 [[名字]] 解析，改名不断链）；先查是谁写的、为什么日期错' })
      }
    }
  }
  walk(vaultPath, '', 0)

  // ⑥ 探索索引是不是漏了新笔记（只报告；点「整理目录」能自动补）
  const EX = exploreDir(tops)
  if (EX) {
    const exPath = join(vaultPath, EX)
    const idxName = listFiles(exPath).find((f) => /索引\.md$/i.test(f))
    if (idxName) {
      const txt = readText(join(exPath, idxName))
      const listed = new Set([...txt.matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1].trim()))
      const block = exploreIndexBlock(exPath)
      const missing = block.names.filter((n) => !listed.has(n))
      if (missing.length) {
        add({
          kind: 'index-stale', level: 'warn',
          title: `探索索引没跟上：${EX}/${idxName} 里少了 ${missing.length} 篇（库里 ${block.names.length} 篇）`,
          paths: [`${EX}/${idxName}`],
          fix: `点「整理目录」会自动刷新那一段（夹在 AUTO:BEGIN/END 之间）；漏的：${missing.slice(0, 6).join('、')}${missing.length > 6 ? ' 等' : ''}`,
        })
      }
    }
  }

  const errors = issues.filter((i) => i.level === 'error').length
  return { ok: true, issues, summary: { total: issues.length, errors, warns: issues.length - errors } }
}

// ────────────────────────── 计划 ──────────────────────────

/** 按规则表算出这次要做的移动（不做任何写操作） */
export function plan(vaultPath) {
  const actions = []
  if (!existsSync(vaultPath)) return { ok: false, error: '库路径不存在', actions: [] }
  const tops = listDirs(vaultPath).filter((t) => t !== '.obsidian' && t !== '.trash')
  const EXP = exploreDir(tops)
  const DOM = domainDir(tops)
  const PRJ = projectDir(tops)

  const taken = new Set()
  const push = (op, from, to, why) => {
    if (taken.has(from)) return   // 同一个源只能被一条规则认领（R2 优先于 R3/R4）
    if (actions.length >= MAX_MOVES) return
    taken.add(from)
    actions.push({ op, from, to, why })
  }

  for (const t of tops) {
    if (forbid(t)) continue
    const tp = join(vaultPath, t)
    const subs = listDirs(tp)

    // R1 同名嵌套 X/X → X
    if (subs.includes(t)) {
      const nest = join(tp, t)
      for (const f of listFiles(nest)) push('move', `${t}/${t}/${f}`, `${t}/${f}`, `R1 修同名嵌套目录`)
      for (const d of listDirs(nest)) push('move', `${t}/${t}/${d}`, `${t}/${d}`, `R1 修同名嵌套目录`)
    }

    // R2 索引与目录同名 X/X.md → X/0.索引.md
    for (const f of listFiles(tp)) {
      if (f === t + '.md') push('rename', `${t}/${f}`, `${t}/0.索引.md`, 'R2 索引笔记与目录同名容易点错')
    }

    // R5 项目里「同名目录已存在」的散落笔记
    if (t === PRJ) {
      for (const f of listFiles(tp)) {
        if (!/\.md$/i.test(f) || INDEX_OK.test(basename(f, '.md'))) continue
        const stem = basename(f, '.md')
        if (subs.includes(stem)) push('move', `${t}/${f}`, `${t}/${stem}/${f}`, 'R5 已经有个同名项目目录')
      }
    }

    // R4 领域里的踩坑类笔记 → 2.领域/踩坑/
    if (t === DOM && subs.includes('踩坑')) {
      for (const f of listFiles(tp)) {
        if (!/\.md$/i.test(f) || INDEX_OK.test(basename(f, '.md'))) continue
        const stem = basename(f, '.md')
        const fmTitle = String(frontmatter(readText(join(tp, f))).title || '')
        if (PITFALL_RE.test(stem) || PITFALL_RE.test(fmTitle)) push('move', `${t}/${f}`, `${t}/踩坑/${f}`, 'R4 标题是踩坑类')
      }
    }

    // R3 探索散落笔记 → N.探索/综合/
    if (t === EXP) {
      for (const f of listFiles(tp)) {
        if (!/\.md$/i.test(f) || INDEX_OK.test(basename(f, '.md'))) continue
        push('move', `${t}/${f}`, `${t}/综合/${f}`, 'R3 自由逛的产物统一进「综合」')
      }
    }
  }

  return { ok: true, actions }
}

// ────────────────────────── 执行 ──────────────────────────

/**
 * 执行整理。绝不删除、绝不覆盖、绝不碰禁地。
 * @returns {{ok:boolean, moved:Array, skipped:Array, failed:Array, reportPath:string}}
 */
export function apply(vaultPath, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const { actions } = plan(vaultPath)
  const moved = [], skipped = [], failed = []

  for (const a of actions) {
    const fromRel = a.from, toRel = a.to
    if (forbid(fromRel) || forbid(toRel)) { skipped.push({ ...a, why: '落在禁地，跳过' }); continue }
    const from = join(vaultPath, fromRel), to = join(vaultPath, toRel)
    try {
      if (!existsSync(from)) { skipped.push({ ...a, why: '源不在了' }); continue }
      if (existsSync(to)) { skipped.push({ ...a, why: '目标已存在（不覆盖）' }); continue }
      mkdirSync(join(vaultPath, toRel.split('/').slice(0, -1).join('/')), { recursive: true })
      renameSync(from, to)
      moved.push(a)
      log(`整理：${fromRel} → ${toRel}（${a.why}）`)
    } catch (e) { failed.push({ ...a, error: String(e?.message ?? e) }); log(`整理失败：${fromRel} → ${toRel}：${e?.message ?? e}`) }
  }

  // 清掉 R1 留下的空壳目录（只删「空的」）
  const cache = []
  for (const t of listDirs(vaultPath)) {
    const nest = join(vaultPath, t, t)
    try { if (isDir(nest) && listFiles(nest).length === 0 && listDirs(nest).length === 0) { rmdirSync(nest); cache.push(`${t}/${t}`); log(`整理：删掉空壳目录 ${t}/${t}`) } } catch { /* 忽略 */ }
  }

  // 刷新探索索引的自动段（只动两个标记之间的内容，手写部分不碰）
  const index = rebuildExploreIndex(vaultPath, { log })

  // 写一份可回滚的报告
  let reportPath = ''
  try {
    const dir = join(vaultPath, '9.归档', '整理记录')
    mkdirSync(dir, { recursive: true })
    const d = new Date()
    const name = `${dayOf(d)}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.md`
    const lines = [
      '---', `title: 整理记录 ${dayOf(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, 'type: log', `date: ${dayOf(d)}`, 'tags: [整理, 体检]', '---', '',
      `# 整理记录 ${dayOf(d)}`, '',
      `移动 ${moved.length} 项，跳过 ${skipped.length} 项，失败 ${failed.length} 项。`, '',
      '## 移动清单（想撤回就按这个反着搬回去）', '',
      ...(moved.length ? moved.map((m) => `- \`${m.from}\` → \`${m.to}\`   _(${m.why})_`) : ['- （没有可自动整理的）']), '',
      ...(skipped.length ? ['## 跳过', '', ...skipped.map((s) => `- \`${s.from}\`：${s.why}`), ''] : []),
      ...(failed.length ? ['## 失败', '', ...failed.map((s) => `- \`${s.from}\` → \`${s.to}\`：${s.error}`), ''] : []),
    ]
    reportPath = `9.归档/整理记录/${name}`
    writeFileSync(join(dir, name), lines.join('\n'), 'utf8')
  } catch { /* 报告写不出来不影响整理本身 */ }

  return { ok: true, moved, skipped, failed, reportPath, removedShells: cache, index }
}
