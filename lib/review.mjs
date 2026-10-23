/**
 * lib/review.mjs —— 每日复盘（功能 C 的核心）：读收件箱 → 调模型提炼 → 写库 → 归档
 * ============================================================================
 * 像人睡前总结：把当天「随手记的草稿」消化成正式笔记，归类到正确目录。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey, readNote, notePath } from './vault.mjs'
import { chat } from './llm.mjs'

const DEFAULT_PROMPT = `你是「AI 大脑」的复盘助手。下面是我今天随手记的草稿（Markdown，可能来自日常对话的随手记，也可能来自逛互联网的收获）。请把它们消化成正式笔记。

要求：
1. 逐条判断草稿属于哪一类：踩坑/报错、环境事实、决策+理由、可复用做法、探索发现。没价值、临时、情绪化的，直接丢弃（不输出）。
2. 每条产出：目标目录、文件名（像"以后会怎么搜它"）、标题、正文（写结论、带报错原文、不啰嗦）。正文用 Markdown。
3. 目标目录只能在这些里选（按语义）：
   - 1.项目/           —— 属于某个具体项目的事
   - 2.领域/           —— 通用领域知识
   - 2.领域/踩坑/      —— 报错与踩坑
   - 3.探索/           —— 逛互联网学到的：新工具、有趣事实、值得跟进的主题
   - 6.资料/参考/      —— 事实、清单、参考
4. 输出**严格的 JSON 数组**，每项形如：
   {"dir":"2.领域/踩坑/","file":"PowerShell-UTF8乱码","title":"...","body":"...（Markdown 正文）"}
   不要输出 JSON 以外的任何文字。

草稿如下：
`;

/**
 * 复盘一次。返回 { ok, notes: [{dir,file,title}], archived } 或 { ok:false, error }。
 * 成功的话把收件箱改名为 0.收件箱/归档/YYYY-MM-DD.md。
 */
export async function runReview({ vaultPath, apiBaseUrl, apiKey, model, reviewPrompt, log = () => {} }) {
  if (!vaultPath || !existsSync(vaultPath)) return { ok: false, error: 'vaultPath 为空或不存在' }

  const inboxRel = `0.收件箱/${dayKey()}.md`
  const inbox = notePath(vaultPath, inboxRel)
  const draft = inbox && existsSync(inbox) ? readFileSync(inbox, 'utf8') : ''
  if (!draft.trim()) return { ok: false, error: '今天收件箱是空的，没有可复盘的', empty: true }

  const prompt = (String(reviewPrompt || '').trim() || DEFAULT_PROMPT) + '\n\n' + draft

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
    const dir = String(it.dir || '2.领域/').replace(/[\\/]+$/, '')
    const file = String(it.file || it.title).replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)
    const rel = `${dir}/${file}.md`
    const frontmatter = [
      '---',
      'title: ' + JSON.stringify(String(it.title)),
      'created: ' + new Date().toISOString().slice(0, 10),
      '---',
      '',
    ].join('\n')
    const p = notePath(vaultPath, rel)
    if (!p) { log(`跳过（路径非法）：${rel}`); continue }
    try {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, frontmatter + '\n' + String(it.body).trim() + '\n', 'utf8')
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

  return { ok: true, notes: written, archived }
}
