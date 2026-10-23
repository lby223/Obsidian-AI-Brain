/**
 * lib/bili.mjs —— B站 源的 glue（venv 装依赖 / 铺脚本 / 起 MCP）
 * ============================================================================
 * 把 bili-scroll 里「venv 建环境 + 铺 mcp_server.py + 起 stdio MCP」这一套抽出来，
 * 只保留我们需要的部分（不搞 ASR 转写、不搞自动收藏），并简化成同步/非阻塞的骨架。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, copyFileSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpClient } from './mcp.mjs'

export const VENV_DEPS = ['bilibili_api', 'mcp', 'qrcode']

const venvPython = (stateDir) => process.platform === 'win32'
  ? join(stateDir, '.venv', 'Scripts', 'python.exe')
  : join(stateDir, '.venv', 'bin', 'python')

function sitePkgs(venvRoot) {
  const win = join(venvRoot, 'Lib', 'site-packages')
  if (existsSync(win)) return win
  try {
    const lib = join(venvRoot, 'lib')
    for (const d of readdirSync(lib)) {
      if (!d.startsWith('python')) continue
      const p = join(lib, d, 'site-packages')
      if (existsSync(p)) return p
    }
  } catch { /* 没有就算了 */ }
  return win
}

function hasPkg(venvRoot, prefix) {
  try { return readdirSync(sitePkgs(venvRoot)).some((n) => n.startsWith(prefix)) } catch { return false }
}

export function venvReadyNow(stateDir) {
  const py = venvPython(stateDir)
  if (!existsSync(py)) return false
  return VENV_DEPS.every((n) => hasPkg(join(stateDir, '.venv'), n))
}

/** 把 vendored 的 mcp_server.py 铺进家目录（内容同才跳过） */
export function ensureHomeFiles(pluginDir, stateDir, log = () => {}) {
  const from = join(pluginDir, 'vendor', 'bilibili-mcp', 'mcp_server.py')
  const to = join(stateDir, 'mcp_server.py')
  try {
    if (!existsSync(from)) { log(`缺文件：${from}`); return }
    if (existsSync(to) && readFileSync(from, 'utf8') === readFileSync(to, 'utf8')) return
    copyFileSync(from, to)
    log(`已铺好：${to}`)
  } catch (e) { log(`铺 mcp_server.py 失败：${e?.message ?? e}`) }
}

/** 起一个 B站 MCP 客户端（stdio），凭证落家目录。venv 没装好会抛错。 */
export function spawnBiliMcp({ pythonPath, stateDir, env = {}, log = () => {} }) {
  const script = join(stateDir, 'mcp_server.py')
  if (!existsSync(script)) throw new Error(`家里没有 mcp_server.py（应有 ${script}）—— 先装依赖 / 重启一次`)
  return new McpClient({
    command: pythonPath || 'python',
    args: [script],
    cwd: stateDir,
    env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'UTF-8' },
    log,
  })
}

/* ─────────── venv 安装（非阻塞：起完就返回） ─────────── */

export function uvEnv(stateDir, extra = {}) {
  return {
    ...process.env,
    UV_CACHE_DIR: join(stateDir, 'uv-cache'),
    UV_TOOL_DIR: join(stateDir, 'uv-tools'),
    UV_PYTHON_INSTALL_DIR: join(stateDir, 'uv-python'),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'UTF-8',
    ...extra,
  }
}

const probe = (cmd) => new Promise((resolve) => {
  try {
    const c = spawn(cmd, ['--version'], { windowsHide: true, stdio: 'ignore' })
    c.on('exit', (code) => resolve(code === 0))
    c.on('error', () => resolve(false))
  } catch { resolve(false) }
})

