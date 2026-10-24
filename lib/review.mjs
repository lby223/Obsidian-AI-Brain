/**
 * lib/review.mjs —— 每日复盘（功能 C 的核心）：读收件箱 → 调模型提炼 → 写库 → 归档
 * ============================================================================
 * 像人睡前总结：把当天「随手记的草稿」消化成正式笔记，归类到正确目录。
 * ============================================================================
 */
import { existsSync, readFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey, readNote, notePath, atomicWrite } from './vault.mjs'
import { chat } from './llm.mjs'
import * as recycle from './recycle.mjs'

/**
 * 允许模型写入的目录白名单（代码层强制，不只写在 prompt 里）。
 *
 * 为什么要代码层也校验：prompt 只是「请求」，模型可能输出
 * `2.領域/踩坑`（异体字）、`2.领域\踩坑`（反斜杠）、`./2.领域/踩坑/`
 * 这类变体；safeJoin 只挡越界，挡不住「造出平行目录」。
 * 模型写一次错字，库里就多一个 `2.領域/`，之后越积越多。
 */
const ALLOWED_DIRS = [
  '1.项目',
  '2.领域',
  '2.领域/踩坑',
  '3.自我',
  '4.AI手册',
  '6.资料',
  '6.资料/参考',
  '7.探索',
  '7.探索/综合',
]
const FALLBACK_DIR = '2.领域'

/** 把模型给的目录规整到白名单里的一个；不在白名单就落到 FALLBACK_DIR */
export function normalizeDir(raw) {
  let d = String(raw == null ? '' : raw).trim()
  d = d.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  d = d.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!d) return { dir: FALLBACK_DIR, fell: true, raw: String(raw ?? '') }
  if (ALLOWED_DIRS.includes(d)) return { dir: d, fell: false }
  // 允许写子目录：限定在已授权目录之下的也放行（如 2.领域/踩坑/某子类）
  const parent = ALLOWED_DIRS.filter((a) => d.startsWith(a + '/')).sort((x, y) => y.length - x.length)[0]
  if (parent && /^[\w\u4e00-\u9fa5.\-/ ]+$/.test(d)) return { dir: d, fell: false }
  return { dir: FALLBACK_DIR, fell: true, raw: String(raw ?? '') }
}

const DEFAULT_PROMPT = `你是「AI 大脑」的复盘助手。下面是我今天随手记的草稿（Markdown，可能来自日常对话的随手记，也可能来自逛互联网的收获）。请把它们消化成正式笔记。

要求：
1. 逐条判断草稿属于哪一类：踩坑/报错、环境事实、决策+理由、可复用做法、探索发现。没价值、临时、情绪化的，直接丢弃（不输出）。
2. 每条产出：目标目录、文件名（像"以后会怎么搜它"）、标题、正文（写结论、带报错原文、不啰嗦）。正文用 Markdown。
3. 目标目录只能在这些里选（按语义）：
   - 1.项目/           —— 属于某个具体项目的事
   - 2.领域/           —— 通用领域知识
   - 2.领域/踩坑/      —— 报错与踩坑
   - 7.探索/           —— 逛互联网学到的：新工具、有趣事实、值得跟进的主题
   - 6.资料/参考/      —— 事实、清单、参考
4. 输出**严格的 JSON 数组**，每项形如：
   {"dir":"2.领域/踩坑/","file":"PowerShell-UTF8乱码","title":"...","body":"...（Markdown 正文）"}
   不要输出 JSON 以外的任何文字。

草稿如下：
`;

/**
 * 复盘时「判断哪篇该删」的第二轮提示词。
 *
 * 为什么单开一轮：复盘主体只看得见「今天的草稿」，它看不到库里已有的东西；
 * 判断「冗余/被取代/过时」必须看**现有笔记清单**，所以在写完新笔记之后再问一轮。
 *
 * 关键约束（用户 2026-10-24 定的）：
 *   · 「不是一定要删」—— 没得删就返回空数组，这很正常。
 *   · 判断权在模型，但必须写理由；搬进回收站保留 90 天，所以宁可少删。
 */
export const PURGE_PROMPT = `你是一个知识库的管家。下面是这个知识库现在的笔记清单（路径 + 标题 + 摘要），以及今天刚刚新写进去的笔记。

请判断：**哪些笔记已经足够没有价值，可以从库里移除？**

判断标准（只按这几条，别扩大）：
1. **被取代** —— 后来有了更完整/更准确的一篇，讲同一件事，这篇被覆盖了。
2. **过时** —— 记录的是已经过去、不会再用到的临时状态（比如「明天要装的软件」已经装完、「临时绕过办法」后来修好了）。
3. **没有结论** —— 只有标题和几句没头没尾的草稿，既没有结论也没有可复用的信息。
4. **重复** —— 同一件事说了两三遍，只留最好的那篇。

**不要**因为以下理由删：
- 太长、太旧但内容仍然正确、写得不漂亮、暂时想不起来有什么用。
- 是某个项目/某个领域的唯一记录，即使现在看着没用。
- 你不确定 —— **不确定就不删**。

输出**严格的 JSON 数组**，每项：
{"file":"<原样照抄上面清单里的路径>","why":"<一句话说清为什么它没价值了>"}

没有该删的就输出空数组 []。不要输出 JSON 以外的任何文字。`;

