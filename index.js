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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { RULES, buildRules } from './lib/rules.mjs'
import * as vault from './lib/vault.mjs'
import { runReview } from './lib/review.mjs'
import * as bili from './lib/bili.mjs'
import * as login from './lib/login.mjs'
import { BILI_SITE, normalizeCustomSite } from './lib/sites.mjs'
import * as tidy from './lib/tidy.mjs'
import { GRACE_MIN, due, dayKey, stamp, hmOf, humanNow } from './lib/schedule.mjs'

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
  // 已弃用：改成「开始时间 + 时长」后逻辑不再读它，留着只为兼容老 config.json
  browseEndTime: z.string().default('').extra('volatile', true),
  browseMode: z.string().default('off').extra('volatile', true),
  // 自由逛单次最长（分钟）
  browseMaxMinutes: z.number().default(20).extra('volatile', true),
  // ── 指定网站（B站 + 自定义 MCP）：所有网站共用一套定时，到点依次逛，每个单独计时长 ──
  siteEnabled: z.boolean().default(false).extra('volatile', true),
  siteTime: z.string().default('').extra('volatile', true),
  siteMaxMinutes: z.number().default(20).extra('volatile', true),
  // B站 是否参与「指定网站」的定时逛（列表里那行的开关）
  biliEnabled: z.boolean().default(true).extra('volatile', true),
  // ── B站（内置网站）──
  biliPerDay: z.number().default(5).extra('volatile', true),
  biliAutoComment: z.boolean().default(false).extra('volatile', true),
  biliMentionName: z.string().default('').extra('volatile', true),
  biliReplyToComments: z.boolean().default(false).extra('volatile', true),
  biliDmMode: z.string().default('off').extra('volatile', true),
  biliDmUid: z.number().default(0).extra('volatile', true),
  biliKeywords: z.string().default('').extra('volatile', true),
  // 运行时自算：装好 venv 后记下 python 路径（不展示在设置页，只存 config.json）
  biliPythonPath: z.string().default('').extra('volatile', true),
  // ── 自定义网站（JSON 数组，每个是 normalizeCustomSite 认的对象）──
  customSites: z.string().default('').extra('volatile', true),
  // 复盘完顺手整理目录？默认关——先让「体检 + 整理」只在你手动点时动库
  tidyOnReview: z.boolean().default(false).extra('volatile', true),
})

