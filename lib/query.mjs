/**
 * lib/query.mjs —— 检索的「查询改写」（功能 B 的补强）
 * ============================================================================
 * 问题：brain_search 是子串匹配。我知道的措辞和笔记里的措辞对不上，就搜不到。
 *   例：笔记叫「定时任务到点判断-小时不补零与分钟字符串相等」，
 *       人问「为什么昨天那个自动任务没跑」——两串几乎不重叠。
 *
 * 做法（不花一次模型调用）：
 *   1. 切词：中文按二元组切（「自动任务」→ 自动/动任/任务），英文按整词
 *   2. 去噪：去掉疑问词/代词/虚词（为什么、昨天、那个、这个、怎么、吗……）
 *   3. 多轮：先整串搜，搜不到再逐词搜，再不行搜词库里的同义词扩展
 *   4. 打分：整串命中 > 标题命中 > 多个词同时命中 > 单词命中
 *
 * 关键取舍：宁可多召回几条让模型自己筛，也不要一条都不给。0 结果是这里最大的敌人。
 */

// 疑问词、时间代词、虚词 —— 它们在笔记里几乎不出现，留着只会稀释检索
const STOP = new Set([
  '为什么', '为什么我', '怎么', '怎样', '如何', '什么', '啥', '哪个', '哪些', '哪里',
  '是不是', '有没有', '能不能', '可不可以', '要不要', '会不会', '该不该',
  '我的', '你的', '他的', '我们', '你们', '他们', '我', '你', '他', '她', '它',
  '这个', '那个', '这些', '那些', '这里', '那里', '这样', '那样',
  '昨天', '今天', '明天', '前天', '后天', '刚才', '刚刚', '上次', '这次', '下次',
  '之前', '以后', '现在', '目前', '当时', '然后', '后来',
  '的', '了', '吗', '呢', '吧', '啊', '呀', '是', '在', '和', '与', '或', '就', '都', '也', '还', '又', '很', '太', '更', '最',
  '个', '一些', '一下', '一点', '有点', '还是', '但是', '因为', '所以', '如果', '虽然', '可以', '需要', '应该',
  '说', '讲', '问', '看', '想', '知道', '觉得', '觉得', '样子', '东西', '事情', '问题',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'why', 'how', 'what', 'do', 'does', 'did', 'i', 'my', 'you', 'it',
])

// 同义词扩展：中文里同一个东西有好几种叫法，这是搜不全的主因
const SYN = [
  ['报错', '错误', 'error', '失败', '异常', '崩溃', '挂了', '不行'],
  ['任务', '定时', 'cron', 'schedule', '自动', '定时器'],
  ['笔记', '文档', 'md', 'markdown', '文件'],
  ['知识库', 'vault', '库', '记忆库', 'brain'],
  ['插件', 'plugin', '扩展', '组件'],
  ['安装', '部署', '装', 'install', 'setup'],
  ['配置', '设置', 'config', 'setting', '参数'],
  ['端口', 'port', '接口', 'api'],
  ['路径', 'path', '目录', '文件夹', '位置'],
  ['版本', 'version', '号'],
  ['启动', '开始', '运行', '跑', 'start', 'run'],
  ['停止', '结束', '停', 'kill', 'stop'],
  ['登录', '扫码', '鉴权', 'auth', 'token', '凭证'],
  ['浏览器', 'browser', '网页', '页面'],
  ['编码', '乱码', 'utf8', 'utf-8', 'gbk', 'charset'],
  ['时间', '日期', '时区', 'utc', 'tz', '时间戳'],
  ['模型', 'model', 'llm', '大模型'],
  ['搜索', '查找', '检索', 'search', 'query', '查'],
  ['删除', '清掉', '删', 'remove', 'delete'],
  ['git', 'github', '提交', 'commit', 'push', '推送'],
  ['python', 'py', 'pip'],
  ['node', 'nodejs', 'npm', 'pnpm'],
]

const SYN_MAP = (() => {
  const m = new Map()
  for (const group of SYN) for (const w of group) {
    if (!m.has(w)) m.set(w, new Set())
    for (const o of group) if (o !== w) m.get(w).add(o)
  }
  return m
})()

