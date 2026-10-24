/**
 * lib/guard.mjs —— 加固用的小工具（漏洞检查后加的）
 * ============================================================================
 * 这一层只做三件事，都很小但很重要：
 *   1. mask()        —— 把 apiKey 之类的东西从「要回给前端 / 要写进日志」的对象里抹掉
 *   2. sameOrigin()  —— 判断请求是不是从 DSH 自己的页面发来的（挡掉本机其它网页的 CSRF）
 *   3. safeYaml()    —— 把用户填的字符串安全地塞进 YAML（防注入额外键）
 * ============================================================================
 */

/** 这些键的值一律不往外输出（日志 / HTTP 响应） */
const SECRET_KEYS = new Set(['apiKey', 'apiKeyEnv', 'token', 'authToken', 'password', 'secret'])

/** 抹掉敏感键。只处理一层（我们的配置是扁平的）。 */
export function mask(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = Array.isArray(obj) ? [] : {}
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.has(k) && typeof v === 'string' && v) out[k] = `已设置（${v.length} 位，不回显）`
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = mask(v)
    else out[k] = v
  }
  return out
}

/**
 * 请求是不是「可信来源」？
 * 浏览器跨站请求一定会带 Origin（或 Sec-Fetch-Site），本机其它网页都会带自己的 Origin。
 * 规则：没有 Origin 头（curl / 本机进程 / 同源 GET 拿不到的情况）**放行**，
 *       有 Origin 就必须是本机回环地址；Sec-Fetch-Site 是 cross-site 直接拒。
 * 这样挡掉「你开着某个网页，它偷偷 fetch 127.0.0.1:<端口>/api/ai-brain/...」，
 * 又不影响命令行和其它本机程序。
 */
export function sameOrigin(req) {
  try {
    const site = String(req?.headers?.['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site') return false
    const origin = String(req?.headers?.origin || '').trim()
    if (!origin) return true   // 非浏览器发起（curl / 本机进程）：放行
    let host = ''
    try { host = new URL(origin).hostname } catch { return false }
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch { return false }
}

/**
 * 把一个字符串安全地写成 YAML 的「单行标量」。
 * 为什么要它：原来是把 site.command / args / env / headers 直接拼进 YAML 行，
 * 值里带换行就能注入出新的键（比如 args 元素里塞 "\n        command: evil.exe"）。
 * 做法：一律用 JSON 风格的双引号包裹（YAML 双引号标量就是 JSON 字符串语法），
 *      所有控制字符、引号、反斜杠都转义掉 —— 值永远只占一行、不会逸出。
 */
export function safeYaml(v) {
  return JSON.stringify(String(v == null ? '' : v))
}

/** 想写成 YAML 的键名也要安全（键名同样可以塞引号/冒号搞事） */
export function safeYamlKey(k) {
  return JSON.stringify(String(k == null ? '' : k))
}

/** 允许透传给子进程的环境变量 —— 其它一律丢，尤其是能执行代码的那几个 */
const ENV_DENY = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE',
  'PYTHONSTARTUP', 'PYTHONPATH', 'PYTHONHOME',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'COMSPEC', 'SHELL', 'BASH_ENV', 'ENV', 'PROMPT_COMMAND',
  'ELECTRON_RUN_AS_NODE',
])

/** 从「用户填的 env」里滤掉危险键（PATH/PATHEXT 这类也挡：改 PATH 就等于换掉要执行的程序） */
export function filterUserEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {}
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    const key = String(k).trim()
    if (!key) continue
    if (ENV_DENY.has(key.toUpperCase())) continue
    if (key.toUpperCase() === 'PATH' || key.toUpperCase() === 'PATHEXT') continue
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue
    out[key] = String(v)
  }
  return out
}
