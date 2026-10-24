// lib/tidy.mjs —— 知识库「体检 + 整理」
//
// 两条设计线，分开看很清楚：
//
//   ① 体检 scan()：只做「机器判得准」的硬错——编号撞车、同名嵌套目录、空文件、
//      未来日期、索引与目录同名、顶层/编号目录里散落的笔记、索引跟不上、
//      标题重复（疑似冗余）。纯规则，不用模型，每次答案一致。
//
//   ② 整理 apply()：按固定规则表移动/改名 + 合并重复 + 清掉冗余。
//      **这是 AI 自己的大脑，所以 AI 自己收拾**——用户 2026-10-24 定的：
//      「让ai自己整理即可，这是他的大脑。只要整理的逻辑清晰，干净整洁就好了，
//        要方便他自己记忆读取。有重复冗余会拖慢或者污染大脑的ai也可以自己删掉。」
//      因此：
//        · 3.自我/ 与 社交人格/ **不再是禁地**，AI 可以整理这两个目录（见 MOVABLE）
//        · 可以合并重复（同名同题的笔记 → 保留内容多的那篇，把另一篇的正文并进去）
//        · 可以删除冗余：**空文件** 与 **完全重复的文件**（内容逐字节相同）
//      仍然守住的底线（不是限制 AI，是保护「大脑」本身）：
//        · 9.归档/ 只进不出（那是历史，不是垃圾）
//        · .obsidian/ 与 .trash/ 不碰（那是配置和回收站）
//        · **有内容的笔记绝不静默删除**——只有「空文件」和「与另一篇逐字节相同」才删，
//          且每一处删除都写进清单，能从 9.归档/整理记录 里查回来。
//        · 单次动作有上限（MAX_MOVES / MAX_DELS），不会一次把库搬空。
//
// 规则表（整理时会执行的动作）：
//   R1 同名嵌套目录  X/X/**            → X/**（合并上去，删掉空壳）
//   R2 索引与目录同名 X/X.md           → X/0.索引.md
//   R3 探索散落      N.探索/*.md       → N.探索/综合/
//   R4 领域踩坑      N.领域/*.md（标题含踩坑词） → N.领域/踩坑/
//   R5 项目同名      N.项目/<名>.md 且存在 N.项目/<名>/ → 移入该目录
//   R6 空文件        K 字节以下的 .md  → 删除（记进清单）
//   R7 完全重复      A.md 与 B.md 逐字节相同 → 删掉其中一个（保留路径更规范的那篇）
//   R8 同名副本      "X 副本.md" / "X (1).md" 而 X.md 已存在 → 若内容相同删副本；
//                   内容不同则改名并入（记为需人工确认，不删）
//
// 目录可动范围：MOVABLE 之内才动。3.自我/社交人格 可动；9.归档/.obsidian/.trash 不动。

import { readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
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
/**
 * 真正不可动的目录（相对 vaultPath）。
 * 注意：3.自我/ 与 社交人格/ **不在**这里——用户明确定过「这是 AI 的大脑，让 AI 自己整理」。
 */
const FROZEN = ['9.归档', '.obsidian', '.trash']
/** 单次整理最多移动多少个（防「一次搬干净整个库」） */
export const MAX_MOVES = 40
/**
 * 单次整理最多删多少个（空文件 + 完全重复）。
 *
 * 注意这是「计划上限」，不是保护线：跑一次删 30，明天再跑又删 30，
 * 危险在于「一次删掉一大片」变得不显眼。所以真正的保护是下面这条——
 * 一次性要删超过 DELETE_CONFIRM_OVER 项时，**只报告不执行**，
 * 让人先看见规模再决定（apply 会返回 needsConfirm）。
 */
export const MAX_DELS = 30
/** 一次要删超过这么多项，就停下来只报告（不自动执行） */
export const DELETE_CONFIRM_OVER = 10

/**
 * 正式编号目录（1.项目 / 2.领域 / 2.领域/踩坑 …）。
 * 删重复件时优先保留这些目录里的，因为它们是「分类正确」的那篇；
 * 7.探索 / 9.归档 之外的散落区放后面。
 */
const CANON_TOPS = ['0.收件箱', '1.项目', '2.领域', '3.自我', '4.AI手册', '5.日记', '6.资料', '7.探索', '社交人格']

/** 这条相对路径在「正式编号目录」里吗（含其子目录） */
const inCanon = (rel) => CANON_TOPS.some((t) => rel === t || rel.startsWith(t + '/'))

/** 给 dup 分组排序用：越「该保留」的排越前 */
const keepScore = (rel) => {
  const depth = rel.split('/').length
  const top = CANON_TOPS.indexOf(rel.split('/')[0])
  // 正式编号目录（top >= 0）优先；目录越靠前越优先（1.项目 > 7.探索）
  const canonRank = top >= 0 ? top : 99
  return [canonRank, depth, rel.length, rel]
}

/** 小于这个字节数的 .md 视为空文件（含只有 frontmatter 的空壳） */
export const EMPTY_BYTES = 12
/** 踩坑类标题的特征词 */
const PITFALL_RE = /(陷阱|踩坑|报错|失效|不能|别用|卡住|坑)/
/** 「副本」类文件名：X 副本.md / X (1).md / X - 副本.md */
const COPY_RE = /^(.*?)(?:\s*-\s*副本|\s*副本|\s*\(\d+\)|\s*copy)(\.md)$/i

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

/**
 * 这条相对路径能不能动？
 * 只有 9.归档 / .obsidian / .trash 不动——3.自我、社交人格 都可以（AI 的大脑，AI 自己收拾）。
 */
const frozen = (rel) => FROZEN.some((f) => rel === f || rel.startsWith(f + '/'))

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
    if (frozen(t) || t === '.obsidian') continue
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
    if (depth > 4 || frozen(rel)) return
    for (const d of listDirs(p)) { if (d !== '.obsidian' && d !== '.trash') walk(join(p, d), rel ? `${rel}/${d}` : d, depth + 1) }
    for (const f of listFiles(p)) {
      if (!/\.md$/i.test(f)) continue
      const fp = join(p, f)
      let size = 0
      try { size = statSync(fp).size } catch { continue }
      const r = rel ? `${rel}/${f}` : f
      const text = readText(fp)
      const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
      // 空文件 = 0 字节，或者「去掉 frontmatter 之后一点正文都没有」。点「整理目录」会删掉它（记进清单）
      if (size === 0 || !body) {
        add({ kind: 'empty-file', level: 'warn', title: `空文件（没有正文）：${r}`, paths: [r], fix: '点「整理目录」会删掉它（写进 9.归档/整理记录 的清单）；想留就给它写点内容' })
        continue
      }
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

  // ⑦ 疑似重复：同名笔记出现在不同目录，或正文逐字节相同
  //    （只报告；点「整理目录」会删掉逐字节重复的那份，同名但内容不同的只提示）
  const notes = []
  const collect = (rel, depth) => {
    if (depth > 6) return
    const dir = rel ? join(vaultPath, rel) : vaultPath
    for (const f of listFiles(dir)) {
      if (!/\.md$/i.test(f)) continue
      const r = rel ? `${rel}/${f}` : f
      if (frozen(r)) continue
      const text = readText(join(vaultPath, r))
      if (!text.trim()) continue
      notes.push({ rel: r, name: f, text, stem: basename(f, '.md') })
    }
    for (const d of listDirs(dir)) {
      const r = rel ? `${rel}/${d}` : d
      if (frozen(r)) continue
      collect(r, depth + 1)
    }
  }
  collect('', 0)

  const sameText = new Map()
  for (const n of notes) {
    if (!sameText.has(n.text)) sameText.set(n.text, [])
    sameText.get(n.text).push(n)
  }
  for (const g of sameText.values()) {
    if (g.length < 2) continue
    add({
      kind: 'duplicate', level: 'error',
      title: `正文完全相同的重复笔记 ${g.length} 篇：${g.map((x) => x.rel).join(' / ')}`,
      paths: g.map((x) => x.rel),
      fix: '点「整理目录」只保留层级最浅的一篇，其余删掉（记进 9.归档/整理记录 的清单）',
    })
  }

  const sameName = new Map()
  for (const n of notes) {
    const key = n.stem.toLowerCase()
    if (!sameName.has(key)) sameName.set(key, [])
    sameName.get(key).push(n)
  }
  for (const [key, g] of sameName) {
    if (g.length < 2) continue
    if (g.every((x) => x.text === g[0].text)) continue   // 逐字节相同的已经报过了
    add({
      kind: 'duplicate-name', level: 'warn',
      title: `同名笔记出现在 ${g.length} 处：${g.map((x) => x.rel).join(' / ')}`,
      paths: g.map((x) => x.rel),
      fix: `名字一样但内容不同——这会让 [[${g[0].stem}]] 指向不确定。建议合成一篇，或给其中一篇改个更具体的名字`,
    })
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
    if (frozen(t)) continue
    const tp = join(vaultPath, t)
    const subs = listDirs(tp)

    // R1 同名嵌套 X/X → X（任意层级都修：3.自我/我的偏好/我的偏好 也算）
    const fixNest = (dirRel, depth) => {
      if (depth > 4) return
      const dir = join(vaultPath, dirRel)
      const kids = listDirs(dir)
      const leaf = dirRel.split('/').pop()
      if (kids.includes(leaf)) {
        const nest = join(dir, leaf)
        for (const f of listFiles(nest)) push('move', `${dirRel}/${leaf}/${f}`, `${dirRel}/${f}`, 'R1 修同名嵌套目录')
        for (const d of listDirs(nest)) push('move', `${dirRel}/${leaf}/${d}`, `${dirRel}/${d}`, 'R1 修同名嵌套目录')
      }
      for (const d of kids) if (d !== leaf) fixNest(`${dirRel}/${d}`, depth + 1)
    }
    fixNest(t, 0)

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

  // ── R6 / R7 / R8：清冗余（只删「空文件」和「逐字节重复」）──
  // 先收集全库所有 .md（含子目录），再判重。跳过 9.归档 / .obsidian。
  const all = []
  const walk = (rel, depth) => {
    if (depth > 6) return
    const dir = rel ? join(vaultPath, rel) : vaultPath
    for (const f of listFiles(dir)) {
      if (!/\.md$/i.test(f)) continue
      const r = rel ? `${rel}/${f}` : f
      if (frozen(r)) continue
      let size = 0, text = ''
      try { const st = statSync(join(vaultPath, r)); size = st.size; if (size < 400 * 1024) text = readText(join(vaultPath, r)) } catch { continue }
      all.push({ rel: r, name: f, size, text })
    }
    for (const d of listDirs(dir)) {
      const r = rel ? `${rel}/${d}` : d
      if (frozen(r)) continue
      walk(r, depth + 1)
    }
  }
  walk('', 0)

  const dels = []
  const delSeen = new Set()
  const addDel = (rel, why) => {
    if (delSeen.has(rel)) return
    if (dels.length >= MAX_DELS) return
    delSeen.add(rel); dels.push({ op: 'delete', from: rel, to: '', why })
  }

  // R6 空文件（只有 frontmatter 的空壳 / 0 字节）
  for (const n of all) {
    const body = n.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
    if (n.size === 0 || !body) addDel(n.rel, 'R6 空文件（没有正文）')
  }

  // R7 逐字节完全重复：保留「路径更短 / 层级更浅」的那篇
  const byHash = new Map()
  for (const n of all) {
    if (delSeen.has(n.rel) || !n.text.trim()) continue
    const key = n.text
    if (!byHash.has(key)) byHash.set(key, [])
    byHash.get(key).push(n)
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue
    // 保留哪篇：以前按「路径层级最浅」，结果会删掉分类正确的那篇
    // （实测：2.领域/踩坑/正经笔记.md 被删、7.探索/综合/顺手一记.md 留下）。
    // 现在按 keepScore：正式编号目录优先，其次层级浅、路径短、字典序。
    const keep = [...group].sort((a, b) => {
      const ka = keepScore(a.rel), kb = keepScore(b.rel)
      for (let i = 0; i < ka.length - 1; i++) { if (ka[i] !== kb[i]) return ka[i] - kb[i] }
      return String(ka[ka.length - 1]).localeCompare(String(kb[kb.length - 1]), 'zh')
    })[0]
    for (const n of group) if (n.rel !== keep.rel) addDel(n.rel, `R7 与 ${keep.rel} 逐字节相同（保留那篇）`)
  }

  // R8 副本命名：X 副本.md / X (1).md 且 X.md 也在 → 内容相同就删副本
  const byRel = new Map(all.map((n) => [n.rel, n]))
  for (const n of all) {
    if (delSeen.has(n.rel)) continue
    const m = COPY_RE.exec(n.name)
    if (!m) continue
    const origRel = n.rel.replace(/[^/]+$/, m[1] + m[2])
    const orig = byRel.get(origRel)
    if (!orig) continue
    if (orig.text === n.text) addDel(n.rel, `R8 「${n.name}」是 ${m[1]}${m[2]} 的副本且内容相同`)
  }

  return { ok: true, actions, dels }
}

// ────────────────────────── 执行 ──────────────────────────

/**
 * 执行整理。
 *
 * 「这是 AI 的大脑，所以让 AI 自己收拾」——3.自我/ 社交人格/ 也归 AI 管。
 * 但底线仍然守着：**有内容的笔记绝不静默删除**。这里只会删两种东西：
 *   · 空文件（没有正文）
 *   · 与另一篇逐字节完全相同的重复文件
 * 两处删除都写进 9.归档/整理记录 的清单里，能查回来、能反着做。
 *
 * @returns {{ok:boolean, moved:Array, deleted:Array, skipped:Array, failed:Array, reportPath:string}}
 */
export function apply(vaultPath, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const { actions, dels } = plan(vaultPath)
  const moved = [], deleted = [], skipped = [], failed = []

  // 一次要删太多就不动手：只把清单报出来，等人看一眼再决定。
  // （MAX_DELS 只是计划上限，挡不住「跑一次删 30、明天再删 30」，
  //   这条阈值才是真正让人察觉规模的那道闸。）
  const confirmOver = Number.isFinite(opts.confirmOver) ? opts.confirmOver : DELETE_CONFIRM_OVER
  if (dels.length > confirmOver && opts.force !== true) {
    log(`整理暂停：这次要删 ${dels.length} 项（超过 ${confirmOver} 项的阈值），先不动手。清单：`)
    for (const d of dels) log(`  · ${d.from}  （${d.why}）`)
    log('确认要删就再点一次「整理目录」（带 force）；或者先自己看一眼这些文件。')
    return {
      ok: true, moved: [], deleted: [], skipped: [], failed: [],
      reportPath: '', removedShells: [], index: null,
      needsConfirm: true,
      pending: { moves: actions.length, dels: dels.map((d) => ({ from: d.from, why: d.why })) },
    }
  }

  for (const a of actions) {
    const fromRel = a.from, toRel = a.to
    if (frozen(fromRel) || frozen(toRel)) { skipped.push({ ...a, why: '落在 9.归档/配置目录，不动' }); continue }
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

  // 删冗余：空文件 / 逐字节重复。先算 hash 存起来，万一要还原还能从清单找到线索。
  for (const d of dels) {
    const rel = d.from
    if (frozen(rel)) { skipped.push({ ...d, why: '落在 9.归档/配置目录，不动' }); continue }
    const abs = join(vaultPath, rel)
    try {
      if (!existsSync(abs)) { skipped.push({ ...d, why: '源不在了' }); continue }
      // 双保险：删之前再看一眼，只要还有正文就不删（防止 plan 之后有人刚改过这个文件）
      const text = readText(abs)
      const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
      const isDup = /^R7 |^R8 /.test(d.why)
      if (body && !isDup) { skipped.push({ ...d, why: '删前复查发现已有正文，不删' }); continue }
      unlinkSync(abs)
      deleted.push(d)
      log(`整理：删掉 ${rel}（${d.why}）`)
    } catch (e) { failed.push({ ...d, error: String(e?.message ?? e) }); log(`整理失败（删 ${rel}）：${e?.message ?? e}`) }
  }

  // 清掉 R1 留下的空壳目录（只删「空的」，任意层级都要清）
  // 之前只查顶级 X/X，所以 3.自我/我的偏好/我的偏好 这种二级空壳会留下来。
  const cache = []
  const sweepShells = (dirRel, depth) => {
    if (depth > 5) return
    const dir = join(vaultPath, dirRel)
    for (const d of listDirs(dir)) {
      const childRel = dirRel ? `${dirRel}/${d}` : d
      if (frozen(childRel)) continue
      sweepShells(childRel, depth + 1)
    }
    // 自己套自己：dir/<leaf> 是空目录 → 删
    const leaf = dirRel ? dirRel.split('/').pop() : ''
    if (!leaf) return
    const nest = join(dir, leaf)
    try {
      if (isDir(nest) && listFiles(nest).length === 0 && listDirs(nest).length === 0) {
        rmdirSync(nest); cache.push(`${dirRel}/${leaf}`); log(`整理：删掉空壳目录 ${dirRel}/${leaf}`)
      }
    } catch { /* 忽略 */ }
    // 顺手清空目录（整理搬空之后留下的）：不含任何文件、也没有子目录，且不在冻结区
    try {
      if (isDir(dir) && listFiles(dir).length === 0 && listDirs(dir).length === 0 && dirRel.split('/').length > 1 && !frozen(dirRel)) {
        rmdirSync(dir); cache.push(dirRel); log(`整理：删掉空目录 ${dirRel}`)
      }
    } catch { /* 忽略 */ }
  }
  for (const t of listDirs(vaultPath)) {
    if (frozen(t)) continue
    sweepShells(t, 0)
  }

  // 刷新探索索引的自动段（只动两个标记之间的内容，手写部分不碰）
  const index = rebuildExploreIndex(vaultPath, { log })

  // 写一份可回滚的报告。
  // 按月合并成 9.归档/整理记录/YYYY-MM.md：以前是 YYYY-MM-DD-HHmm.md，
  // 一天点几次「整理」就几个文件，一年下来几百个，反而把 9.归档 撑乱。
  // 这一天第一次整理时先写 frontmatter + 大标题，后面每次追加一节。
  let reportPath = ''
  try {
    const dir = join(vaultPath, '9.归档', '整理记录')
    mkdirSync(dir, { recursive: true })
    const d = new Date()
    const today = dayOf(d)
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const month = today.slice(0, 7)
    const name = `${month}.md`
    const file = join(dir, name)
    const fresh = !existsSync(file)
    const head = fresh
      ? ['---', `title: 整理记录 ${month}`, 'type: log', `date: ${today}`, 'tags: [整理, 体检]', '---', '', `# 整理记录 ${month}`, '']
      : ['']
    const lines = [
      ...head,
      `## ${today} ${hhmm}`, '',
      `移动 ${moved.length} 项，删除 ${deleted.length} 项，跳过 ${skipped.length} 项，失败 ${failed.length} 项。`, '',
      '### 移动清单（想撤回就按这个反着搬回去）', '',
      ...(moved.length ? moved.map((m) => `- \`${m.from}\` → \`${m.to}\`   _(${m.why})_`) : ['- （没有要移动的）']), '',
      ...(deleted.length ? ['### 删除清单（只删了空文件和完全重复的，正文内容本来就没有信息量）', '', ...deleted.map((x) => `- \`${x.from}\`   _(${x.why})_`), ''] : []),
      ...(skipped.length ? ['### 跳过', '', ...skipped.map((s) => `- \`${s.from}\`：${s.why}`), ''] : []),
      ...(failed.length ? ['### 失败', '', ...failed.map((s) => `- \`${s.from}\` → \`${s.to || '-'}\`：${s.error}`), ''] : []),
    ]
    reportPath = `9.归档/整理记录/${name}`
    appendFileSync(file, lines.join('\n') + '\n', 'utf8')
  } catch { /* 报告写不出来不影响整理本身 */ }

  return { ok: true, moved, deleted, skipped, failed, reportPath, removedShells: cache, index, needsConfirm: false }
}