async function resolveUv(stateDir, appendInstall) {
  const bundled = join(stateDir, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
  if (await probe('uv')) return 'uv'
  if (existsSync(bundled)) return bundled
  appendInstall('这台机器上没有 uv —— 请手动装 uv（https://docs.astral.sh/uv/），或装 Python 3.10+ 后回来重试。\n')
  return ''
}

function spawnLogged(cmd, args, { stateDir, appendInstall, env }) {
  return new Promise((resolve) => {
    appendInstall(`\n$ ${cmd} ${args.join(' ')}\n`)
    let c
    try { c = spawn(cmd, args, { cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: uvEnv(stateDir, env || {}) }) }
    catch (e) { appendInstall(`起不来：${e?.message ?? e}\n`); return resolve(1) }
    const w = (b) => appendInstall(String(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    c.on('exit', (code) => { appendInstall(`\n--- exit ${code} ---\n`); resolve(code) })
    c.on('error', (e) => { appendInstall(`起不来：${e?.message ?? e}\n`); resolve(1) })
  })
}

/**
 * 建 venv + 装依赖（非阻塞，起完就返回，进度写 install.log）。
 * 装完自动把 pythonPath 写回 config.json（由调用方传 onReady 回调）。
 */
export function runInstall({ pluginDir, stateDir, pythonPath, log = () => {}, onReady = () => {} }) {
  const installLogFile = join(stateDir, 'install.log')
  const appendInstall = (s) => { try { appendFileSync(installLogFile, s, 'utf8') } catch { /* 写不进去就算了 */ } }

  appendInstall(`\n=== ${new Date().toISOString()} 开始装 B站 依赖 ===\n`)
  ;(async () => {
    try {
      const reqFile = join(pluginDir, 'vendor', 'bilibili-mcp', 'requirements.txt')
      const venvPy = venvPython(stateDir)
      const py = String(pythonPath || 'python')
      const uvCmd = await resolveUv(stateDir, appendInstall)

      if (!existsSync(venvPy)) {
        const spec = '3.12'
        if (uvCmd) {
          let code = await spawnLogged(uvCmd, ['venv', '--seed', '--python', spec, join(stateDir, '.venv')], { stateDir, appendInstall })
          if (code !== 0) code = await spawnLogged(uvCmd, ['venv', '--seed', join(stateDir, '.venv')], { stateDir, appendInstall })
          if (code !== 0) log('建 venv 没成功（两条路都试过）')
        }
        if (!existsSync(venvPy) && !uvCmd) await spawnLogged(py, ['-m', 'venv', join(stateDir, '.venv')], { stateDir, appendInstall })
      }

      const mirrors = ['https://pypi.tuna.tsinghua.edu.cn/simple', 'https://mirrors.ustc.edu.cn/pypi/simple', 'https://mirrors.aliyun.com/pypi/simple']
      let code = 1
      for (let i = 0; i < mirrors.length && code !== 0; i++) {
        const m = mirrors[i]
        if (i > 0) appendInstall(`\n--- 换个镜像再试：${m} ---\n`)
        if (uvCmd) code = await spawnLogged(uvCmd, ['pip', 'install', '--python', venvPy, '-i', m, '-r', reqFile], { stateDir, appendInstall })
        if (code !== 0 && existsSync(venvPy)) code = await spawnLogged(venvPy, ['-m', 'pip', 'install', '-i', m, '-r', reqFile], { stateDir, appendInstall })
      }

      const miss = VENV_DEPS.filter((n) => !hasPkg(join(stateDir, '.venv'), n))
      appendInstall(`=== 结束（exit ${code}，venvReady=${venvReadyNow(stateDir)}${miss.length ? '，缺：' + miss.join(' / ') : ''}）===\n`)
      log(`装 B站 依赖结束：exit=${code} venvReady=${venvReadyNow(stateDir)}${miss.length ? ' 缺：' + miss.join(',') : ''}`)
      if (code === 0 && existsSync(venvPy)) onReady(venvPy)
    } catch (e) {
      appendInstall(`装依赖崩了：${e?.stack ?? e}\n`)
      log(`装依赖崩了：${e?.message ?? e}`)
    }
  })()

  return { ok: true, started: true, log: installLogFile }
}