const DEFAULTS = {
  vaultPath: '', rulesExtra: '',
  reviewEnabled: true, reviewTime: '23:00',
  apiBaseUrl: '', apiKey: '', model: '', reviewPrompt: '',
  browseEnabled: false, browseTime: '', browseEndTime: '', browseMode: 'off',
  browseMaxMinutes: 20,
  siteEnabled: false, siteTime: '', siteMaxMinutes: 20, biliEnabled: true,
  biliPerDay: 5, biliAutoComment: false, biliMentionName: '', biliReplyToComments: false,
  biliDmMode: 'off', biliDmUid: 0, biliKeywords: '', biliPythonPath: '',
  customSites: '',
  tidyOnReview: false,
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
    const line = `${stamp()}  ${msg}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 写不进不致命 */ }
    try { ctx.logger?.info?.(`[ai-brain] ${msg}`) } catch { /* 没有就算了 */ }
  }
  for (const n of hostDeps.notes) log(n)

  // ── 配置读取（跟 bili-scroll 同一套：类型钳制 + config.json + 宿主 describe） ──
  const cfgFile = join(stateDir, 'config.json')
  const readJson = (file, fb) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fb } }
  const writeJson = (file, v) => { try { writeFileSync(file, JSON.stringify(v, null, 2), 'utf8') } catch { /* 忽略 */ } }

  // 该用哪个 Python 跑 B站 的活（画二维码 / 起 MCP）：
  //   ① 插件自己记下的 venv python（装环境时写进 config.json）
  //   ② 家里 venv 的 python（依赖装好就存在）——收敛到这一条，别退回系统 python
  //   ③ 都没有才退回 'python'
  // ⚠️ 系统 Python 3.15 里没有 qrcode，直接用它画二维码会静默失败（面板上就是个裂图）。
  const venvPyPath = () => process.platform === 'win32'
    ? join(stateDir, '.venv', 'Scripts', 'python.exe')
    : join(stateDir, '.venv', 'bin', 'python')
  const biliPython = () => cfg.biliPythonPath
    || (bili.venvReadyNow(stateDir) ? venvPyPath() : 'python')

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
  // 时间统一存成 HH:mm（补零）：「2:00」「02:00」都收，避免格式不一致导致对时错配
  // ⚠️ 必须定义在 clampPatch 之前——loadCfg→clampPatch 在模块初始化时就会跑，定义在后会 TDZ ReferenceError
  const normalizeHm = (v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim())
    if (!m) return ''
    const h = Number(m[1]), min = Number(m[2])
    if (h > 23 || min > 59) return ''
    return `${String(h).padStart(2, '0')}:${m[2]}`
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
    if ('browseTime' in o) o.browseTime = normalizeHm(o.browseTime)
    if ('browseEndTime' in o) o.browseEndTime = normalizeHm(o.browseEndTime)
    if ('browseMode' in o) o.browseMode = ['off', 'kb'].includes(String(o.browseMode)) ? String(o.browseMode) : 'off'
    if ('browseMaxMinutes' in o) {
      const n = Number(o.browseMaxMinutes)
      o.browseMaxMinutes = Number.isFinite(n) ? Math.max(1, Math.min(180, Math.round(n))) : 20
    }
    if ('siteEnabled' in o) o.siteEnabled = Boolean(o.siteEnabled)
    if ('siteTime' in o) o.siteTime = normalizeHm(o.siteTime)
    if ('siteMaxMinutes' in o) {
      const n = Number(o.siteMaxMinutes)
      o.siteMaxMinutes = Number.isFinite(n) ? Math.max(1, Math.min(180, Math.round(n))) : 20
    }
    if ('biliEnabled' in o) o.biliEnabled = Boolean(o.biliEnabled)
    if ('biliPerDay' in o) o.biliPerDay = Math.max(0, Math.min(Number(o.biliPerDay) || 0, 50))
    if ('biliAutoComment' in o) o.biliAutoComment = Boolean(o.biliAutoComment)
    if ('biliMentionName' in o) o.biliMentionName = String(o.biliMentionName || '').slice(0, 50)
    if ('biliReplyToComments' in o) o.biliReplyToComments = Boolean(o.biliReplyToComments)
    if ('biliDmMode' in o) o.biliDmMode = ['off', 'only', 'both'].includes(String(o.biliDmMode)) ? String(o.biliDmMode) : 'off'
    if ('biliDmUid' in o) o.biliDmUid = Math.max(0, Math.floor(Number(o.biliDmUid) || 0))
    if ('biliKeywords' in o) o.biliKeywords = String(o.biliKeywords || '').slice(0, 500)
    if ('biliPythonPath' in o) o.biliPythonPath = String(o.biliPythonPath || '')
    if ('customSites' in o) o.customSites = String(o.customSites || '').slice(0, 20000)
    if ('tidyOnReview' in o) o.tidyOnReview = Boolean(o.tidyOnReview)
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

  tool({
    name: 'brain_tidy',
    description: '知识库体检 / 整理。action=scan（只读，报编号撞车、同名嵌套目录、空文件、未来日期、散落笔记）或 action=tidy（按固定规则表移动/改名，绝不删文件，绝不碰 3.自我 与 社交人格）。不确定怎么归类的东西它只报告不动手。',
    parameters: {
      action: { type: 'string', description: 'scan（只体检，默认）或 tidy（体检并把能确定的搬对位置）' },
    },
    async execute(args) {
      const a = String(args?.action || 'scan').trim()
      if (a === 'tidy') return doTidy()
      return doScan()
    },
  })

  // ── 功能 C：每日定时复盘 ──
  const stateFile = join(stateDir, 'state.json')
  const readState = () => readJson(stateFile, {})
  const bumpState = (patch) => writeJson(stateFile, { ...readState(), ...patch })

  // ── 进行中任务表（供设置页进度条用） ──
  // 每类任务一个键：review / browse / bilisetup；值为 { startedAt } 或 null（没在跑）
  const jobs = { review: null, browse: null, bilisetup: null }
  const jobStart = (k) => { jobs[k] = { startedAt: Date.now() } }
  const jobEnd = (k) => { jobs[k] = null }

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
    jobStart('review')
    const r = await runReview({
      vaultPath: cfg.vaultPath,
      apiBaseUrl: cfg.apiBaseUrl, apiKey: cfg.apiKey, model: cfg.model, reviewPrompt: cfg.reviewPrompt,
      log,
    })
    jobEnd('review')
    if (r.ok) {
      bumpState({ reviewed: { ...(readState().reviewed || {}), [today]: true }, lastReviewAt: stamp() })
      log(`复盘完成：写入 ${r.notes.length} 篇${r.archived ? '，收件箱已归档' : ''}`)
      // 复盘后顺手整理目录（默认关，见 Config.tidyOnReview）
      if (cfg.tidyOnReview && cfg.vaultPath) {
        try {
          const t = tidy.apply(cfg.vaultPath, { log })
          log(`复盘后整理：移动 ${t.moved.length} 项，跳过 ${t.skipped.length} 项${t.failed.length ? `，失败 ${t.failed.length} 项` : ''}${t.reportPath ? `（清单见 ${t.reportPath}）` : ''}`)
        } catch (e) { log(`复盘后整理出错（已兜住）：${e?.stack ?? e}`) }
      }
    } else {
      log(`复盘没成（${why}）：${r.error}${r.empty ? '（收件箱空，不算错）' : ''}`)
    }
    return r
  }

  // ── 功能 E：知识库体检 + 受限整理（规则驱动，不用模型） ──
  // 体检：只读，报「编号撞车 / 同名嵌套 / 空文件 / 未来日期 / 索引与目录同名 / 散落笔记」
  // 整理：只做 move / rename，绝不删除，绝不碰 3.自我 与 社交人格
  const doScan = () => {
    refreshCfg()
    if (!cfg.vaultPath) return { ok: false, error: '没配 vaultPath' }
    const s = tidy.scan(cfg.vaultPath)
    if (s.ok) log(`体检完成：${s.summary.total} 条（${s.summary.errors} 个硬错），待整理 ${tidy.plan(cfg.vaultPath).actions.length} 项`)
    return s
  }

  const doTidy = () => {
    refreshCfg()
    if (!cfg.vaultPath) return { ok: false, error: '没配 vaultPath' }
    log('整理开始（只移动/改名，不删文件）')
    const t = tidy.apply(cfg.vaultPath, { log })
    log(`整理完成：移动 ${t.moved.length} 项，跳过 ${t.skipped.length} 项${t.failed.length ? `，失败 ${t.failed.length} 项` : ''}`)
    return t
  }

  // ── 「到点了吗」的判断（见 lib/schedule.mjs 里的两条踩坑说明）──
  const tick = () => {
    try {
      refreshCfg()
      if (!cfg.reviewEnabled) return
      if (!due(cfg.reviewTime, reviewToday())) return
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
  // 找 dsh CLI。桌面版把 @deepseek-ai/dsh 打包进 app.asar，require.resolve 找不到；
  // 真实入口是 app.asar 里的 @deepseek-ai/dsh-desktop-host/lib/cli.js，
  // 用 process.execPath（=DeepSeek Harness.exe，带 ELECTRON_RUN_AS_NODE=1 时就是 node）
  //   加 --expose-internals 直接跑它——**别用 dsh.cmd + cmd /c**（.cmd 路径带空格会被截断成 'C:\DeepSeek'）。
  // 参考 dsh-bili-scroll：resolveDsh 返回 { command: process.execPath, args: [cli.js], shell: false }。
  const findDshCli = () => {
    // ⓪ 显式指定（调试/自定义安装用）：AI_BRAIN_DSH_CLI=<cli.js 的绝对路径>
    try {
      const forced = String(process.env.AI_BRAIN_DSH_CLI || '').trim()
      if (forced && existsSync(forced)) return forced
    } catch { /* 忽略 */ }
    // ① npm / web profile：让 Node 解析器找 bin.js
    try {
      for (const spec of ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-ai/dsh']) {
        try { const p = require.resolve(spec); if (p && existsSync(p)) return p } catch { /* 下一个 */ }
      }
    } catch { /* 忽略 */ }
    // ② 桌面版：app.asar 里的 cli.js（Electron 的 node 能读 asar；existsSync 也能命中 asar 内路径）
    try {
      const exeDir = dirname(process.execPath)
      const candidates = [
        join(exeDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
        'C:\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
      ]
      for (const p of candidates) if (p && existsSync(p)) return p
    } catch { /* 忽略 */ }
    return ''
  }

  const browseToday = () => readState().browsed?.[vault.dayKey()] === true
  const siteBrowsedToday = (siteId) => readState().siteBrowsed?.[`${siteId}:${vault.dayKey()}`] === true
  let browseChild = null   // 当前在跑的逛互联网子进程（到点要杀）
  let browseStartedAt = 0  // 本次逛的开始时间（epoch ms）
  let browseDeadline = 0   // 本次逛的结束时间（epoch ms，0=没在逛）
  let siteQueue = []       // 「指定网站」到点后的排队：还要依次逛哪些网站 id
  let siteRunKey = ''      // 已经起过的那一档（`日期 HH:mm`），防止同一档反复起

  // 时间口径统一在 lib/schedule.mjs（本地时间，不用 toISOString）；hmNow = 此刻的 HH:mm
  const hmNow = () => hmOf(Date.now())
  const stopBrowse = (reason, { keepQueue = false } = {}) => {
    if (!browseChild) return false
    log(`停止逛互联网：${reason}`)
    // 用户点「停止」= 整个队列都停（不然刚停就接着起下一个）；到点收尾只停当前这个
    if (!keepQueue) siteQueue = []
    try { browseChild.kill() } catch { /* 忽略 */ }
    browseChild = null
    browseDeadline = 0
    if (!siteQueue.length) jobEnd('browse')
    return true
  }

  // ── 指定网站：哪些网站要逛 ──
  // 列表 = B站（biliEnabled 控制）+ 所有启用的自定义站点。都在「指定网站」页里各有一行。
  const enabledSites = () => {
    const list = []
    if (cfg.biliEnabled !== false) list.push(BILI_SITE)
    for (const s of readCustomSites()) if (s.enabled !== false) list.push(s)
    return list
  }
  const siteById = (id) => (id === 'bili' ? BILI_SITE : readCustomSites().find((s) => s.id === id) || null)
  // 依次逛：一个跑完再起下一个（同时只跑一个，避免抢资源 + 抢知识库写入）
  const startNextSite = () => {
    if (browseChild) return false
    const id = siteQueue.shift()
    if (!id) return false
    const site = siteById(id)
    if (!site) { log(`指定网站 ${id} 已经不在了，跳过`); return startNextSite() }
    doBrowse('site', site).then((r) => {
      if (r?.ok) return
      // 起不来（没登录 / 没装环境 / 找不到 cli）别把队列卡死，报一句就继续下一个
      log(`指定网站「${site.name}」没逛成：${r?.error || '未知原因'}（跳过，继续下一个）`)
      setTimeout(() => { if (!browseChild) startNextSite() }, 0)
    }).catch((e) => {
      log(`指定网站「${site.name}」异常：${e?.stack ?? e}`)
      setTimeout(() => { if (!browseChild) startNextSite() }, 0)
    })
    return true
  }

  // 写 headless-overlay.yml：把某个网站的 MCP 挂进 headless 会话 + 打开 credentials（headless 默认禁）
  const ensureOverlay = (site) => {
    const out = join(stateDir, 'headless-overlay.yml')
    const lines = [
      '# dsh-ai-brain 自动生成：逛网站时把 MCP 挂进 headless 会话',
      '# 打开账号/授权/模型三件套（headless 默认禁用，不打开 MCP 拿不到 token）',
      '- id: credentials',
      '  disabled: false',
      '- id: authorization',
      '  disabled: false',
      '- id: deepseek-account',
      '  disabled: false',
    ]
    try {
      const m = ctx?.get?.('agentDefaultModel')?.currentSelection?.()
      if (m?.provider && m?.model) {
        lines.push(`- id: agent-default-model`)
        lines.push(`  config:`)
        lines.push(`    provider: ${m.provider}`)
        lines.push(`    model: ${m.model}`)
        if (m.reasoningEffort) lines.push(`    reasoningEffort: ${m.reasoningEffort}`)
      }
    } catch { /* 拿不到就跳过 */ }

    if (site?.id === 'bili') {
      const py = biliPython()
      lines.push(`- insert:`)
      lines.push(`    - id: mcp-bili-duty`)
      lines.push(`      name: '@deepseek-ai/dsh-mcp-client'`)
      lines.push(`      config:`)
      lines.push(`        serverName: bili-duty`)
      lines.push(`        transport: stdio`)
      lines.push(`        command: ${py}`)
      lines.push(`        args:`)
      lines.push(`          - ${join(stateDir, 'mcp_server.py')}`)
      lines.push(`        env:`)
      lines.push(`          BILI_MCP_TOOLS: ${biliWhitelist().join(',')}`)
      lines.push(`          PYTHONUTF8: '1'`)
      lines.push(`        failOnStartupError: false`)
    } else if (site?.transport === 'stdio') {
      lines.push(`- insert:`)
      lines.push(`    - id: mcp-site-${site.id}`)
      lines.push(`      name: '@deepseek-ai/dsh-mcp-client'`)
      lines.push(`      config:`)
      lines.push(`        serverName: ${site.id}`)
      lines.push(`        transport: stdio`)
      lines.push(`        command: ${site.command}`)
      if (Array.isArray(site.args) && site.args.length) {
        lines.push(`        args:`)
        for (const a of site.args) lines.push(`          - ${a}`)
      }
      if (site.env) {
        lines.push(`        env:`)
        for (const [k, v] of Object.entries(site.env)) lines.push(`          ${k}: ${v}`)
      }
      lines.push(`        failOnStartupError: false`)
    } else if (site?.transport === 'streamable-http') {
      lines.push(`- insert:`)
      lines.push(`    - id: mcp-site-${site.id}`)
      lines.push(`      name: '@deepseek-ai/dsh-mcp-client'`)
      lines.push(`      config:`)
      lines.push(`        serverName: ${site.id}`)
      lines.push(`        transport: streamable-http`)
      lines.push(`        url: ${site.url}`)
      if (site.headers) {
        lines.push(`        headers:`)
        for (const [k, v] of Object.entries(site.headers)) lines.push(`          ${k}: ${v}`)
      }
      lines.push(`        failOnStartupError: false`)
    }
    try { writeFileSync(out, lines.join('\n') + '\n', 'utf8') } catch (e) { log(`写 overlay 失败：${e?.message ?? e}`) }
    return out
  }

  const doBrowse = async (why = 'schedule', site = null) => {
    refreshCfg()
    // 手动逛（点了按钮 / 让 agent 跑）不受「定时开关」限制——用户当场让逛就逛。
    if (why === 'schedule' && !cfg.browseEnabled) return { ok: false, error: '逛互联网没开' }
    if (why === 'site' && !cfg.siteEnabled) return { ok: false, error: '指定网站的定时没开' }
    if (!cfg.vaultPath) return { ok: false, error: '没配 vaultPath' }
    if (browseChild) return { ok: false, error: '已经在逛了（要停就先点「停止」）' }
    const cli = findDshCli()
    if (!cli) { log('逛互联网没跑：找不到 dsh cli'); return { ok: false, error: '找不到 dsh cli' } }

    // 这次逛到几点结束：统一「从现在起 + 时长」——逛互联网用 browseMaxMinutes，
    // 指定网站用 siteMaxMinutes（每个网站各自计时长）。
    const mins = Math.max(1, Math.min(180, Math.round(Number(site ? cfg.siteMaxMinutes : cfg.browseMaxMinutes) || 20)))
    const endsAt = Date.now() + mins * 60_000
    jobStart('browse')
    browseStartedAt = Date.now()
    browseDeadline = endsAt

    // 逛指定网站 vs 自由逛
    const siteDir = site ? site.id : '综合'
    const mode = cfg.browseMode === 'kb' ? '贴近知识库内容做扩展学习（先看工作区里有没有知识库的说明/索引，再围绕它去逛）' : '自由逛，不做要求'
    const sitePrompt = site
      ? `今天逛的是「${site.name}」这个网站。你可以用 ${site.id === 'bili' ? 'bili_search / bili_subtitle / bili_comments / bili_video_info' : '这个网站提供的 MCP 工具'} 去搜、看内容，把对使用者有帮助的知识消化后记下来。`
      : ''
    const prompt = [
      '你是「AI 大脑」的逛互联网助手。请出去逛一圈，把对使用者未来有帮助的知识记下来。',
      `浏览偏好：${mode}`,
      sitePrompt,
      '要求：不要复制全文，消化后用自己的话记结论；每篇笔记写成 Markdown 文件，',
      `统一放到你工作目录下的 7.探索/${siteDir}/ 子目录里（文件名要像“以后会怎么搜它”）。`,
      '有用的结论、事实、工具、踩坑都要记；写 3-5 篇就够，别灌水。',
      '逛 3-5 个相关主题就停，最后写一篇简短的总结（今天逛了什么、记了什么、没逛成什么）。',
      `现在是 ${humanNow()}（本机本地时间，就是你唯一可信的“现在”）。`,
      `⚠️ 你的环境里读不到系统时间（pwsh/date 可能起不来）。所以文件名和正文里凡是写日期，**一律用 ${dayKey()} 这一天**，不许自己推测日期。`,
      `你这次逛最晚到 ${hmOf(endsAt)} 就必须收尾停笔（到点会被强制掐断，来不及写的先写个草稿）。`,
    ].filter(Boolean).join('\n')

    // 逛指定网站时挂 overlay（把 MCP 挂进去）
    const overlay = site ? ensureOverlay(site) : ''
    const args = ['--expose-internals', cli, '--profile', 'headless']
    if (overlay) args.push('--patch', overlay)
    args.push(prompt)

    log(`逛互联网开跑（${why}，${site ? `站点=${site.name}` : '自由'}，mode=${cfg.browseMode}，最晚 ${hmOf(endsAt)}）`)
    // 用 process.execPath 直接跑 cli.js（shell:false），不经过 dsh.cmd / cmd.exe，
    // 避免 .cmd 路径带空格被截断。参考 dsh-bili-scroll 的 resolveDsh。
    const child = spawn(process.execPath, args, {
      cwd: stateDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    })
    browseChild = child
    // 逛开始前先记下 stateDir/7.探索/<站点> 里已有的文件名，exit 时把新增的搬进知识库
    const preExisting = new Set()
    try {
      const bd = join(stateDir, '7.探索', siteDir)
      if (existsSync(bd)) for (const f of readdirSync(bd)) preExisting.add(f)
    } catch { /* 读不到就算了 */ }
    // cmd.exe 吐的中文报错是 GBK，按 UTF-8 写日志会变方块；先 UTF-8 解，出替换符就回退 GBK
    const toText = (buf) => {
      try {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))
        const u = b.toString('utf8')
        if (!u.includes('\uFFFD')) return u
        try { return new TextDecoder('gbk').decode(b) } catch { return u }
      } catch { return String(buf) }
    }
    const pick = (buf) => { try { appendFileSync(logFile, toText(buf), 'utf8') } catch { /* 忽略 */ } }
    child.stdout?.on('data', pick)
    child.stderr?.on('data', pick)
    child.on('exit', (code) => {
      browseChild = null
      browseDeadline = 0
      browseStartedAt = 0
      log(`逛互联网结束（code=${code}）${siteQueue.length ? `；队列里还有 ${siteQueue.length} 个网站，接着逛` : ''}`)
      // 队列还有 → 别收 job（进度条要继续转），由最后一个跑完再收
      if (!siteQueue.length) jobEnd('browse')
      // 把 headless 会话产出的笔记搬进知识库 7.探索/<站点>/（宿主不受沙箱限制，能写知识库）
      let moved = 0
      try {
        const srcDir = join(stateDir, '7.探索', siteDir)
        const dstDir = join(cfg.vaultPath, '7.探索', siteDir)
        if (existsSync(srcDir)) {
          mkdirSync(dstDir, { recursive: true })
          for (const f of readdirSync(srcDir)) {
            if (!/\.md$/i.test(f)) continue
            if (preExisting.has(f)) continue   // 只搬本次新产的，别重复搬历史
            try {
              renameSync(join(srcDir, f), join(dstDir, f))
              moved++
              log(`逛互联网笔记入知识库：7.探索/${siteDir}/${f}`)
            } catch (e) { log(`搬笔记 ${f} 失败：${e?.message ?? e}`) }
          }
        }
      } catch (e) { log(`搬笔记时出错：${e?.message ?? e}`) }
      if (moved) log(`逛互联网共 ${moved} 篇笔记写进知识库 7.探索/${siteDir}/`)
      else log('逛互联网结束：本次没有新增笔记落盘（可能没逛成、或笔记写在了别处）')
      if (site) bumpState({ siteBrowsed: { ...(readState().siteBrowsed || {}), [`${site.id}:${vault.dayKey()}`]: true } })
      else bumpState({ browsed: { ...(readState().browsed || {}), [vault.dayKey()]: true } })
      // 上一个逛完 → 接着逛队列里的下一个（指定网站到点那次会排队）
      if (siteQueue.length) {
        try { startNextSite() } catch (e) { log(`接着逛下一个失败：${e?.stack ?? e}`); siteQueue = []; jobEnd('browse') }
      }
    })
    child.on('error', (e) => {
      browseChild = null; browseDeadline = 0; browseStartedAt = 0
      log(`逛互联网起不来：${e?.message ?? e}`)
      if (siteQueue.length) { try { startNextSite() } catch { siteQueue = []; jobEnd('browse') } }
      else jobEnd('browse')
    })
    return { ok: true, started: true, endsAt: browseDeadline, maxMinutes: mins }
  }

  const browseTick = () => {
    try {
      refreshCfg()
      // 到点就杀（有始有终）：不用「== 某个钟点」——定时器踩空一分钟就永远杀不掉了
      if (browseChild && browseDeadline && Date.now() >= browseDeadline) {
        stopBrowse(`到结束时间 ${hmOf(browseDeadline)}，强制收尾`, { keepQueue: true })
      }
      // ① 逛互联网（自由逛）：到点一次
      if (cfg.browseEnabled && cfg.browseTime && !browseChild && !siteQueue.length) {
        if (due(cfg.browseTime, browseToday())) {
          doBrowse('schedule').catch((e) => log(`逛互联网异常：${e?.stack ?? e}`))
        }
      }
      // ② 指定网站：到点把所有「启用且今天还没逛」的依次逛一遍（每个单独计时长）
      if (cfg.siteEnabled && cfg.siteTime && !browseChild && !siteQueue.length) {
        const key = `${vault.dayKey()} ${cfg.siteTime}`
        if (siteRunKey !== key && due(cfg.siteTime, false)) {
          const list = enabledSites().filter((s) => !siteBrowsedToday(s.id))
          siteRunKey = key   // 这一档只起一次，失败的网站不反复重试
          if (!list.length) {
            log('指定网站到点了，但没有要逛的（全关了，或今天都逛过了）')
          } else {
            siteQueue = list.map((s) => s.id)
            log(`指定网站到点：依次逛 ${list.map((s) => s.name).join('、')}（每个最多 ${cfg.siteMaxMinutes} 分钟）`)
            startNextSite()
          }
        }
      }
    } catch (e) { log(`逛互联网定时器出错（已兜住）：${e?.stack ?? e}`) }
  }
  try {
    const bt = setInterval(browseTick, 60_000)
    bt.unref?.()
    ctx.effect(() => () => clearInterval(bt), 'ai-brain: 逛互联网定时器')
  } catch (e) { log(`逛互联网定时器没起来：${e?.message ?? e}`) }

  // ── 指定网站（内置 B站 + 自定义 MCP） ──
  // 铺 mcp_server.py 进家目录（内容同才跳过）
  bili.ensureHomeFiles(pluginDir, stateDir, log)

  const biliHasCredential = () => existsSync(join(stateDir, 'bili_credential.json'))
  let biliMcp = null
  let biliInstalling = false

  // 读自定义网站（从 cfg.customSites 这个 JSON 字符串里解析）
  const readCustomSites = () => {
    try {
      const arr = JSON.parse(String(cfg.customSites || '').trim() || '[]')
      if (!Array.isArray(arr)) return []
      return arr.map(normalizeCustomSite).filter(Boolean)
    } catch { return [] }
  }

  // 起 B站 MCP（venv 没装好会抛错；调用方 catch）
  const ensureBiliMcp = async () => {
    if (biliMcp?.running) return biliMcp
    const py = biliPython()
    biliMcp = bili.spawnBiliMcp({ pythonPath: py, stateDir, log })
    return biliMcp
  }
  const biliCall = async (toolName, args, opts) => {
    const client = await ensureBiliMcp()
    return client.call(toolName, args, opts)
  }

  const biliSetup = () => {
    if (biliInstalling) return { ok: true, busy: true, hint: '正在装，别重复起' }
    biliInstalling = true
    jobStart('bilisetup')
    const r = bili.runInstall({
      pluginDir, stateDir,
      pythonPath: biliPython(),
      log,
      onReady: (venvPy) => {
        // 写进 config.json（pythonPath 由插件自算，走本地优先）
        try {
          const cur = readJson(cfgFile, {})
          writeJson(cfgFile, { ...cur, biliPythonPath: venvPy, _set: [...(Array.isArray(cur._set) ? cur._set : []), 'biliPythonPath'] })
          refreshCfg()
        } catch (e) { log(`记 pythonPath 失败：${e?.message ?? e}`) }
      },
      // ⚠️ 不管成没成都要收尾：失败时若不复位，UI 会永远显示「安装中」、按钮永久禁用
      onDone: (code) => {
        biliInstalling = false
        jobEnd('bilisetup')
        if (code !== 0) log(`B站 环境装失败（exit ${code}）—— 详情看 install.log`)
      },
    })
    return r
  }

  const biliLoginStart = async () => {
    try {
      const { key, url } = await login.loginStart()
      const png = await login.renderQrPng(biliPython(), stateDir, url, [venvPyPath()])
      return {
        ok: true, key, url, png,
        hint: png ? '用 present 把这张 PNG 推给本人扫；扫完调 bili_login_poll（或面板点「查扫码」）' : '没画出 PNG：先点「装 B站 环境」（venv 里要有 qrcode）',
      }
    } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
  }

  const biliLoginPoll = async (key) => {
    const r = await login.loginPoll(String(key || ''))
    if (r.state === 'ok') {
      const file = login.saveCredential(stateDir, r.credential)
      log(`B站 登录成功，凭证已写入 ${file}`)
      return { ok: true, state: 'ok', file }
    }
    return { ok: r.state !== 'unknown', state: r.state, code: r.code, message: r.message }
  }

  // B站 工具白名单（写工具默认关，账号操作靠开关放出来）
  const biliWhitelist = () => {
    const list = [...BILI_SITE.whitelistDefault]
    if (cfg.biliAutoComment || cfg.biliReplyToComments) list.push('bili_reply')
    if (cfg.biliDmMode !== 'off') list.push('bili_send_message')
    return list
  }

  // ── B站 宿主工具注册 ──
  tool({
    name: 'bili_whoami',
    description: '看 B站 那边登录的是谁（凭证是否有效、昵称、mid）。第一次用要先在「AI 大脑」设置页里扫码登录。',
    parameters: {},
    async execute() {
      if (!biliHasCredential()) return { ok: false, loggedIn: false, hint: '还没登录：去「AI 大脑」设置页的「B站」里点「扫码登录」' }
      try {
        const r = await biliCall('bili_check_credential', {})
        return { ok: true, loggedIn: true, ...(typeof r === 'object' ? r : { raw: r }) }
      } catch (e) { return { ok: false, loggedIn: true, error: String(e?.message ?? e) } }
    },
  })

  tool({
    name: 'bili_search',
    description: '搜 B站 视频（可排序）。返回标题 / BV号 / 播放量 / UP / 时长 等。',
    parameters: {
      keyword: { type: 'string', description: '搜索关键词' },
      num: { type: 'number', description: '返回几条（默认 10，最大 50）' },
      order: { type: 'string', description: 'totalrank=综合（默认）/ click=播放 / pubdate=最新 / dm=弹幕' },
    },
    async execute(args) {
      try {
        return await biliCall('bili_search', {
          keyword: String(args.keyword ?? ''), num: Math.max(1, Math.min(Number(args.num) || 10, 50)), order: String(args.order || 'totalrank'),
        })
      } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    },
  })

  tool({
    name: 'bili_subtitle',
    description: '取一个视频的字幕（AI 字幕）全文。**判断内容就靠它**。',
    parameters: { bvid: { type: 'string', description: 'BV号' } },
    async execute(args) { try { return await biliCall('bili_subtitle', { bvid: String(args.bvid ?? '') }) } catch (e) { return { ok: false, error: String(e?.message ?? e) } } },
  })

  tool({
    name: 'bili_comments',
    description: '取一个视频的热门评论（含点赞/回复数）。',
    parameters: { bvid: { type: 'string', description: 'BV号' }, num: { type: 'number', description: '取几条（默认 30）' } },
    async execute(args) {
      try { return await biliCall('bili_comments', { bvid: String(args.bvid ?? ''), num: Math.max(1, Number(args.num) || 30) }) }
      catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    },
  })

  tool({
    name: 'bili_video_info',
    description: '取一个视频的详细信息（标题/UP/播放/简介等）。',
    parameters: { bvid: { type: 'string', description: 'BV号' } },
    async execute(args) { try { return await biliCall('bili_video_info', { bvid: String(args.bvid ?? '') }) } catch (e) { return { ok: false, error: String(e?.message ?? e) } } },
  })

  tool({
    name: 'bili_reply',
    description: '在视频下发评论（或回复某条评论）。🔴 安全闸：设置页「自动评论并 @」默认关；关着时拒绝——除非本人当场让你发（传 force: true）。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      text: { type: 'string', description: '评论正文（短、干净、纯文本 @；别写敏感词）' },
      rpid: { type: 'number', description: '要回复的评论 id（0/不填 = 发新评论）' },
      force: { type: 'boolean', description: '本人当场让你发的，传 true 越过"自动评论关着"的闸' },
    },
    async execute(args) {
      const commentOn = Boolean(cfg.biliAutoComment && cfg.biliMentionName)
      if (!commentOn && !args.force) {
        return { ok: false, blocked: true, hint: '要发评论得同时满足：设置里开「自动评论并 @」且填了「要 @ 谁」；或本人当场让你发时传 force: true。' }
      }
      try { return await biliCall('bili_reply', { bvid: String(args.bvid ?? ''), text: String(args.text ?? ''), rpid: Number(args.rpid) || 0 }) }
      catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    },
  })

  tool({
    name: 'bili_login_start',
    description: '开始 B站 扫码登录：出二维码（PNG 存在插件家目录，返回路径）+ key。拿到 PNG 用 present 推给本人扫，再调 bili_login_poll 轮询。二维码约 180 秒有效。',
    parameters: {},
    async execute() { return await biliLoginStart() },
  })

  tool({
    name: 'bili_login_poll',
    description: '查扫码结果：waiting 还没扫 / scanned 扫了待确认 / ok 成功 / expired 过期。成功自动写凭证。',
    parameters: { key: { type: 'string', description: 'bili_login_start 给的那个 key' } },
    async execute(args) { return await biliLoginPoll(String(args.key ?? '')) },
  })

  tool({
    name: 'bili_setup',
    description: '给 B站 装运行环境（建 venv 装 Python MCP 依赖）。第一次用之前跑一次，起完就返回不等装完，进度看 install.log。',
    parameters: {},
    async execute() { return biliSetup() },
  })

  tool({
    name: 'bili_status',
    description: '看 B站 源的当前状态：环境装没装、登录没、今天逛没、额度多少。',
    parameters: {},
    async execute() {
      refreshCfg()
      return {
        ok: true,
        venvReady: bili.venvReadyNow(stateDir),
        loggedIn: biliHasCredential(),
        perDay: cfg.biliPerDay, autoComment: cfg.biliAutoComment, mentionName: cfg.biliMentionName,
        replyToComments: cfg.biliReplyToComments, dmMode: cfg.biliDmMode, dmUid: cfg.biliDmUid,
        keywords: cfg.biliKeywords, home: stateDir,
      }
    },
  })

  tool({
    name: 'bili_run',
    description: '立刻起一个 headless 会话去逛 B站（不等定时窗口），逛完把笔记写进知识库 7.探索/bili/。适合"我现在就想看它逛一圈"的场合。需先装环境 + 扫码登录。',
    parameters: {},
    async execute() {
      refreshCfg()
      if (!biliHasCredential()) return { ok: false, error: 'B站 还没登录，先 bili_login_start 扫码，或去设置页点「扫码登录」' }
      if (!bili.venvReadyNow(stateDir)) return { ok: false, error: 'B站 环境没装好，先 bili_setup（后台装几分钟，看 install.log）' }
      const r = await doBrowse('manual', BILI_SITE)
      return r
    },
  })

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
        browseMaxMinutes: cfg.browseMaxMinutes,
        browseMode: cfg.browseMode, browsedToday: browseToday(), browsing: Boolean(browseChild),
        browseStartedAt, browseDeadline, siteQueued: siteQueue.length,
        modelConfigured: Boolean(cfg.apiBaseUrl && cfg.apiKey && cfg.model),
        jobs: { ...jobs },
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
    if (sub === '/tidy/scan' && req.method === 'GET') return sendJson(res, 200, doScan())
    if (sub === '/tidy/apply' && req.method === 'POST') return sendJson(res, 200, doTidy())
    if (sub === '/review' && req.method === 'POST') return sendJson(res, 200, await doReview('manual'))
    if (sub === '/browse' && req.method === 'POST') return sendJson(res, 200, await doBrowse('manual'))
    if (sub === '/browse/stop' && req.method === 'POST') {
      const stopped = stopBrowse('你在设置页点了停止')
      if (!stopped) log('点了停止，但当前没有在逛')
      return sendJson(res, 200, { ok: true, stopped })
    }
    // ── 指定网站（B站 + 自定义 MCP） ──
    if (sub === '/site/status' && req.method === 'GET') {
      refreshCfg()
      return sendJson(res, 200, {
        ok: true,
        bili: {
          venvReady: bili.venvReadyNow(stateDir),
          loggedIn: biliHasCredential(),
          enabled: cfg.biliEnabled !== false,
          perDay: cfg.biliPerDay, autoComment: cfg.biliAutoComment, mentionName: cfg.biliMentionName,
          replyToComments: cfg.biliReplyToComments, dmMode: cfg.biliDmMode, dmUid: cfg.biliDmUid,
          keywords: cfg.biliKeywords, installing: biliInstalling,
        },
        // 完整站点（设置页列表 + 编辑表单要用），不是只给 id/name
        customSites: readCustomSites(),
        sched: { enabled: cfg.siteEnabled, time: cfg.siteTime, maxMinutes: cfg.siteMaxMinutes },
        queued: siteQueue.length,
      })
    }
    if (sub === '/site/setup' && req.method === 'POST') return sendJson(res, 200, biliSetup())
    if (sub === '/site/login/start' && req.method === 'POST') return sendJson(res, 200, await biliLoginStart())
    if (sub === '/site/login/poll' && req.method === 'POST') {
      const body = await readBody(req)
      return sendJson(res, 200, await biliLoginPoll(String(body?.key || '')))
    }
    // 逛指定网站（POST {site:'bili'} 或 {site:'<customId>'}）
    if (sub === '/site/browse' && req.method === 'POST') {
      const body = await readBody(req)
      const id = String(body?.site || 'bili').trim()
      const site = id === 'bili' ? BILI_SITE : readCustomSites().find((s) => s.id === id)
      if (!site) return sendJson(res, 400, { ok: false, error: `没有这个网站：${id}` })
      if (site.id === 'bili' && !biliHasCredential()) return sendJson(res, 400, { ok: false, error: 'B站 还没登录，先去设置页扫码登录' })
      if (site.id === 'bili' && !bili.venvReadyNow(stateDir)) return sendJson(res, 400, { ok: false, error: 'B站 环境还没装，先去设置页「装 B站 环境」' })
      return sendJson(res, 200, await doBrowse('manual', site))
    }
    // 二维码 PNG 直出（img 标签直接指这个路由）
    if (sub === '/site/qr' && req.method === 'GET') {
      const pngPath = join(stateDir, 'qrcode_login.png')
      try {
        const buf = readFileSync(pngPath)
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
        res.end(buf)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('no qr yet')
      }
      return
    }
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
