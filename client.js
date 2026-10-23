/**
 * client.js —— 浏览器半端（设置在「设置」里的一页）
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
 * 这一页做四件事（用户 m01308 要的「更丰富的界面」）：
 *   ① 状态徽标（版本 / 库是否配置 / 模型是否配好 / 今天复盘没 / 逛没）
 *   ② 核心配置表单（vaultPath + 复盘三件套 + 复盘时间 + 逛互联网开关）
 *   ③ 「现在复盘」「现在逛」两个手动按钮
 *   ④ 日志查看（末尾 200 行）
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
[data-ab-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 8px;max-width:640px;}
[data-ab-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-ab-grow]{flex:1;min-width:0;}
[data-ab-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ab-label]{font-size:13px;}
[data-ab-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ab-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-ab-input]:focus{outline:none;border-color:#3b82f6;}
[data-ab-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-ab-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-ab-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-ab-btn][disabled]{opacity:.5;cursor:default;}
[data-ab-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ab-msg][data-warn]{color:#f59e0b;}
[data-ab-msg][data-good]{color:#22c55e;}
[data-ab-badge]{font-size:11px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-ab-pre]{margin:6px 0 0;padding:8px 9px;border-radius:8px;max-height:240px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
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

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [fails, setFails] = React.useState(0)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      const [log, setLog] = React.useState(null)   // null = 未展开
      // 输入框绑本地草稿，别直接绑 cfg（页面轮询会冲掉正在打的字）
      const [draft, setDraft] = React.useState(null)  // null = 还没从 cfg 初始化

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
          })
        }
      }, [cfg, draft])

      const say = (text, tone) => { setMsg(text); setMsgTone(tone || '') }
      const set = (k, v) => setDraft((d) => ({ ...(d || {}), [k]: v }))

      const save = async () => {
        setBusy('save')
        try {
          const p = {}
          for (const k of ['vaultPath', 'apiBaseUrl', 'apiKey', 'model', 'reviewTime', 'browseTime', 'browseEndTime']) {
            if (draft && k in draft) p[k] = draft[k]
          }
          const r = await jpost('/config', p)
          if (r && r.ok) { say('已保存', 'good'); setSt((old) => ({ ...old, config: r.config })) }
          else say('没保存成：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onReview = async () => {
        setBusy('review'); say('')
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
          if (r && r.ok) say('已经在后台逛了，日志见下方「日志」', 'good')
          else say('没起来：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onLog = async () => {
        if (log !== null) { setLog(null); return }
        setBusy('log')
        try {
          const r = await jget('/log')
          setLog(r && r.ok ? (r.text || '（日志是空的）') : '读不到日志')
        } catch (e) { setLog('读不到日志：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

      if (!st || !cfg) {
        return h('div', { 'data-ab-page': '' },
          h('div', { 'data-ab-note': '' }, fails >= 3
            ? '读不到插件配置（已试 ' + fails + ' 次）。常见原因：刚装完没重启 dsh；或插件加载失败。'
            : '读设置中…'))
      }

      const sw = (k) => Boolean(cfg[k])
      const modelOk = Boolean(cfg.apiBaseUrl && cfg.apiKey && cfg.model)

      return h('div', { 'data-ab-page': '' },

        /* ── 状态徽标 + 手动按钮 ── */
        h('div', { 'data-ab-row': '' },
          h('span', { 'data-ab-badge': '' }, 'v' + (st.version || '?')),
          h('span', { 'data-ab-badge': '' }, cfg.vaultPath ? '库已配置' : '库未配置'),
          h('span', { 'data-ab-badge': '' }, modelOk ? '模型已配' : '模型未配'),
          h('span', { 'data-ab-badge': '' }, st.reviewedToday ? '今天已复盘' : '今天未复盘'),
          h('span', { 'data-ab-badge': '' }, st.browsing ? '逛互联网进行中' : ''),
          h('div', { 'data-ab-grow': '' }),
          h('button', { 'data-ab-btn': '', 'data-primary': '', disabled: busy === 'review', onClick: onReview }, '现在复盘'),
          h('button', { 'data-ab-btn': '', disabled: busy === 'browse', onClick: onBrowse }, '现在逛'),
          h('button', { 'data-ab-btn': '', disabled: busy === 'log', onClick: onLog }, log !== null ? '收起日志' : '看日志')),

        msg ? h('div', { 'data-ab-msg': '', 'data-good': msgTone === 'good' ? '' : undefined, 'data-warn': msgTone === 'warn' ? '' : undefined }, msg) : null,

        /* ── 库 ── */
        h('div', { 'data-ab-h': '' }, '知识库'),
        h(Field, {
          label: '库路径（vaultPath）',
          note: '一个已存在的 Obsidian 库路径（就是 Markdown 文件夹），如 C:\\知识库\\My Brain',
          value: draft?.vaultPath, onChange: (v) => set('vaultPath', v),
          placeholder: 'C:\\知识库\\My Brain',
        }),

        /* ── 复盘 ── */
        h('div', { 'data-ab-h': '' }, '每日复盘'),
        h(ToggleRow, {
          label: '开启每日复盘',
          note: '到点自动读当天草稿 → 调模型归类写库（像睡前总结）',
          on: sw('reviewEnabled'),
          onChange: (v) => { /* 立即存，开关类走 persistCfg */ jpost('/config', { reviewEnabled: v }).then((r) => r && r.ok && setSt((old) => ({ ...old, config: r.config }))).catch(() => {}) },
        }),
        h(Field, {
          label: '复盘时间', note: '格式 HH:mm，到点自动跑（每天一次）',
          value: draft?.reviewTime, onChange: (v) => set('reviewTime', v),
          placeholder: '23:00',
        }),

        /* ── 模型 ── */
        h('div', { 'data-ab-h': '' }, '复盘模型（OpenAI 兼容接口）'),
        h(Field, { label: 'apiBaseUrl', note: '如 https://api.deepseek.com/v1', value: draft?.apiBaseUrl, onChange: (v) => set('apiBaseUrl', v), placeholder: 'https://api.deepseek.com/v1' }),
        h(Field, { label: 'apiKey', note: '密钥，只存本机 config.json', value: draft?.apiKey, onChange: (v) => set('apiKey', v), placeholder: 'sk-...' }),
        h(Field, { label: 'model', note: '如 deepseek-chat', value: draft?.model, onChange: (v) => set('model', v), placeholder: 'deepseek-chat' }),

        /* ── 逛互联网 ── */
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

        /* ── 保存 ── */
        h('div', { 'data-ab-row': '' },
          h('button', { 'data-ab-btn': '', 'data-primary': '', disabled: busy === 'save', onClick: save }, '保存'),
          h('div', { 'data-ab-note': '' }, '库路径 / 模型三件套 / 两个时间在改完后点「保存」生效；开关和偏好即时生效。')),

        /* ── 日志 ── */
        log !== null ? h('pre', { 'data-ab-pre': '' }, log) : null,
      )
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