/**
 * 复盘一次。返回 { ok, notes: [{dir,file,title}], archived, trashed } 或 { ok:false, error }。
 * 成功的话把收件箱改名为 0.收件箱/归档/YYYY-MM-DD.md。
 *
 * opts.judge 为真时，写完新笔记后追一轮「哪些该删」的判断，
 * 命中的搬进 9.归档/回收站/（保留 90 天），不直接删。
 */
export async function runReview({ vaultPath, apiBaseUrl, apiKey, model, reviewPrompt, log = () => {}, judge = false }) {
  if (!vaultPath || !existsSync(vaultPath)) return { ok: false, error: 'vaultPath 为空或不存在' }

  const inboxRel = `0.收件箱/${dayKey()}.md`
  const inbox = notePath(vaultPath, inboxRel)
  const draft = inbox && existsSync(inbox) ? readFileSync(inbox, 'utf8') : ''
  if (!draft.trim()) return { ok: false, error: '今天收件箱是空的，没有可复盘的', empty: true }

  const prompt = (String(reviewPrompt || '').trim() || DEFAULT_PROMPT)
    + `\n\n今天是 ${dayKey()}（本地日期）。文件名/正文里要写日期就用这一天，别自己猜。\n\n`
    + draft

  const r = await chat(apiBaseUrl, apiKey, model, [
    { role: 'system', content: '你是负责把草稿提炼成结构化知识库笔记的助手。' },
    { role: 'user', content: prompt },
  ])
  if (!r.ok) return { ok: false, error: `调模型失败：${r.error}` }

  // 解析 JSON 数组（可能被模型包在 ```json ``` 里）
  let items = []
  try { items = JSON.parse(r.text) } catch {
    const m = r.text.match(/```(?:json)?\s*([\s\S]*?)```/)
    try { items = JSON.parse(m ? m[1] : r.text) } catch {
      return { ok: false, error: '模型输出不是合法 JSON，无法解析', raw: r.text.slice(0, 500) }
    }
  }
  if (!Array.isArray(items)) return { ok: false, error: '模型输出不是数组', raw: r.text.slice(0, 500) }

  const written = []
  for (const it of items) {
    if (!it || typeof it !== 'object' || !it.title || !it.body) continue
    const nd = normalizeDir(it.dir)
    const dir = nd.dir
    const file = String(it.file || it.title).replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)
    const rel = `${dir}/${file}.md`
    if (nd.fell) log(`复盘：模型给的目录「${nd.raw}」不在白名单，改放 ${FALLBACK_DIR}/（${rel}）`)
    const frontmatter = [
      '---',
      'title: ' + JSON.stringify(String(it.title)),
      'type: note',
      // 本地日期。曾经写成 new Date().toISOString().slice(0,10)（UTC），
      // 凌晨 03:00 复盘会把日期写成前一天。
      'date: ' + dayKey(),
      '---',
      '',
    ].join('\n')
    const p = notePath(vaultPath, rel)
    if (!p) { log(`跳过（路径非法）：${rel}`); continue }
    try {
      mkdirSync(join(p, '..'), { recursive: true })
      // 原子写：直接 writeFileSync 被打断会留半个文件，那半截「有正文」，
      // 以后体检永远不会把它当空文件修掉，就变成永久残篇。
      const w = atomicWrite(p, frontmatter + '\n' + String(it.body).trim() + '\n')
      if (!w.ok) { log(`复盘写 ${rel} 失败：${w.error}`); continue }
      written.push({ dir, file: rel, title: String(it.title) })
      log(`复盘写入：${rel}`)
    } catch (e) { log(`复盘写 ${rel} 失败：${e?.message ?? e}`) }
  }

  // 归档收件箱
  let archived = ''
  try {
    const archDir = notePath(vaultPath, '0.收件箱/归档')
    const archFile = join(String(archDir).replace(/\.md$/i, ''), `${dayKey()}.md`)
    mkdirSync(join(archFile, '..'), { recursive: true })
    renameSync(inbox, archFile)
    archived = archFile
  } catch (e) { log(`归档收件箱失败：${e?.message ?? e}`) }

  // ── 第二轮：让模型判断「库里哪篇已经没价值了」，命中的搬进回收站 ──
  const trashed = []
  if (judge) {
    try {
      const t = await judgeAndTrash({ vaultPath, apiBaseUrl, apiKey, model, log, justWritten: written })
      trashed.push(...t.trashed)
      if (t.error) log(`复盘：清理判断没成（${t.error}）—— 库里一个字没动`)
    } catch (e) { log(`复盘：清理判断出错（已兜住）：${e?.stack ?? e}`) }
  }

  return { ok: true, notes: written, archived, trashed }
}

