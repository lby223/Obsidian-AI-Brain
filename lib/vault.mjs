/**
 * lib/vault.mjs —— 库读写（功能 B 的后端）：直接操作文件系统
 * ============================================================================
 * 库就是 Markdown 文件夹，直接 fs 读写，快、稳、不依赖 Obsidian 进程 / MCP 服务。
 * 所有路径都解析到 vaultPath 之下，防越界。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { dayKey, stamp } from './schedule.mjs'

// 本地日期 YYYY-MM-DD —— 定义在 schedule.mjs（时间只用一处口径），这里转出去给老调用方用。
export { dayKey }

/**
 * 原子写：先写同目录的 .tmp，fsync 后 rename 覆盖。
 * 为什么要：直接 writeFileSync 到目标文件，写到一半断电/被杀会留下半个文件，
 * 而那个半截文件「有正文」，以后体检永远不会把它当空文件修掉——变成永久残篇。
 * rename 在同一分区上是原子操作，要么旧内容、要么新内容，不会有中间态。
 */
export function atomicWrite(file, content) {
  const tmp = join(String(file).replace(/[^\\/]+$/, '') + `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  try {
    writeFileSync(tmp, String(content), 'utf8')
    renameSync(tmp, file)
    return { ok: true }
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 清理失败无所谓 */ }
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 把用户给的相对路径钉在 vaultPath 下，防越界（../ 之类） */
export function safeJoin(vaultPath, rel) {
  const base = resolve(vaultPath)
  const target = resolve(base, rel || '.')
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

export function notePath(vaultPath, rel) {
  let r = String(rel || '').trim()
  if (!r) return null
  if (!/\.md$/i.test(r)) r += '.md'
  const p = safeJoin(vaultPath, r)
  return p && !p.toLowerCase().endsWith('.md') ? null : p
}

/** 列目录（一层），返回 { name, dir }[] */
export function listDir(vaultPath, rel = '') {
  const dir = safeJoin(vaultPath, rel)
  if (!dir || !existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)))
  } catch { return [] }
}

/** 递归列出所有 .md 笔记（限深度，防库太大） */
export function listNotes(vaultPath, rel = '', depth = 0) {
  if (depth > 5) return []
  const out = []
  const dir = safeJoin(vaultPath, rel)
  if (!dir || !existsSync(dir)) return out
  try {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue
      const full = join(dir, d.name)
      const relp = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) out.push(...listNotes(vaultPath, relp, depth + 1))
      else if (/\.md$/i.test(d.name)) {
        try { out.push({ path: relp, size: statSync(full).size, mtime: statSync(full).mtimeMs }) } catch { /* 读不到就跳过 */ }
      }
    }
  } catch { /* 读不到就返回空 */ }
  return out
}

/** 简单关键词搜索：返回 { path, line, text }[] */
export function searchNotes(vaultPath, query) {
  const q = String(query || '').toLowerCase()
  if (!q) return []
  const results = []
  const walk = (rel = '', depth = 0) => {
    if (depth > 5 || results.length > 200) return
    const dir = safeJoin(vaultPath, rel)
    if (!dir || !existsSync(dir)) return
    try {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.name.startsWith('.')) continue
        const relp = rel ? `${rel}/${d.name}` : d.name
        const full = join(dir, d.name)
        if (d.isDirectory()) { walk(relp, depth + 1); continue }
        if (!/\.md$/i.test(d.name)) continue
        try {
          const text = readFileSync(full, 'utf8')
          const lines = text.split('\n')
          for (let i = 0; i < lines.length && results.length <= 200; i++) {
            if (lines[i].toLowerCase().includes(q)) {
              results.push({ path: relp, line: i + 1, text: lines[i].slice(0, 200) })
            }
          }
        } catch { /* 单篇读失败跳过 */ }
      }
    } catch { /* 忽略 */ }
  }
  walk('')
  return results.slice(0, 200)
}

export function readNote(vaultPath, rel) {
  const p = notePath(vaultPath, rel)
  if (!p || !existsSync(p)) return null
  return readFileSync(p, 'utf8')
}

export function writeNote(vaultPath, rel, content) {
  const p = notePath(vaultPath, rel)
  if (!p) return { ok: false, error: '路径非法' }
  try {
    mkdirSync(join(p, '..'), { recursive: true })
    const w = atomicWrite(p, String(content))
    if (!w.ok) return { ok: false, error: w.error }
    return { ok: true, path: p }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}

/** 追加到一篇笔记末尾（用于收件箱） */
export function appendNote(vaultPath, rel, content) {
  const p = notePath(vaultPath, rel)
  if (!p) return { ok: false, error: '路径非法' }
  try {
    mkdirSync(join(p, '..'), { recursive: true })
    const sep2 = existsSync(p) ? '\n\n' : ''
    appendFileSync(p, sep2 + String(content), 'utf8')
    return { ok: true, path: p }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}

/** 写一条 capture 到当日收件箱 0.收件箱/YYYY-MM-DD.md */
export function capture(vaultPath, note) {
  const inbox = `0.收件箱/${dayKey()}.md`
  const at = stamp()   // 本地时间；原来是 toISOString()（UTC，比本地少 8 小时）
  const block = [
    '',
    `## ${String(note?.title || '未命名').slice(0, 80)}`,
    `> 记于 ${at}${note?.source ? ' · 来源：' + note.source : ''}`,
    '',
    String(note?.body || '').trim(),
  ].join('\n')
  return appendNote(vaultPath, inbox, block)
}
