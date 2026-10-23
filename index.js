/**
 * dsh-ai-brain —— 给 AI 一个跨会话的持久记忆（host 半端）
 * ============================================================================
 * 功能：
 *   A. 注入「记忆规则」到每次会话（ctx.systemPrompt.section）
 *   B. 知识库读写工具（brain_search / brain_read / brain_list / brain_capture / brain_note）
 *   C. 每日定时复盘（到点读收件箱 → 插件自己调 OpenAI 兼容模型 → 写库 → 归档）
 *   D. 设置页（DSH 自带，靠 Config schema）+ 可选 AI 逛互联网（到点 spawn headless 会话）
 *
 * 家目录（$DSH_HOME/ai-brain/）：config.json / state.json / brain.log
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { RULES, buildRules } from './lib/rules.mjs'
import * as vault from './lib/vault.mjs'
import { runReview } from './lib/review.mjs'

export const name = 'ai-brain'
export const inject = ['tools', 'settings', 'webServer']

// ── Config：每个字段都 .extra('volatile', true)；不加校验（校验失败会整条不激活） ──
export const Config = !z ? undefined : z.object({
  vaultPath: z.string().default('').extra('volatile', true),
  rulesExtra: z.string().default('').extra('volatile', true),
  reviewEnabled: z.boolean().default(true).extra('volatile', true),
  reviewTime: z.string().default('23:00').extra('volatile', true),
  apiBaseUrl: z.string().default('').extra('volatile', true),
  apiKey: z.string().default('').extra('volatile', true),
  model: z.string().default('').extra('volatile', true),
  reviewPrompt: z.string().default('').extra('volatile', true),
  browseEnabled: z.boolean().default(false).extra('volatile', true),
  browseTime: z.string().default('').extra('volatile', true),
  browseMode: z.string().default('off').extra('volatile', true),
})

const DEFAULTS = {
  vaultPath: '', rulesExtra: '',
  reviewEnabled: true, reviewTime: '23:00',
  apiBaseUrl: '', apiKey: '', model: '', reviewPrompt: '',
  browseEnabled: false, browseTime: '', browseMode: 'off',
}

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  let myVer = ''
  const myVersion = () => {
    if (myVer) return myVer
    try { myVer = String(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '') } catch { myVer = '' }
    return myVer
  }

  // ── 家目录 ──
  const stateDir = (() => {
    try {
      const p = ctx?.get?.('dshHomePath')
      if (typeof p === 'function') { const v = p('ai-brain'); if (v) return String(v) }
      else if (typeof p === 'string' && p) return join(p, 'ai-brain')
    } catch { /* 兜底 */ }
    return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ai-brain')
  })()
  try { mkdirSync(stateDir, { recursive: true }) } catch { /* 建不了就用内存里那串 */ }

  const logFile = join(stateDir, 'brain.log')
  const log = (msg) => {
    const line = `${new Date().toISOString()}  ${msg}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 写不进不致命 */ }
    try { ctx.logger?.info?.(`[ai-brain] ${msg}`) } catch { /* 没有就算了 */ }
  }
  for (const n of hostDeps.notes) log(n)

  // ── 配置读取（跟 bili-scroll 同一套：类型钳制 + config.json + 宿主 describe） ──
  const cfgFile = join(stateDir, 'config.json')
  const readJson = (file, fb) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fb } }
  const writeJson = (file, v) => { try { writeFileSync(file, JSON.stringify(v, null, 2), 'utf8') } catch { /* 忽略 */ } }

  const normalize = (src, base) => {
    const out = { ...base }
    for (const k of Object.keys(base)) {
      const v = src?.[k]
      if (v === undefined || v === null) continue
      if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
      else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
      else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
    }
    return out
  }
  const clampPatch = (p) => {
    const o = { ...p }
    if ('vaultPath' in o) o.vaultPath = String(o.vaultPath || '').trim()
    if ('rulesExtra' in o) o.rulesExtra = String(o.rulesExtra || '').slice(0, 8000)
    if ('reviewEnabled' in o) o.reviewEnabled = Boolean(o.reviewEnabled)
    if ('reviewTime' in o) o.reviewTime = /^\d{1,2}:\d{2}$/.test(String(o.reviewTime || '')) ? String(o.reviewTime) : '23:00'
    if ('apiBaseUrl' in o) o.apiBaseUrl = String(o.apiBaseUrl || '').trim()
    if ('apiKey' in o) o.apiKey = String(o.apiKey || '').trim()
    if ('model' in o) o.model = String(o.model || '').trim()
    if ('reviewPrompt' in o) o.reviewPrompt = String(o.reviewPrompt || '').slice(0, 20000)
    if ('browseEnabled' in o) o.browseEnabled = Boolean(o.browseEnabled)
    if ('browseTime' in o) o.browseTime = /^\d{1,2}:\d{2}$/.test(String(o.browseTime || '')) ? String(o.browseTime) : ''
    if ('browseMode' in o) o.browseMode = ['off', 'kb'].includes(String(o.browseMode)) ? String(o.browseMode) : 'off'
    return o
  }

  // ⭐ 面板里保存过的键 = 以插件自己那份 config.json 为准（不会被 DSH 原生设置页的旧值压回）。
  //    桌面版里 `ctx` 收到的 config 是挂载时快照、写进 cordis.patch.yml 的值不热刷新 ⇒
  //    干脆「凡是从插件面板保存过的键，一律以 config.json 为准」，简单可靠。
  let touchedKeys = (() => {
    const raw = readJson(cfgFile, {})
    if (Array.isArray(raw._set)) return new Set(raw._set)
    return new Set(Object.keys(DEFAULTS).filter((k) => k in raw && JSON.stringify(raw[k]) !== JSON.stringify(DEFAULTS[k])))
  })()

  const savedCfg = () => clampPatch(normalize(readJson(cfgFile, {}), { ...DEFAULTS }))
  const loadCfg = () => {
    const saved = savedCfg()
    let out = { ...DEFAULTS }
    // 宿主那份（schema 校验过、默认已填）当基线，再叠 config.json
    try { out = normalize(config, out) } catch { /* 拿不到就默认 */ }
    for (const k of Object.keys(DEFAULTS)) {
      if (touchedKeys.has(k)) out[k] = saved[k]            // 面板存过 ⇒ 本地说了算
      else if (saved[k] !== DEFAULTS[k]) out[k] = saved[k] // 本地显式设过（老数据）⇒ 也听本地
    }
    return clampPatch(out)
  }
  let cfg = loadCfg()
  const refreshCfg = () => { cfg = loadCfg(); return cfg }

  // ⭐ 落配置的唯一入口：写 config.json 并记下「这些键以面板为准」
  const persistCfg = (patch) => {
    const clean = clampPatch(patch)
    for (const k of Object.keys(clean)) if (k in DEFAULTS) touchedKeys.add(k)
    writeJson(cfgFile, { ...cfg, ...clean, _set: [...touchedKeys] })
    Object.assign(cfg, normalize(clean, cfg))
    return clean
  }

  // ── 功能 A：注入规则 ──
  try {
    ctx.inject(['systemPrompt'], (c) => {
      c.effect(() => {
        let dispose = null
        try {
          dispose = c.systemPrompt.section({
            name: 'ai-brain',
            order: 70,
            interpolate: false,
            text: buildRules(cfg.rulesExtra),
          })
        } catch (e) { log(`注入规则失败：${e?.message ?? e}`) }
        return () => { if (typeof dispose === 'function') dispose() }
      })
    })
  } catch (e) { log(`systemPrompt 注入没挂上：${e?.message ?? e}`) }

  // ── 功能 B：工具 ──
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
  }
  const tool = (spec) => {
    try {
      return ctx.tools.register(defineTool({
        ...spec,
        output: textOutput,
        async execute(args, exec) { return safe(await spec.execute(args, exec)) },
      }))
    } catch (e) { log(`工具 ${spec.name} 注册失败：${e?.message ?? e}`); return null }
  }
  const vp = () => refreshCfg().vaultPath

  tool({
    name: 'brain_search',
    description: '在知识库里搜索笔记内容（关键词，大小写不敏感）。返回匹配的路径、行号、摘要。写新笔记前先搜一下，别重复。',
    parameters: { query: { type: 'string', description: '要搜的关键词' } },
    async execute(args) {
      const q = String(args?.query || '').trim()
      if (!q) return { ok: false, error: 'query 不能为空' }
      const v = vp(); if (!v) return { ok: false, error: '还没配置 vaultPath（去插件设置页填）' }
      return { ok: true, query: q, results: vault.searchNotes(v, q) }
    },
  })

  tool({
    name: 'brain_read',
    description: '读一篇知识库笔记的全文。',
    parameters: { path: { type: 'string', description: '笔记相对路径（如 2.领域/踩坑/PowerShell-UTF8乱码.md，可省略 .md）' } },
    async execute(args) {
      const v = vp(); if (!v) return { ok: false, error: '还没配置 vaultPath' }
      const text = vault.readNote(v, String(args?.path || ''))
      if (text === null) return { ok: false, error: '没找到这篇笔记：' + String(args?.path || '') }
      return { ok: true, path: String(args?.path || ''), text }
    },
  })

  tool({
    name: 'brain_list',
    description: '列出知识库目录结构或所有笔记（含大小、修改时间）。',
    parameters: { path: { type: 'string', description: '可选，目录相对路径（默认根目录）' } },
    async execute(args) {
      const v = vp(); if (!v) return { ok: false, error: '还没配置 vaultPath' }
      const rel = String(args?.path || '').trim()
      const entries = vault.listDir(v, rel)
      const notes = vault.listNotes(v, rel).sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 200)
      return { ok: true, dir: rel || '/', entries, noteCount: notes.length, notes }
    },
  })

  tool({
    name: 'brain_capture',
    description: '快速记一条草稿到「今日收件箱」，不阻塞、不归类——回头每日复盘时再消化成正式笔记。适合随手记一个结论/踩坑/工具。',
    parameters: {
      title: { type: 'string', description: '一句话标题' },
      body: { type: 'string', description: '正文（Markdown，带结论/报错原文/命令）' },
      source: { type: 'string', description: '可选，来源（如哪个会话/项目）' },
    },
    async execute(args) {
      const v = vp(); if (!v) return { ok: false, error: '还没配置 vaultPath' }
      if (!String(args?.title || '').trim()) return { ok: false, error: 'title 不能为空' }
      const r = vault.capture(v, { title: args?.title, body: args?.body, source: args?.source })
      return r.ok ? { ok: true, inbox: r.path } : r
    },
  })

  tool({
    name: 'brain_note',
    description: '直接写一篇正式笔记到指定目录（带 frontmatter）。适合已经想清楚、要落到固定位置的笔记。',
    parameters: {
      path: { type: 'string', description: '笔记相对路径（如 2.领域/踩坑/某错误.md）' },
      content: { type: 'string', description: '笔记正文（Markdown）' },
    },
    async execute(args) {
      const v = vp(); if (!v) return { ok: false, error: '还没配置 vaultPath' }
      const rel = String(args?.path || '').trim()
      if (!rel) return { ok: false, error: 'path 不能为空' }
      const r = vault.writeNote(v, rel, String(args?.content || ''))
      return r
    },
  })

  // ── 功能 C：每日定时复盘 ──
  const stateFile = join(stateDir, 'state.json')
  const readState = () => readJson(stateFile, {})
  const bumpState = (patch) => writeJson(stateFile, { ...readState(), ...patch })

  const reviewToday = () => {
    const today = vault.dayKey()
    return readState().reviewed?.[today] === true
  }

  const doReview = async (why = 'schedule') => {
    refreshCfg()
    if (!cfg.reviewEnabled) return { ok: false, error: '复盘没开' }
    if (!cfg.vaultPath) return { ok: false, error: '没配 vaultPath' }
    if (!cfg.apiBaseUrl || !cfg.apiKey || !cfg.model) return { ok: false, error: '复盘模型没配全（apiBaseUrl / apiKey / model）' }
    const today = vault.dayKey()
    log(`复盘开始（${why}）`)
    const r = await runReview({
      vaultPath: cfg.vaultPath,
      apiBaseUrl: cfg.apiBaseUrl, apiKey: cfg.apiKey, model: cfg.model, reviewPrompt: cfg.reviewPrompt,
      log,
    })
    if (r.ok) {
      bumpState({ reviewed: { ...(readState().reviewed || {}), [today]: true }, lastReviewAt: new Date().toISOString() })
      log(`复盘完成：写入 ${r.notes.length} 篇${r.archived ? '，收件箱已归档' : ''}`)
    } else {
      log(`复盘没成（${why}）：${r.error}${r.empty ? '（收件箱空，不算错）' : ''}`)
    }
    return r
  }

  const tick = () => {
    try {
      refreshCfg()
      if (!cfg.reviewEnabled) return
      const now = new Date()
      const hm = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`
      if (hm !== cfg.reviewTime) return
      if (reviewToday()) return
      doReview('schedule').catch((e) => log(`复盘异常：${e?.stack ?? e}`))
    } catch (e) {
      log(`定时器这一跳出错（已兜住）：${e?.stack ?? e}`)
    }
  }

  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'ai-brain: 每日复盘定时器')
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  // ── 功能 D：AI 逛互联网（到点 spawn headless 会话） ──
  const require = createRequire(import.meta.url)
  const findDshCli = () => {
    try {
      for (const spec of ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-ai/dsh']) {
        try { const p = require.resolve(spec); if (p && existsSync(p)) return p } catch { /* 下一个 */ }
      }
    } catch { /* 忽略 */ }
    return ''
  }

  const browseToday = () => readState().browsed?.[vault.dayKey()] === true

  const doBrowse = async (why = 'schedule') => {
    refreshCfg()
    if (!cfg.browseEnabled) return { ok: false, error: '逛互联网没开' }
    if (!cfg.vaultPath) return { ok: false, error: '没配 vaultPath' }
    const cli = findDshCli()
    if (!cli) { log('逛互联网没跑：找不到 dsh cli'); return { ok: false, error: '找不到 dsh cli' } }

    const mode = cfg.browseMode === 'kb' ? '贴近知识库内容做扩展学习（先 brain_search / brain_list 看库里有什么，再围绕它去逛）' : '自由逛，不做要求'
    const prompt = [
      '你是「AI 大脑」的逛互联网助手。请出去逛一圈，把对使用者未来有帮助的知识记下来。',
      `浏览偏好：${mode}`,
      '要求：不要复制全文，消化后用自己的话记结论；用 brain_capture 把有用的结论、事实、工具、踩坑记进知识库。',
      '逛 3-5 个相关主题就停，写一篇简短总结（今天逛了什么、记了什么）。',
    ].join('\n')

    log(`逛互联网开跑（${why}，mode=${cfg.browseMode}）`)
    const child = spawn(process.execPath, [cli, '--profile', 'headless', prompt], {
      cwd: stateDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    })
    const pick = (buf) => { try { appendFileSync(logFile, Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)), 'utf8') } catch { /* 忽略 */ } }
    child.stdout?.on('data', pick)
    child.stderr?.on('data', pick)
    child.on('exit', (code) => {
      log(`逛互联网结束（code=${code}）`)
      bumpState({ browsed: { ...(readState().browsed || {}), [vault.dayKey()]: true } })
    })
    return { ok: true, started: true }
  }

  const browseTick = () => {
    try {
      refreshCfg()
      if (!cfg.browseEnabled || !cfg.browseTime) return
      const now = new Date()
      const hm = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`
      if (hm !== cfg.browseTime) return
      if (browseToday()) return
      doBrowse('schedule').catch((e) => log(`逛互联网异常：${e?.stack ?? e}`))
    } catch (e) { log(`逛互联网定时器出错（已兜住）：${e?.stack ?? e}`) }
  }
  try {
    const bt = setInterval(browseTick, 60_000)
    bt.unref?.()
    ctx.effect(() => () => clearInterval(bt), 'ai-brain: 逛互联网定时器')
  } catch (e) { log(`逛互联网定时器没起来：${e?.message ?? e}`) }

  // ── 手动触发 + 状态（走 HTTP，供设置页按钮用） ──
  const sendJson = (res, code, obj) => {
    try {
      const body = JSON.stringify(obj)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(body)
    } catch { try { res.end('{}') } catch { /* 忽略 */ } }
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
  })

  const handle = async (req, res, url) => {
    const path = url.pathname.replace(/\/+$/, '')
    const prefix = '/api/ai-brain'
    if (!path.startsWith(prefix)) return sendJson(res, 404, { ok: false, error: 'not found' })
    const sub = path.slice(prefix.length) || '/'

    if (sub === '/status' && req.method === 'GET') {
      refreshCfg()
      return sendJson(res, 200, {
        ok: true, version: myVersion(), home: stateDir,
        vault: cfg.vaultPath || '',
        reviewEnabled: cfg.reviewEnabled, reviewTime: cfg.reviewTime,
        reviewedToday: reviewToday(), browseEnabled: cfg.browseEnabled, browseTime: cfg.browseTime,
        browseMode: cfg.browseMode, browsedToday: browseToday(),
        modelConfigured: Boolean(cfg.apiBaseUrl && cfg.apiKey && cfg.model),
        config: { ...cfg }, // 完整配置（apiKey 也带，本机同源 fetch，设置页要回显）
      })
    }
    if (sub === '/config' && req.method === 'GET') {
      refreshCfg()
      return sendJson(res, 200, { ok: true, config: { ...cfg }, home: stateDir })
    }
    if (sub === '/config' && req.method === 'POST') {
      const body = await readBody(req)
      const patch = {}
      for (const k of Object.keys(DEFAULTS)) if (k in body) patch[k] = body[k]
      const clean = persistCfg(patch)
      log(`设置已更新：${JSON.stringify(clean)}`)
      return sendJson(res, 200, { ok: true, config: { ...cfg } })
    }
    if (sub === '/log' && req.method === 'GET') {
      let text = ''
      try { text = readFileSync(logFile, 'utf8').split('\n').slice(-200).join('\n') } catch { /* 没日志就给空 */ }
      return sendJson(res, 200, { ok: true, text })
    }
    if (sub === '/review' && req.method === 'POST') return sendJson(res, 200, await doReview('manual'))
    if (sub === '/browse' && req.method === 'POST') return sendJson(res, 200, await doBrowse('manual'))
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${sub}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/ai-brain',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) }
        catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    }), 'ai-brain: HTTP 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  log(`已挂载（版本 ${myVersion()}，库=${cfg.vaultPath || '未配置'}，复盘=${cfg.reviewEnabled ? cfg.reviewTime : '关'}）`)
}