/** 摘要：取 frontmatter title + 第一段有内容的正文，压到一行 */
function digest(text) {
  const t = String(text || '')
  const tm = /^---\r?\n[\s\S]*?\r?\ntitle:\s*(.+)$/m.exec(t)
  const title = tm ? tm[1].trim().replace(/^["']|["']$/g, '') : ''
  const body = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('>') || line.startsWith('|') || line.startsWith('```')) continue
    return { title, one: line.length > 100 ? line.slice(0, 99) + '…' : line }
  }
  return { title, one: '' }
}

/** 递归列出库里所有笔记（跳过归档区/回收站/配置目录） */
function collectNotes(vaultPath, rel = '', out = [], depth = 0) {
  if (depth > 6) return out
  let ents = []
  try { ents = readdirSync(join(vaultPath, rel), { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (r === '9.归档' || r === '.obsidian' || r === '.trash' || r === '0.收件箱') continue
      collectNotes(vaultPath, r, out, depth + 1)
      continue
    }
    if (!/\.md$/i.test(e.name)) continue
    if (/索引\.md$/i.test(e.name) || e.name === '0.导读.md') continue
    out.push(r)
  }
  return out
}

/**
 * 判断并搬进回收站。限额 MAX_TRASH_PER_RUN 篇。
 * 只接受「清单里真实存在的路径」，模型编出来的路径会被丢掉。
 */
async function judgeAndTrash({ vaultPath, apiBaseUrl, apiKey, model, log, justWritten }) {
  const all = collectNotes(vaultPath)
  const justSet = new Set((justWritten || []).map((n) => String(n.file).replace(/\\/g, '/')))
  if (!all.length) return { trashed: [] }

  // 清单：路径 + 标题 + 一句话。刚写进去的标出来，免得模型把自己刚写的删了
  const lines = all.map((rel) => {
    let text = ''
    try { text = readFileSync(join(vaultPath, rel), 'utf8') } catch { /* 读不到就只给路径 */ }
    const d = digest(text)
    const mark = justSet.has(rel) ? ' [今天新写的]' : ''
    return `- ${rel}${mark}${d.title ? ` | ${d.title}` : ''}${d.one ? ` | ${d.one}` : ''}`
  })

  const r = await chat(apiBaseUrl, apiKey, model, [
    { role: 'system', content: '你是负责清理知识库冗余的管家。只输出 JSON。' },
    { role: 'user', content: `${PURGE_PROMPT}\n\n今天是 ${dayKey()}。\n\n笔记清单（共 ${all.length} 篇）：\n${lines.join('\n')}` },
  ])
  if (!r.ok) return { trashed: [], error: `调模型失败：${r.error}` }

  let items = []
  const raw = String(r.text || '').trim()
  try { items = JSON.parse(raw) } catch {
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    try { items = JSON.parse(m ? m[1] : raw) } catch { return { trashed: [], error: '模型输出不是合法 JSON' } }
  }
  if (!Array.isArray(items)) return { trashed: [], error: '模型输出不是数组' }
  if (!items.length) { log('复盘：清理判断完成 —— 没有需要清掉的笔记'); return { trashed: [] } }

  const trashed = []
  for (const it of items) {
    if (trashed.length >= MAX_TRASH_PER_RUN) { log(`复盘：清理到上限 ${MAX_TRASH_PER_RUN} 篇，剩下的下次再说`); break }
    const f = String(it?.file || '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!f || !all.includes(f)) { log(`复盘：清理清单里的「${f}」在库里不存在，忽略`); continue }
    if (justSet.has(f)) { log(`复盘：不清今天刚写的 ${f}`); continue }
    const t = recycle.trash(vaultPath, f, it?.why)
    if (t.ok) { trashed.push({ file: f, why: String(it?.why || ''), to: t.to }); log(`复盘：搬进回收站 ${f}（${String(it?.why || '').slice(0, 80)}）`) }
    else log(`复盘：搬 ${f} 进回收站失败：${t.error}`)
  }
  if (!trashed.length) log('复盘：清理判断给出了清单，但没有一篇搬成功')
  return { trashed }
}
