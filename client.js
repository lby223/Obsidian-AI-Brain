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
 *   ③ 逛互联网 —— 开关/逛时间/结束时间/浏览偏好
 *   ④ 网站源   —— B站（环境/登录徽标、扫码登录、逛B站、账号开关）+ 自定义网站源
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
[data-ab-pre]{margin:10px 0 0;padding:10px 12px;border-radius:8px;max-height:320px;overflow:auto;font-size:11px;
  line-height:16px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
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
      // 输入框绑本地草稿，别直接绑 cfg（页面轮询会冲掉正在打的字）
      const [draft, setDraft] = React.useState(null)  // null = 还没从 cfg 初始化
      // B站 源状态
      const [biliSt, setBiliSt] = React.useState(null)
      const [biliQr, setBiliQr] = React.useState('')

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

      const cfg = st?.config
      React.useEffect(() => {
        if (cfg && draft === null) {
          setDraft({
            vaultPath: cfg.vaultPath || '',
            apiBaseUrl: cfg.apiBaseUrl || '',
            apiKey: cfg.apiKey || '',
            model: cfg.model || '',
            reviewTime: cfg.reviewTime || '23:00',
            browseTime: cfg.browseTime || '',
            browseEndTime: cfg.browseEndTime || '',
            biliMentionName: cfg.biliMentionName || '',
            customSites: cfg.customSites || '',
          })
        }
      }, [cfg, draft])

      const say = (text, tone) => { setMsg(text); setMsgTone(tone || '') }
      const set = (k, v) => setDraft((d) => ({ ...(d || {}), [k]: v }))

      const save = async () => {
        setBusy('save')
        try {
          const p = {}
          for (const k of ['vaultPath', 'apiBaseUrl', 'apiKey', 'model', 'reviewTime', 'browseTime', 'browseEndTime', 'biliMentionName', 'customSites']) {
            if (draft && k in draft) p[k] = draft[k]
          }
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
          if (r && r.ok) say('已经在后台逛了，日志见「概览」页', 'good')
          else say('没起来：' + ((r && r.error) || '未知原因'), 'warn')
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
          if (r && r.ok) say('已经在后台逛 B站 了，笔记会落 3.探索/bili/，日志见「概览」页', 'good')
          else say('没起来：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      if (!st || !cfg) {
        return h('div', { 'data-ab-page': '' },
          h('div', { 'data-ab-note': '' }, fails >= 3
            ? '读不到插件配置（已试 ' + fails + ' 次）。常见原因：刚装完没重启 dsh；或插件加载失败。'
            : '读设置中…'))
      }

      const sw = (k) => Boolean(cfg[k])
      const modelOk = Boolean(cfg.apiBaseUrl && cfg.apiKey && cfg.model)
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
        { id: 'sites', label: '网站源' },
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
        installing ? h(Progress, { label: 'B站 环境安装中（后台）', indeterminate: true }) : null,

        h('div', { 'data-ab-row': '' },
          h('button', { 'data-ab-btn': '', 'data-primary': '', disabled: busy === 'review' || reviewing, onClick: onReview }, '现在复盘'),
          h('button', { 'data-ab-btn': '', disabled: busy === 'browse' || browsing, onClick: onBrowse }, '现在逛'),
          h('button', { 'data-ab-btn': '', disabled: busy === 'log', onClick: onLog }, log ? '收起日志' : '看日志')),

        log ? h('pre', { 'data-ab-pre': '' }, log) : null,
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
        h(Field, { label: 'apiKey', note: '密钥，只存本机 config.json', value: draft?.apiKey, onChange: (v) => set('apiKey', v), placeholder: 'sk-...' }),
        h(Field, { label: 'model', note: '如 deepseek-chat', value: draft?.model, onChange: (v) => set('model', v), placeholder: 'deepseek-chat' }),

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
        h(Field, { label: '逛的时间', note: 'HH:mm，到点自动开始（每天一次），留空 = 只手动逛', value: draft?.browseTime, onChange: (v) => set('browseTime', v), placeholder: '21:00' }),
        h(Field, { label: '结束时间', note: 'HH:mm，到点强制收尾（没逛完也停）；留空 = 逛完自己停', value: draft?.browseEndTime, onChange: (v) => set('browseEndTime', v), placeholder: '21:30' }),
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
      )

      // ── 网站源页：B站 + 自定义 ──
      const sites = h('div', {},
        h('div', { 'data-ab-h': '' }, 'B站（内置网站源）'),
        h('div', { 'data-ab-row': '' },
          h('span', { 'data-ab-badge': '' }, biliVenvReady ? '环境已就绪' : '环境未装'),
          h('span', { 'data-ab-badge': '' }, biliLoggedIn ? '已登录' : '未登录'),
          installing ? h('span', { 'data-ab-badge': '', 'data-live': '' }, '● 装环境中') : null,
          h('div', { 'data-ab-grow': '' }),
          h('button', { 'data-ab-btn': '', disabled: busy === 'bilisetup' || installing, onClick: () => onBiliSetup(biliVenvReady) }, biliVenvReady ? '重装环境' : '装 B站 环境'),
          biliLoggedIn
            ? h('button', { 'data-ab-btn': '', 'data-primary': '', disabled: busy === 'bilibrowse', onClick: onBiliBrowse }, '逛 B站')
            : h('button', { 'data-ab-btn': '', 'data-primary': '', disabled: busy === 'bililogin', onClick: onBiliLogin }, '扫码登录')),
        biliQr
          ? h('div', { 'data-ab-row': '' },
              h('img', { src: '/api/ai-brain/site/qr?k=' + encodeURIComponent(biliQr), alt: '扫码登录二维码', style: { width: 160, height: 160, borderRadius: 8, background: '#fff' } }),
              h('div', { 'data-ab-grow': '' },
                h('div', { 'data-ab-note': '' }, '手机 B站 → 我的 → 扫一扫。扫完点「查扫码结果」。'),
                h('button', { 'data-ab-btn': '', disabled: busy === 'bilipoll', onClick: onBiliPoll }, '查扫码结果')))
          : null,
        h(ToggleRow, {
          label: '自动评论并 @',
          note: '开着时逛到值得的视频会发评论 @ 你（默认关，账号操作手动开）',
          on: sw('biliAutoComment'),
          onChange: (v) => { jpost('/config', { biliAutoComment: v }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
        }),
        h(Field, { label: '要 @ 谁', note: 'B站 昵称（自动评论时 @ 这个人）', value: draft?.biliMentionName, onChange: (v) => set('biliMentionName', v), placeholder: '昵称' }),
        h(ToggleRow, {
          label: '回复评论',
          note: '有人回复你那条评论时回一句（默认关）',
          on: sw('biliReplyToComments'),
          onChange: (v) => { jpost('/config', { biliReplyToComments: v }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
        }),

        h('div', { 'data-ab-h': '' }, '自定义网站源（MCP）'),
        h('div', { 'data-ab-note': '' }, '贴 JSON 数组，每个是一个 MCP 网站源。只允许 stdio / streamable-http，禁止 shell 拼接。'),
        h('textarea', {
          'data-ab-input': '', rows: 6, style: { fontFamily: 'monospace', resize: 'vertical' },
          value: draft?.customSites || '', placeholder: '[]',
          onChange: (e) => set('customSites', e.target.value),
        }),
        h('div', { 'data-ab-note': '' }, '示例：{"id":"mysite","name":"我的站","transport":"streamable-http","url":"http://127.0.0.1:9999/mcp"} 或 stdio 用 command+args。'),
        h('div', { 'data-ab-row': '' },
          h('button', { 'data-ab-btn': '', 'data-primary': '', disabled: busy === 'save', onClick: save }, '保存网站源')),
      )

      const body = tab === 'overview' ? overview
        : tab === 'memory' ? memory
        : tab === 'browse' ? browse
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