const CJK = /[\u4e00-\u9fff]/
const splitCjk = (s) => {
  // 中文按二元组切（单字太泛、整句太长，两字词最平衡）
  const out = []
  for (let i = 0; i < s.length; i++) {
    if (i + 1 < s.length) out.push(s.slice(i, i + 2))
  }
  return out
}

/** 把一句人话切成检索词（去噪、去重、保留原始整串在第一位） */
export function terms(input) {
  const raw = String(input || '').trim()
  if (!raw) return []
  const seen = new Set()
  const push = (arr, t) => {
    const s = String(t || '').trim()
    if (!s || s.length < 2) return
    if (STOP.has(s)) return
    if (seen.has(s)) return
    seen.add(s)
    arr.push(s)
  }
  const out = []
  push(out, raw.toLowerCase())

  // 英文整词 + 代码/路径片段
  const words = raw.toLowerCase().match(/[a-z0-9_.\-#/]{2,}/g) || []
  for (const w of words) push(out, w)

  // 中文串：整串 + 二元组
  const cjkRuns = raw.match(/[\u4e00-\u9fff]{2,}/g) || []
  for (const run of cjkRuns) {
    push(out, run)
    for (const t of splitCjk(run)) push(out, t)
  }
  return out
}

/** 同义词扩展（只对已有的词扩展，不凭空造） */
export function expand(list) {
  const out = []
  const seen = new Set()
  const push = (t) => {
    const s = String(t || '').trim()
    if (!s || s.length < 2 || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }
  for (const t of list) {
    push(t)
    const ex = SYN_MAP.get(t)
    if (ex) for (const e of ex) push(e)
  }
  return out
}

/**
 * 多轮检索。
 * @param {(q: string) => Array} search  底层检索函数（一次一个字符串）
 * @param {string} query                 用户/模型给的查询
 * @param {object} opts                  { limit, maxRounds }
 * @returns {{ results: Array, usedQueries: string[], widened: boolean }}
 *
 * 返回的 results 每项额外带 `score`，按分数降序。同一条命中出现在多轮里只留一次。
 */
export function searchWide(search, query, opts = {}) {
  const limit = Number(opts.limit) || 40
  const seen = new Map()          // path:line -> result
  const usedQueries = []
  let widened = false

  const round = (qs, weight) => {
    for (const q of qs) {
      let hits = []
      try { hits = search(q) || [] } catch { hits = [] }
      if (!hits.length) continue
      usedQueries.push(q)
      // 命中权重按「这个词本身有多具体」缩放：二元组只会到处撞，不能和整串同权重
      const w = weight * (q.length <= 2 ? 0.25 : q.length <= 3 ? 0.5 : 1)
      for (const h of hits) {
        const key = `${h.path}:${h.line}`
        const prev = seen.get(key)
        const add = w + (String(h.path).toLowerCase().includes(q) ? 2 : 0)
        if (prev) prev.score += add
        else seen.set(key, { ...h, score: add })
      }
      if (usedQueries.length >= 12) return true
    }
    return false
  }

  const t = terms(query)
  // 第 1 轮：整串（最高权重）
  round(t.slice(0, 1), 10)
  // 第 2 轮：逐词（中文二元组会带来很多命中，正是我们要的）
  round(t.slice(1, 25), 1)

  // 第 3 轮：结果太少才扩展同义词（扩展会带噪音，不轻易用）
  let best = 0
  for (const r of seen.values()) best = Math.max(best, r.score)
  if (seen.size < 3 || best < 3) {
    widened = true
    round(expand(t.slice(0, 12)).slice(0, 40), 0.5)
  }

  const results = [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return { results, usedQueries, widened }
}

/**
 * 缩成「一篇一行」——同一个文件撞 5 行时，模型看 5 行是浪费。
 * @returns {Array<{path, score, lines: Array<{line, text}>}>} 按分数降序
 */
export function collapse(results, perNote = 3) {
  const byPath = new Map()
  for (const r of results || []) {
    const k = String(r.path || '')
    if (!byPath.has(k)) byPath.set(k, { path: k, score: 0, lines: [], why: r.why || '' })
    const it = byPath.get(k)
    it.score += Number(r.score) || 0
    if (it.lines.length < perNote) it.lines.push({ line: r.line, text: r.text })
    if (!it.why && r.why) it.why = r.why
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score)
}
