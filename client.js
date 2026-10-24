/**
 * client.js —— 浏览器半端（设置在「设置」里的一页，分 4 个 tab）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本（抄 dsh-bili-scroll 的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: 'dsh-ai-brain',                 // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ 进「设置」：靠 slots 注入一个 settings.section
 *     slots.inject('settings.section', () => slots.register(
 *       { name:'settings.section', id:'ai-brain', order:40, label:'AI 大脑' },
 *       () => h(Panel),
 *     ))
 *
 * 这一页分 4 个 tab（用户 m02265 嫌一页往下拉太多）：
 *   ① 概览     —— 状态徽标 + 三个手动按钮（现在复盘/现在逛/看日志）+ 进行中进度 + 日志
 *   ② 记忆     —— 知识库路径 + 每日复盘（开关/时间）+ 复盘模型三件套 + 保存
 *   ③ 逛互联网 —— 开关 / 开始时间 / 单次最长 / 浏览偏好
 *   ④ 指定网站 —— 一个列表（B站 是其中一行）+ 新增/编辑/删除，每个网站可单独停用
 *
 * 执行类动作（复盘/逛互联网/装B站环境）加「进行中」进度反馈：
 *   - 后端 /status 返回 jobs（每类任务的 running 阶段），前端据此显示进度条/进行中徽标
 *   - 真百分比做不了（headless 会话是黑盒），但「启动中→运行中→完成/失败」阶段可见
 *
 * 所有读写都走宿主 HTTP 接口 /api/ai-brain/*，浏览器只跟本机说话。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-brain',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/ai-brain'
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-ab-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 8px;max-width:680px;}
[data-ab-tabs]{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));padding-bottom:0;margin-bottom:4px;}
[data-ab-tab]{padding:9px 16px;font-size:13px;cursor:pointer;border:none;background:none;color:var(--dsw-alias-label-secondary,#c9ccd1);
  border-bottom:2px solid transparent;margin-bottom:-1px;font-family:inherit;}
[data-ab-tab]:hover{color:inherit;}
[data-ab-tab][data-active]{color:#3b82f6;border-bottom-color:#3b82f6;font-weight:600;}
[data-ab-row]{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
[data-ab-row]+[data-ab-row]{margin-top:10px;}
[data-ab-grow]{flex:1;min-width:0;}
[data-ab-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);
  margin:18px 0 8px;text-transform:none;}
[data-ab-h]:first-child{margin-top:2px;}
[data-ab-label]{font-size:13px;}
[data-ab-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);margin-top:2px;}
[data-ab-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;margin-top:5px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-ab-input]:focus{outline:none;border-color:#3b82f6;}
[data-ab-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-ab-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-ab-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-ab-btn][disabled]{opacity:.5;cursor:default;}
[data-ab-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;margin-top:10px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ab-msg][data-warn]{color:#f59e0b;}
[data-ab-msg][data-good]{color:#22c55e;}
[data-ab-badge]{font-size:11px;padding:2px 8px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-ab-badge][data-live]{color:#22c55e;}
/* ── 网站列表：一行一个网站 ── */
[data-ab-site]{display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:8px;flex-wrap:wrap;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.10));}
[data-ab-site]+[data-ab-site]{margin-top:6px;}
[data-ab-site] [data-ab-label]{display:flex;align-items:center;gap:6px;font-size:13px;}
[data-ab-tag]{font-size:10px;padding:1px 6px;border-radius:5px;font-weight:400;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.20));color:var(--dsw-alias-label-secondary,#c9ccd1);}
/* 展开的小面板（新增/编辑表单、B站 设置） */
[data-ab-card]{margin-top:8px;padding:12px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.10));
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.18));}
[data-ab-card] [data-ab-label]:first-child{font-weight:600;margin-bottom:4px;}
[data-ab-pre]{margin:10px 0 0;padding:10px 12px;border-radius:8px;max-height:320px;overflow:auto;font-size:11px;
  line-height:16px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
/* ── 体检结果清单 ── */
[data-ab-issues]{margin-top:10px;padding:8px 10px;border-radius:8px;max-height:260px;overflow:auto;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.10));}
[data-ab-issue]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-ab-issue]+[data-ab-issue]{margin-top:3px;}
[data-ab-issue][data-level="error"]{color:#f59e0b;}
/* ── 进度条 ── */
[data-ab-progress]{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.18));overflow:hidden;flex:1;min-width:80px;}
[data-ab-progress] i{display:block;height:100%;background:#3b82f6;border-radius:3px;transition:width .3s ease;}
[data-ab-progress][data-indeterminate] i{width:40% !important;animation:abind 1.1s ease-in-out infinite;}
@keyframes abind{0%{margin-left:-40%}100%{margin-left:100%}}
/* ── 开关 Switch：滑块式，开=蓝+滑块右移，关=灰+滑块左移 ── */
[data-ab-sw]{position:relative;width:40px;height:22px;border-radius:11px;cursor:pointer;flex-shrink:0;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.25));transition:background .15s ease;padding:0;}
[data-ab-sw] i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:left .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.25);}
[data-ab-sw][data-on]{background:#3b82f6;border-color:#3b82f6;}
[data-ab-sw][data-on] i{left:20px;}
[data-ab-sw][disabled]{opacity:.5;cursor:default;}
`

    // epoch ms → 'HH:mm'
    const hmOf = (ms) => {
      const d = new Date(Number(ms))
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    // 还剩多久：'只剩 7 分钟' / '马上到点'
    const leftOf = (ms) => {
      const m = Math.round((Number(ms) - Date.now()) / 60000)
      return m <= 0 ? '马上到点' : `还剩 ${m} 分钟`
    }

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-ab-sw': '', 'data-on': on ? '' : undefined, disabled: Boolean(disabled),
        title: on ? '已开' : '已关', onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange }) {
      return h('div', { 'data-ab-row': '' },
        h('div', { 'data-ab-grow': '' },
          h('div', { 'data-ab-label': '' }, label),
          note ? h('div', { 'data-ab-note': '' }, note) : null),
        h(Switch, { on, onChange }))
    }

    function Field({ label, note, value, onChange, placeholder, type = 'text' }) {
      return h('div', { 'data-ab-row': '' },
        h('div', { 'data-ab-grow': '' },
          h('div', { 'data-ab-label': '' }, label),
          note ? h('div', { 'data-ab-note': '' }, note) : null,
          h('input', {
            'data-ab-input': '', type, value: value ?? '', placeholder,
            onChange: (e) => onChange(e.target.value),
          })))
    }

    // 多行输入（高级选项用）
    function TextArea({ label, note, value, onChange, placeholder, rows = 2 }) {
      return h('div', { 'data-ab-row': '' },
        h('div', { 'data-ab-grow': '' },
          h('div', { 'data-ab-label': '' }, label),
          note ? h('div', { 'data-ab-note': '' }, note) : null,
          h('textarea', {
            'data-ab-input': '', rows, style: { fontFamily: 'monospace', resize: 'vertical' },
            value: value ?? '', placeholder, onChange: (e) => onChange(e.target.value),
          })))
    }

    // 新增 / 编辑一个「指定网站」：基础三项 + 可展开的高级选项
    function SiteForm({ value, title, onCancel, onSave }) {
      const src = value || {}
      const [f, setF] = React.useState({
        name: src.name || '', transport: src.transport || 'stdio',
        command: src.command || '', url: src.url || '',
        _args: Array.isArray(src.args) ? src.args.join('\n') : '',
        _env: src.env ? Object.entries(src.env).map(([k, v]) => `${k}=${v}`).join('\n') : '',
        _headers: src.headers ? Object.entries(src.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '',
        _wl: Array.isArray(src.whitelist) ? src.whitelist.join(', ') : '',
      })
      const [adv, setAdv] = React.useState(false)
      const up = (k, v) => setF((o) => ({ ...o, [k]: v }))
      const stdio = f.transport === 'stdio'
      const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean)
      const kv = (s, sep) => { const o = {}; for (const l of lines(s)) { const i = l.indexOf(sep); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + sep.length).trim() } return o }
      const submit = () => {
        const out = { name: f.name, transport: f.transport }
        if (stdio) { out.command = f.command; const a = lines(f._args); if (a.length) out.args = a }
        else out.url = f.url
        const e = kv(f._env, '='); if (Object.keys(e).length) out.env = e
        const hd = kv(f._headers, ':'); if (Object.keys(hd).length) out.headers = hd
        const wl = String(f._wl || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean); if (wl.length) out.whitelist = wl
        onSave(out)
      }
      return h('div', { 'data-ab-card': '' },
        h('div', { 'data-ab-label': '' }, title),
        h(Field, { label: '名称', note: '列表里显示的名字，同时当它的 id（中文也行）', value: f.name, onChange: (v) => up('name', v), placeholder: '我的网站' }),
        h('div', { 'data-ab-row': '' },
          h('div', { 'data-ab-grow': '' },
            h('div', { 'data-ab-label': '' }, '类型'),
            h('div', { 'data-ab-note': '' }, '本地命令 = 我帮你把这个 MCP 起起来；网址 = 连一个已经在跑的')),
          h('select', {
            'data-ab-input': '', style: { width: 'auto' }, value: f.transport,
            onChange: (ev) => up('transport', ev.target.value),
          },
            h('option', { value: 'stdio' }, '本地命令（stdio）'),
            h('option', { value: 'streamable-http' }, '网址（streamable-http）'))),
        stdio
          ? h(Field, { label: '命令', note: '要启动的可执行文件（如 npx / python / 某个 .exe）', value: f.command, onChange: (v) => up('command', v), placeholder: 'npx' })
          : h(Field, { label: '网址', note: 'MCP 的 http(s) 地址', value: f.url, onChange: (v) => up('url', v), placeholder: 'http://127.0.0.1:9999/mcp' }),
        h('div', { 'data-ab-row': '' },
          h('button', { 'data-ab-btn': '', onClick: () => setAdv(!adv) }, adv ? '收起高级选项' : '高级选项（参数 / 环境变量 / 请求头 / 工具白名单）')),
        adv
          ? h('div', {},
              stdio ? h(TextArea, { label: '参数', note: '一行一个。不会当 shell 命令执行，只当普通参数传过去', value: f._args, onChange: (v) => up('_args', v), placeholder: '-y\n@modelcontextprotocol/server-filesystem\nD:\\notes', rows: 3 }) : null,
              stdio ? h(TextArea, { label: '环境变量', note: '一行一个 KEY=VALUE', value: f._env, onChange: (v) => up('_env', v), placeholder: 'API_KEY=xxx', rows: 2 }) : null,
              stdio ? null : h(TextArea, { label: '请求头', note: '一行一个 KEY: VALUE（要认证时用）', value: f._headers, onChange: (v) => up('_headers', v), placeholder: 'Authorization: Bearer xxx', rows: 2 }),
              h(TextArea, { label: '工具白名单', note: '留空 = 它的工具全给；填了就只给这些（逗号或换行分隔）。想稳妥就只写只读那几个', value: f._wl, onChange: (v) => up('_wl', v), placeholder: 'search, read_page', rows: 2 }))
          : null,
        h('div', { 'data-ab-row': '' },
          h('button', { 'data-ab-btn': '', 'data-primary': '', onClick: submit }, '确定'),
          h('button', { 'data-ab-btn': '', onClick: onCancel }, '取消')))
    }

    // 进度条：percent 0-100；indeterminate=true 时跑不确定动画（后台任务没精确进度）
    function Progress({ label, percent, indeterminate }) {
      return h('div', { 'data-ab-row': '' },
        h('div', { 'data-ab-label': '' }, label),
        h('div', {
          'data-ab-progress': '',
          'data-indeterminate': indeterminate ? '' : undefined,
        }, h('i', { style: { width: (percent || 0) + '%' } })))
    }

    function Panel() {
      const [tab, setTab] = React.useState('overview')
      const [st, setSt] = React.useState(null)
      const [fails, setFails] = React.useState(0)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      const [log, setLog] = React.useState('')   // 默认展开（用户 m02314 要日志默认打开），'' = 还没读到
      // 日志是「越往下越新」，所以要钉在底部——否则默认看到的是最老的那几行，得自己往下拖
      const logRef = React.useRef(null)
      const [logStick, setLogStick] = React.useState(true)   // 用户往回翻时先别抢他的滚动位置
      // 输入框绑本地草稿，别直接绑 cfg（页面轮询会冲掉正在打的字）
      const [draft, setDraft] = React.useState(null)  // null = 还没从 cfg 初始化
      // B站 源状态
      const [biliSt, setBiliSt] = React.useState(null)
      const [biliQr, setBiliQr] = React.useState('')
      // 体检结果（点「体检」后才填）
      const [check, setCheck] = React.useState(null)
      // 「指定网站」列表：editId = 正在编辑那一行的 id，adding = 正在新增，biliOpen = B站 那行展开设置
      const [editId, setEditId] = React.useState('')
      const [adding, setAdding] = React.useState(false)
      const [biliOpen, setBiliOpen] = React.useState(false)
      // 回收站
      const [bin, setBin] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status')
            if (!alive) return
            if (d && d.ok) { setSt(d); setFails(0) } else setFails((n) => n + 1)
          } catch { if (alive) setFails((n) => n + 1) }
        }
        tick()
        const t = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      // B站 源状态（每 5 秒拉一次）
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/site/status')
            if (alive && d && d.ok) setBiliSt(d)
          } catch { /* 读不到就算了 */ }
        }
        tick()
        const t = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      // 日志默认打开（m02314），初次加载就拉一次
      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const r = await jget('/log')
            if (alive) setLog(r && r.ok ? (r.text || '（日志是空的）') : '读不到日志')
          } catch (e) { if (alive) setLog('读不到日志：' + String(e?.message ?? e)) }
        })()
        return () => { alive = false }
      }, [])

      // 日志一更新就滚到底：新的一行永远在最下面
      React.useEffect(() => {
        const el = logRef.current
        if (!el) return
        if (logStick) el.scrollTop = el.scrollHeight
      }, [log, logStick])

      const cfg = st?.config
      // 后端不再回明文 apiKey（只回「已设置（N 位，不回显）」这种占位），
      // 所以草稿里 apiKey 初值留空：用户不填 = 不动原来的；填了才提交。
      const isMasked = (v) => typeof v === 'string' && v.startsWith('已设置（')
      React.useEffect(() => {
        if (cfg && draft === null) {
          setDraft({
            vaultPath: cfg.vaultPath || '',
            apiBaseUrl: cfg.apiBaseUrl || '',
            apiKey: isMasked(cfg.apiKey) ? '' : (cfg.apiKey || ''),
            model: cfg.model || '',
            reviewTime: cfg.reviewTime || '23:00',
            browseTime: cfg.browseTime || '',
            browseMaxMinutes: cfg.browseMaxMinutes == null ? 20 : cfg.browseMaxMinutes,
            siteTime: cfg.siteTime || '',
            siteMaxMinutes: cfg.siteMaxMinutes == null ? 20 : cfg.siteMaxMinutes,
            biliMentionName: cfg.biliMentionName || '',
            customSites: cfg.customSites || '',
            tailEveryMinutes: cfg.tailEveryMinutes == null ? 15 : cfg.tailEveryMinutes,
          })
        }
      }, [cfg, draft])

      const say = (text, tone) => { setMsg(text); setMsgTone(tone || '') }
      const set = (k, v) => setDraft((d) => ({ ...(d || {}), [k]: v }))

      const save = async () => {
        setBusy('save')
        try {
          const p = {}
          for (const k of ['vaultPath', 'apiBaseUrl', 'apiKey', 'model', 'reviewTime', 'browseTime', 'browseMaxMinutes', 'siteTime', 'siteMaxMinutes', 'tailEveryMinutes', 'biliMentionName', 'customSites']) {
            if (draft && k in draft) p[k] = draft[k]
          }
          // apiKey 留空 = 不改原来的（别把空串或脱敏占位写回去，把真 key 覆盖掉）
          if (!p.apiKey || isMasked(p.apiKey)) delete p.apiKey
          const r = await jpost('/config', p)
          if (r && r.ok) { say('已保存', 'good'); setSt((old) => ({ ...old, config: r.config })) }
          else say('没保存成：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onReview = async () => {
        setBusy('review'); say('复盘进行中…（收件箱 → 调模型归类 → 写库，完成会告诉你）')
        try {
          const r = await jpost('/review', {})
          if (r && r.ok) say(`复盘完成：写入 ${(r.notes || []).length} 篇${r.archived ? '，收件箱已归档' : ''}`, 'good')
          else if (r && r.empty) say('今天收件箱是空的，没什么可复盘', '')
          else say('复盘没成：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onBrowse = async () => {
        setBusy('browse'); say('')
        try {
          const r = await jpost('/browse', {})
          if (r && r.ok) say(`已经在后台逛了${r.endsAt ? '，' + hmOf(r.endsAt) + ' 自动收尾' : ''}，日志见「概览」页`, 'good')
          else say('没起来：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onBrowseStop = async () => {
        setBusy('browsestop'); say('')
        try {
          const r = await jpost('/browse/stop', {})
          if (r && r.ok) say(r.stopped ? '已停止逛互联网，本次产出已经收尾入库' : '当前没有在逛', r.stopped ? 'good' : '')
          else say('停止没成：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onTail = async (force) => {
        if (force && !window.confirm('重抓今天会把今天的对话再抽一遍，可能出现重复内容。要继续吗？')) return
        setBusy('tail'); say('正在读会话日志…')
        try {
          const r = await jpost('/tail', { force: force === true })
          if (r && r.ok) {
            say(r.added ? `抓完：${r.sessions} 个会话、${r.added} 条对话补进今天的收件箱` : '抓完了：没有新的对话（都记过了）', r.added ? 'good' : '')
            jget('/status').then((s) => s && s.ok && setSt(s)).catch(() => {})
          } else say('抓取没成：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onTidyScan = async () => {
        setBusy('scan'); say('')
        try {
          const r = await jget('/tidy/scan')
          if (r && r.ok) {
            setCheck(r)
            const s = r.summary || {}
            say(s.total ? `体检完：${s.total} 条（${s.errors} 个硬错）` : '体检完：没发现问题 ✓', s.errors ? 'warn' : 'good')
          } else { setCheck(null); say('体检没成：' + ((r && r.error) || '未知原因'), 'warn') }
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onTidyApply = async () => {
        if (!window.confirm('整理会做这几件事：\n\n· 把确定归错位的笔记搬到该去的目录\n· 修好「同名嵌套」「索引与目录同名」\n· 删掉空文件、以及与另一篇逐字节完全相同的重复件\n\n有内容的笔记绝不会被删。改动清单写进 9.归档/整理记录/，想撤回想查都照着来。\n一次要删超过 10 项时会先停下来只报告，确认后才动手。\n\n确定现在整理吗？')) return
        setBusy('tidy'); say('')
        try {
          const r = await jpost('/tidy/apply', {})
          if (r && r.ok && r.needsConfirm) {
            // 要删的太多：先给人看清单，确认才真删
            const list = (r.pending?.dels || []).slice(0, 12).map((d) => `· ${d.from}  (${d.why})`).join('\n')
            const more = (r.pending?.dels || []).length > 12 ? `\n… 还有 ${(r.pending?.dels || []).length - 12} 项` : ''
            if (!window.confirm(`这次要删 ${r.pending?.dels?.length || 0} 项，超过 10 项，我停下了没动手。\n\n${list}${more}\n\n确定要删这些吗？（只删空文件与逐字节重复的）`)) {
              say(`已取消，什么都没动。要删的 ${r.pending?.dels?.length || 0} 项还留在原地。`, '')
              return
            }
            const r2 = await jpost('/tidy/apply', { force: true })
            if (r2 && r2.ok) {
              say(`整理完：搬了 ${(r2.moved || []).length} 项，删了 ${(r2.deleted || []).length} 项${r2.reportPath ? `。清单：${r2.reportPath}` : ''}`, 'good')
              setCheck(null)
            } else say('整理没成：' + ((r2 && r2.error) || '未知原因'), 'warn')
            return
          }
          if (r && r.ok) {
            const n = (r.moved || []).length
            const d = (r.deleted || []).length
            say(`整理完：搬了 ${n} 项${d ? `，删了 ${d} 项` : ''}${(r.skipped || []).length ? `，跳过 ${(r.skipped || []).length} 项` : ''}${r.reportPath ? `。清单：${r.reportPath}` : ''}`, 'good')
            setCheck(null)
          } else say('整理没成：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      // ── 回收站 ──
      const onBinLoad = async () => {
        setBusy('bin')
        try {
          const r = await jget('/recycle')
          if (r && r.ok) { setBin(r); say(`回收站：现存 ${(r.items || []).length} 篇` + (r.dueFiles ? `，其中 ${r.dueFiles} 篇已到期` : ''), 'good') }
          else say('读不到回收站：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onBinPurge = async () => {
        const n = (bin && bin.dueFiles) || 0
        if (!n) { say('现在没有到期的东西，不用清。', 'good'); return }
        if (!window.confirm(`会把 ${n} 篇到期的东西（放满 ${bin.keepDays} 天了）真删掉，不能恢复。\n\n只是想清点地方就点取消。确定真删吗？`)) return
        setBusy('binpurge')
        try {
          const r = await jpost('/recycle/purge', { dryRun: false })
          if (r && r.ok) { say(`清掉了 ${r.deletedFiles || 0} 个文件`, 'good'); await onBinLoad() }
          else say('清理没成：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onBinRestore = async (path) => {
        setBusy('binrestore')
        try {
          const r = await jpost('/recycle/restore', { path })
          if (r && r.ok) { say(`搬回去了：${r.to}`, 'good'); await onBinLoad() }
          else say('搬不回去：' + ((r && r.error) || '未知原因') + '（多半是原位已经有同名的了）', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onLog = async () => {
        if (log) { setLog(''); return }  // 非空 = 已展开，点一下收起
        setBusy('log')
        try {
          const r = await jget('/log')
          setLog(r && r.ok ? (r.text || '（日志是空的）') : '读不到日志')
        } catch (e) { setLog('读不到日志：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

      const onBiliSetup = async (isReinstall) => {
        if (isReinstall && !window.confirm('B站 环境已经装好了。\n重装 = 把依赖再装一遍（几分钟，不会删已装的东西，也不会重建 venv）。确定要重装吗？')) return
        setBusy('bilisetup'); say('')
        try {
          const r = await jpost('/site/setup', {})
          if (r && r.ok) say(isReinstall ? '开始重装（几分钟，后台跑），日志见「概览」页' : '环境开始装（几分钟），装好会记下 python 路径', 'good')
          else say('没起来：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onBiliLogin = async () => {
        setBusy('bililogin'); say('')
        try {
          const r = await jpost('/site/login/start', {})
          if (r && r.ok && r.png) { setBiliQr(r.key); say('二维码已生成，用手机 B站 扫；约 180 秒有效', 'good') }
          else if (r && r.ok) { setBiliQr(''); say('没画出二维码：' + (r.hint || '先点「装 B站 环境」（venv 里要有 qrcode）'), 'warn') }
          else say('出码失败：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onBiliPoll = async () => {
        setBusy('bilipoll'); say('')
        try {
          const r = await jpost('/site/login/poll', { key: biliQr })
          if (r && r.ok && r.state === 'ok') { setBiliQr(''); say('登录成功 ✓', 'good') }
          else if (r && r.state === 'waiting') say('还没扫，等手机扫一下', '')
          else if (r && r.state === 'scanned') say('扫了，去手机点「确认登录」', '')
          else if (r && r.state === 'expired') { setBiliQr(''); say('二维码过期了，重新点「扫码登录」', 'warn') }
          else say((r && r.message) || (r && r.error) || '查不到结果', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onBiliBrowse = async () => {
        setBusy('bilibrowse'); say('')
        try {
          const r = await jpost('/site/browse', { site: 'bili' })
          if (r && r.ok) say(`已经在后台逛 B站 了${r.endsAt ? '，' + hmOf(r.endsAt) + ' 自动收尾' : ''}，笔记会落 7.探索/bili/，日志见「概览」页`, 'good')
          else say('没起来：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      // ── 指定网站：列表的增 / 删 / 改（改的是草稿，点「保存」才落盘） ──
      const parseSites = (s) => {
        try { const a = JSON.parse(String(s || '').trim() || '[]'); return Array.isArray(a) ? a : null } catch { return null }
      }
      const writeSites = (arr) => set('customSites', arr.length ? JSON.stringify(arr, null, 2) : '')
      const siteIdOf = (raw) => String(raw.id || '').trim() ||
        String(raw.name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fa5-]/g, '')
      const onSiteSave = (raw, origIdx) => {
        const cur = parseSites(draft?.customSites)
        if (cur === null) { say('现有网站配置不是合法 JSON，先修好再说', 'warn'); return }
        const id = siteIdOf(raw)
        const nm = String(raw.name || '').trim()
        if (!id || !nm) { say('得先填个名字', 'warn'); return }
        if (id === 'bili') { say('「bili」这个名字被内置的 B站 占了，换一个', 'warn'); return }
        if (cur.some((s, i) => i !== origIdx && (String(s.id || '') === id || String(s.name || '') === nm))) {
          say(`已经有个叫「${nm}」的网站了，换个名字`, 'warn'); return
        }
        const next = { ...raw, id }
        if (origIdx >= 0 && origIdx < cur.length) cur[origIdx] = { ...cur[origIdx], ...next }
        else cur.push(next)
        writeSites(cur)
        setAdding(false); setEditId('')
        say('改好了 —— 记得点「保存」才生效', '')
      }
      const onSiteDelete = (idx) => {
        const cur = parseSites(draft?.customSites)
        if (cur === null) { say('现有网站配置不是合法 JSON，先修好再说', 'warn'); return }
        const s = cur[idx] || {}
        if (!window.confirm(`把「${s.name || s.id || '这一项'}」从列表里删掉？\n\n只删这条配置，已经写进知识库的笔记不动。`)) return
        writeSites(cur.filter((_, i) => i !== idx))
        setEditId('')
        say('删掉了 —— 记得点「保存」才生效', '')
      }
      // 单个网站的「启用」开关：即时生效（顺手把当前列表一起存了，免得草稿白改）
      const onSiteEnable = (idx, on) => {
        const cur = parseSites(draft?.customSites)
        if (cur === null) { say('现有网站配置不是合法 JSON，先修好再说', 'warn'); return }
        if (!cur[idx]) return
        cur[idx] = { ...cur[idx], enabled: on }
        const json = JSON.stringify(cur, null, 2)
        set('customSites', json)
        jpost('/config', { customSites: json }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {})
      }

      if (!st || !cfg) {
        return h('div', { 'data-ab-page': '' },
          h('div', { 'data-ab-note': '' }, fails >= 3
            ? '读不到插件配置（已试 ' + fails + ' 次）。常见原因：刚装完没重启 dsh；或插件加载失败。'
            : '读设置中…'))
      }

      const sw = (k) => Boolean(cfg[k])
      // 用后端算好的 modelConfigured（它拿的是真 apiKey）；前端拿到的是脱敏占位，别拿它判真伪
      const modelOk = st?.modelConfigured != null
        ? Boolean(st.modelConfigured)
        : Boolean(cfg?.apiBaseUrl && cfg?.apiKey && cfg?.model)
      const biliVenvReady = Boolean(biliSt && biliSt.bili && biliSt.bili.venvReady)
      const biliLoggedIn = Boolean(biliSt && biliSt.bili && biliSt.bili.loggedIn)
      const biliInstalling = Boolean(biliSt && biliSt.bili && biliSt.bili.installing)

      // jobs：后端返回的进行中任务（用于进度反馈）
      const jobs = st.jobs || {}
      const reviewing = Boolean(jobs.review)
      const browsing = Boolean(st.browsing || jobs.browse)
      const installing = Boolean(biliInstalling || jobs.bilisetup)

      const TABS = [
        { id: 'overview', label: '概览' },
        { id: 'memory', label: '记忆' },
        { id: 'browse', label: '逛互联网' },
        { id: 'sites', label: '指定网站' },
        { id: 'recycle', label: '回收站' },
      ]

      const tabBar = h('div', { 'data-ab-tabs': '' },
        TABS.map((t) => h('button', {
          key: t.id, 'data-ab-tab': '', 'data-active': tab === t.id ? '' : undefined,
          onClick: () => setTab(t.id),
        }, t.label)))

      const msgEl = msg ? h('div', { 'data-ab-msg': '', 'data-good': msgTone === 'good' ? '' : undefined, 'data-warn': msgTone === 'warn' ? '' : undefined }, msg) : null

      // ── 概览页：状态徽标 + 进行中进度 + 手动按钮 + 日志 ──
      const overview = h('div', {},
        h('div', { 'data-ab-row': '' },
          h('span', { 'data-ab-badge': '' }, 'v' + (st.version || '?')),
          h('span', { 'data-ab-badge': '' }, cfg.vaultPath ? '库已配置' : '库未配置'),
          h('span', { 'data-ab-badge': '' }, modelOk ? '模型已配' : '模型未配'),
          h('span', { 'data-ab-badge': '' }, st.reviewedToday ? '今天已复盘' : '今天未复盘'),
          browsing ? h('span', { 'data-ab-badge': '', 'data-live': '' }, '● 逛互联网进行中') : null),
        reviewing ? h(Progress, { label: '复盘进行中', indeterminate: true }) : null,
        browsing ? h(Progress, { label: '逛互联网进行中', indeterminate: true }) : null,
        browsing && st.browseDeadline
          ? h('div', { 'data-ab-note': '' }, `预计 ${hmOf(st.browseDeadline)} 自动收尾（${leftOf(st.browseDeadline)}）；想提前停就点右边「停止」`)
          : null,
        installing ? h(Progress, { label: 'B站 环境安装中（后台）', indeterminate: true }) : null,

        h('div', { 'data-ab-row': '' },
          h('button', { 'data-ab-btn': '', 'data-primary': '', disabled: busy === 'review' || reviewing, onClick: onReview }, '现在复盘'),
          h('button', { 'data-ab-btn': '', disabled: busy === 'browse' || browsing, onClick: onBrowse }, '现在逛'),
          browsing ? h('button', { 'data-ab-btn': '', disabled: busy === 'browsestop', onClick: onBrowseStop }, '停止') : null,
          h('button', { 'data-ab-btn': '', disabled: busy === 'log', onClick: onLog }, log ? '收起日志' : '看日志')),

        log ? h('pre', {
          'data-ab-pre': '',
          ref: logRef,
          onScroll: (e) => {
            const el = e.currentTarget
            // 离底 24px 内算「还在看最新的」，再往上翻就说明用户在看历史，别抢
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            setLogStick((v) => (v === atBottom ? v : atBottom))
          },
        }, log) : null,
      )

      // ── 记忆页：库路径 + 每日复盘 + 复盘模型 ──
      const memory = h('div', {},
        h('div', { 'data-ab-h': '' }, '知识库'),
        h(Field, {
          label: '库路径（vaultPath）',
          note: '一个已存在的 Obsidian 库路径（就是 Markdown 文件夹），如 C:\\知识库\\My Brain',
          value: draft?.vaultPath, onChange: (v) => set('vaultPath', v),
          placeholder: 'C:\\知识库\\My Brain',
        }),

        h('div', { 'data-ab-h': '' }, '每日复盘'),
        h(ToggleRow, {
          label: '开启每日复盘',
          note: '到点自动读当天草稿 → 调模型归类写库（像睡前总结）',
          on: sw('reviewEnabled'),
          onChange: (v) => { jpost('/config', { reviewEnabled: v }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
        }),
        h(Field, {
          label: '复盘时间', note: '格式 HH:mm，到点自动跑（每天一次）',
          value: draft?.reviewTime, onChange: (v) => set('reviewTime', v),
          placeholder: '23:00',
        }),

        h('div', { 'data-ab-h': '' }, '复盘模型（OpenAI 兼容接口）'),
        h(Field, { label: 'apiBaseUrl', note: '如 https://api.deepseek.com/v1', value: draft?.apiBaseUrl, onChange: (v) => set('apiBaseUrl', v), placeholder: 'https://api.deepseek.com/v1' }),
        h(Field, { label: 'apiKey', note: '密钥，只存本机 config.json。后端不回显，留空 = 不改原来的；要换就整串重填', value: draft?.apiKey, onChange: (v) => set('apiKey', v), placeholder: cfg && isMasked(cfg.apiKey) ? cfg.apiKey : 'sk-...' }),
        h(Field, { label: 'model', note: '如 deepseek-chat', value: draft?.model, onChange: (v) => set('model', v), placeholder: 'deepseek-chat' }),

        h('div', { 'data-ab-h': '' }, '知识库体检 / 整理'),
        h('div', { 'data-ab-note': '' }, '体检是只读的：编号撞车、同名嵌套目录、空文件、日期写在未来、笔记散在目录根下、重复笔记——这些规则都能判准，不用模型。整理会按规则表搬动/改名、合并重复，并删掉空文件和逐字节重复的笔记；有内容的笔记绝不会被删，每处改动都记进 9.归档/整理记录。拿不准的只报告不动手。'),
        h('div', { 'data-ab-row': '' },
          h('button', { 'data-ab-btn': '', disabled: busy === 'scan', onClick: onTidyScan }, busy === 'scan' ? '体检中…' : '体检一下'),
          h('button', { 'data-ab-btn': '', disabled: busy === 'tidy', onClick: onTidyApply }, busy === 'tidy' ? '整理中…' : '整理目录')),
        check && check.ok
          ? h('div', { 'data-ab-issues': '' },
              (check.issues || []).length
                ? (check.issues || []).map((it, i) => h('div', { 'data-ab-issue': '', 'data-level': it.level }, `${it.level === 'error' ? '硬错' : '提醒'}：${it.title}`))
                : h('div', { 'data-ab-note': '' }, '没发现问题 ✓'))
          : null,
        h(ToggleRow, {
          label: '复盘后自动整理',
          note: '开：每次复盘完顺手按规则表整理一遍目录（动的只有确定归错位的，会写清单）。默认关',
          on: !!cfg.tidyOnReview,
          onChange: (v) => { jpost('/config', { tidyOnReview: v }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
        }),

        // ── 会话尾巴：不依赖模型主动记 ──
        h('div', { 'data-ab-h': '' }, '会话尾巴（别丢）'),
        h('div', { 'data-ab-note': '' }, '对话要不要记，以前全看模型某一步有没有主动调 brain_capture——它不调，这段话就没了。打开这个，插件会定时去 DSH 会话日志里把「你说的原话 + 我当时的回答」抢救进当天收件箱，等复盘时再判断值不值得留。只抓人说的话（会话日志里八成是系统注入，会被过滤）。'),
        h(ToggleRow, {
          label: '自动抓会话尾巴',
          note: '开：每 N 分钟把今天新说过的对话补进 0.收件箱/当天.md',
          on: !!cfg.tailCapture,
          onChange: (v) => { jpost('/config', { tailCapture: v }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
        }),
        h(Field, {
          label: '隔多久抓一次（分钟）',
          note: '5–120，默认 15。改完点下面的「保存」',
          type: 'number',
          value: draft.tailEveryMinutes,
          onChange: (v) => setDraft((d) => ({ ...d, tailEveryMinutes: v })),
        }),
        h('div', { 'data-ab-row': '' },
          h('button', { 'data-ab-btn': '', disabled: busy === 'tail', onClick: () => onTail(false) }, busy === 'tail' ? '抓取中…' : '现在抓一次'),
          h('button', { 'data-ab-btn': '', disabled: busy === 'tail', onClick: () => onTail(true) }, '重抓今天（可能重复）'),
          h('div', { 'data-ab-note': '' }, st && st.tailSessions ? `已记 ${st.tailSessions} 个会话的水位` : '还没抓过')),
        h(ToggleRow, {
          label: '启动时补跑漏掉的活',
          note: '开：DSH 一启动就检查「今天该做的复盘/逛网做了没」，没做就补。定时器活在进程内存里，DSH 一关就没了——白天关机不会因此漏掉一整天',
          on: !!cfg.catchUp,
          onChange: (v) => { jpost('/config', { catchUp: v }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
        }),

        h('div', { 'data-ab-row': '' },
          h('button', { 'data-ab-btn': '', 'data-primary': '', disabled: busy === 'save', onClick: save }, '保存'),
          h('div', { 'data-ab-note': '' }, '库路径 / 模型三件套 / 两个时间在改完后点「保存」生效；开关即时生效。')),
      )

      // ── 逛互联网页 ──
      const browse = h('div', {},
        h('div', { 'data-ab-h': '' }, 'AI 逛互联网'),
        h(ToggleRow, {
          label: '开启逛互联网',
          note: '到点起一个 headless 会话出去逛，把有用的记进知识库',
          on: sw('browseEnabled'),
          onChange: (v) => { jpost('/config', { browseEnabled: v }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
        }),
        h(Field, { label: '开始时间', note: 'HH:mm，到点自动开逛（每天一次）；留空 = 只手动逛', value: draft?.browseTime, onChange: (v) => set('browseTime', v), placeholder: '21:00' }),
        h(Field, { label: '单次最长（分钟）', note: '从开始那一刻算，最多逛这么久（1–180），到点强制收尾', value: draft?.browseMaxMinutes, onChange: (v) => set('browseMaxMinutes', v), placeholder: '20' }),
        h('div', { 'data-ab-row': '' },
          h('div', { 'data-ab-grow': '' },
            h('div', { 'data-ab-label': '' }, '浏览偏好'),
            h('div', { 'data-ab-note': '' }, 'off=不做要求 / kb=贴近知识库内容扩展学习')),
          h('select', {
            'data-ab-input': '', style: { width: 'auto' }, value: cfg.browseMode || 'off',
            onChange: (e) => { jpost('/config', { browseMode: e.target.value }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
          },
            h('option', { value: 'off' }, 'off —— 自由逛'),
            h('option', { value: 'kb' }, 'kb —— 贴近知识库'))),
        browsing ? h(Progress, { label: '逛互联网进行中', indeterminate: true }) : null,
        browsing && st.browseDeadline
          ? h('div', { 'data-ab-note': '' }, `预计 ${hmOf(st.browseDeadline)} 自动收尾（${leftOf(st.browseDeadline)}）`)
          : null,
        browsing
          ? h('div', { 'data-ab-row': '' },
              h('button', { 'data-ab-btn': '', disabled: busy === 'browsestop', onClick: onBrowseStop }, '停止这次逛'))
          : null,
      )

      // ── 指定网站页：一个列表（B站 也是其中一行）+ 新增入口 ──
      const customArr = parseSites(draft?.customSites)
      const siteNote = (s) => {
        const how = s.transport === 'streamable-http'
          ? `网址 ${s.url || '（没填地址）'}`
          : `本地命令 ${s.command || '（没填命令）'}`
        return how + (s.enabled === false ? ' · 已停用' : '')
      }
      const siteRow = (key, name, tag, note, swOn, swChange, actions) => h('div', { key, 'data-ab-site': '' },
        h('div', { 'data-ab-grow': '' },
          h('div', { 'data-ab-label': '' }, name, tag ? h('span', { 'data-ab-tag': '' }, tag) : null),
          h('div', { 'data-ab-note': '' }, note)),
        h(Switch, { on: swOn, onChange: swChange, disabled: !swChange }),
        ...(actions || []))

      const sites = h('div', {},
        h('div', { 'data-ab-h': '' }, '到点自动逛'),
        h(ToggleRow, {
          label: '到点依次逛下面所有启用的网站',
          note: '每个网站单独计时长，一个逛完接着下一个；没登录/没装环境的会跳过并记一行日志',
          on: sw('siteEnabled'),
          onChange: (v) => { jpost('/config', { siteEnabled: v }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
        }),
        h(Field, { label: '开始时间', note: 'HH:mm，到点开逛（每天一次）；留空 = 只手动逛', value: draft?.siteTime, onChange: (v) => set('siteTime', v), placeholder: '01:00' }),
        h(Field, { label: '每个网站单次最长（分钟）', note: '每个网站各自从它开始那一刻算（1–180）', value: draft?.siteMaxMinutes, onChange: (v) => set('siteMaxMinutes', v), placeholder: '20' }),

        h('div', { 'data-ab-h': '' }, '网站列表'),
        h('div', { 'data-ab-note': '' }, '开关 = 定时到点时要不要自动逛它。点「B站 设置」看它的登录和账号操作。'),
        siteRow('bili', 'B站', '内置',
          `${biliVenvReady ? '环境已就绪' : '环境未装'} · ${biliLoggedIn ? '已登录' : '未登录'}${installing ? ' · 装环境中…' : ''}`,
          sw('biliEnabled'),
          (v) => { jpost('/config', { biliEnabled: v }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
          [
            h('button', { 'data-ab-btn': '', onClick: () => setBiliOpen(!biliOpen) }, biliOpen ? '收起 B站 设置' : 'B站 设置'),
            biliLoggedIn ? h('button', { 'data-ab-btn': '', disabled: busy === 'bilibrowse' || browsing, onClick: onBiliBrowse }, '逛一下') : null,
          ].filter(Boolean)),

        biliOpen
          ? h('div', { 'data-ab-card': '' },
              h('div', { 'data-ab-row': '' },
                h('span', { 'data-ab-badge': '' }, biliVenvReady ? '环境已就绪' : '环境未装'),
                h('span', { 'data-ab-badge': '' }, biliLoggedIn ? '已登录' : '未登录'),
                installing ? h('span', { 'data-ab-badge': '', 'data-live': '' }, '● 装环境中') : null,
                h('div', { 'data-ab-grow': '' }),
                h('button', { 'data-ab-btn': '', disabled: busy === 'bilisetup' || installing, onClick: () => onBiliSetup(biliVenvReady) }, biliVenvReady ? '重装环境' : '装 B站 环境'),
                biliLoggedIn ? null : h('button', { 'data-ab-btn': '', 'data-primary': '', disabled: busy === 'bililogin', onClick: onBiliLogin }, '扫码登录'),
                browsing ? h('button', { 'data-ab-btn': '', disabled: busy === 'browsestop', onClick: onBrowseStop }, '停止') : null),
              biliQr
                ? h('div', { 'data-ab-row': '' },
                    h('img', { src: '/api/ai-brain/site/qr?k=' + encodeURIComponent(biliQr), alt: '扫码登录二维码', style: { width: 160, height: 160, borderRadius: 8, background: '#fff' } }),
                    h('div', { 'data-ab-grow': '' },
                      h('div', { 'data-ab-note': '' }, '手机 B站 → 我的 → 扫一扫。扫完点「查扫码结果」。'),
                      h('button', { 'data-ab-btn': '', disabled: busy === 'bilipoll', onClick: onBiliPoll }, '查扫码结果')))
                : null,
              h(ToggleRow, {
                label: '自动评论并 @', note: '开着时逛到值得的视频会发评论 @ 你（默认关）',
                on: sw('biliAutoComment'),
                onChange: (v) => { jpost('/config', { biliAutoComment: v }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
              }),
              h(Field, { label: '要 @ 谁', note: 'B站 昵称（自动评论时 @ 这个人）', value: draft?.biliMentionName, onChange: (v) => set('biliMentionName', v), placeholder: '昵称' }),
              h(ToggleRow, {
                label: '回复评论', note: '有人回复你那条评论时回一句（默认关）',
                on: sw('biliReplyToComments'),
                onChange: (v) => { jpost('/config', { biliReplyToComments: v }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
              }))
          : null,

        customArr === null
          ? h('div', { 'data-ab-note': '' }, '⚠️ 现在存着的网站配置不是合法 JSON，列表读不出来。点右边「清空并重来」把这段配置丢掉（知识库里的笔记不受影响），再重新加网站。')
          : null,
        customArr === null
          ? h('div', { 'data-ab-row': '' },
              h('button', { 'data-ab-btn': '', onClick: () => { if (window.confirm('把这段读不懂的网站配置清空？')) { set('customSites', ''); say('清空了 —— 记得点「保存」', '') } } }, '清空并重来'))
          : null,

        customArr && customArr.length
          ? customArr.map((s, i) => siteRow('s' + i, s.name || s.id || '(没名字)', '', siteNote(s),
              s.enabled !== false, (v) => onSiteEnable(i, v),
              [
                h('button', { 'data-ab-btn': '', onClick: () => { setEditId(String(i)); setAdding(false) } }, '编辑'),
                h('button', { 'data-ab-btn': '', onClick: () => onSiteDelete(i) }, '删除'),
              ]))
          : null,
        customArr && !customArr.length
          ? h('div', { 'data-ab-note': '' }, '还没有自定义网站。点下面「+ 新增网站」加一个（需要那个网站自己提供 MCP）。')
          : null,

        editId !== '' && customArr && customArr[Number(editId)]
          ? h(SiteForm, {
              key: 'edit-' + editId, title: '编辑网站',
              value: customArr[Number(editId)],
              onCancel: () => setEditId(''),
              onSave: (raw) => onSiteSave(raw, Number(editId)),
            })
          : null,
        adding
          ? h(SiteForm, {
              key: 'new', title: '新增网站',
              value: {}, onCancel: () => setAdding(false),
              onSave: (raw) => onSiteSave(raw, -1),
            })
          : null,

        h('div', { 'data-ab-row': '' },
          h('button', { 'data-ab-btn': '', disabled: adding, onClick: () => { setAdding(true); setEditId('') } }, '+ 新增网站'),
          h('button', { 'data-ab-btn': '', 'data-primary': '', disabled: busy === 'save', onClick: save }, '保存')),
        h('div', { 'data-ab-note': '' }, '时间 / 时长 / 增删改都要点「保存」才生效；开关是即时生效的。'),
      )

      // ── 回收站页：AI 复盘时判断「没价值」的笔记搬到这里，保留 N 天后真删 ──
      const binItems = (bin && bin.items) || []
      const recycle = h('div', {},
        h('div', { 'data-ab-h': '' }, '回收站'),
        h('div', { 'data-ab-note': '' },
          `复盘时我会先想一遍：库里哪篇已经被取代、过时、只剩没头没尾的草稿、或者同一件事说了几遍。判断没价值的，我搬到这里来，不直接删。保留 ${(bin && bin.keepDays) || 90} 天，到期自动真删。想留着就点「搬回去」。`),
        h('div', { 'data-ab-row': '' },
          h('span', { 'data-ab-badge': '' }, `现存 ${binItems.length} 篇`),
          (bin && bin.dueFiles) ? h('span', { 'data-ab-badge': '', 'data-live': '' }, `到期 ${bin.dueFiles} 篇待清`) : null,
          h('button', { 'data-ab-btn': '', disabled: busy === 'bin', onClick: onBinLoad }, busy === 'bin' ? '读取中…' : '刷新'),
          h('button', {
            'data-ab-btn': '', disabled: busy === 'binpurge',
            onClick: onBinPurge,
          }, busy === 'binpurge' ? '清理中…' : '清理到期的')),
        binItems.length
          ? h('div', { 'data-ab-issues': '' }, binItems.map((it) => h('div', { 'data-ab-issue': '', key: it.path, 'data-level': (it.ageDays != null && it.ageDays >= ((bin && bin.keepDays) || 90) - 7) ? 'error' : 'warn' },
              h('span', {}, `${it.original}　`),
              h('span', { 'data-ab-note': '', style: { display: 'inline' } }, `放了 ${it.ageDays == null ? '?' : it.ageDays} 天`),
              h('button', { 'data-ab-btn': '', style: { marginLeft: '8px' }, disabled: busy === 'binrestore', onClick: () => onBinRestore(it.path) }, '搬回去'))))
          : h('div', { 'data-ab-note': '' }, '回收站是空的 —— 这说明库里没有我判断该清掉的东西，正常。'),
        h('div', { 'data-ab-note': '' }, '被搬到这里的东西会在 9.归档/回收站/<日期>/ 下留一份原文件 + 一份清单（写了为什么）。清理是每天复盘后顺手做的。'),
      )

      const body = tab === 'overview' ? overview
        : tab === 'memory' ? memory
        : tab === 'browse' ? browse
        : tab === 'recycle' ? recycle
        : sites

      return h('div', { 'data-ab-page': '' }, tabBar, msgEl, body)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-ai-brain')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-ai-brain: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'ai-brain', order: 40, label: 'AI 大脑' },
          () => h(Panel),
        ))
      },
    }
  },
})
