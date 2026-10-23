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
import { stamp } from './schedule.mjs'

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

// 找一个「有预编译 wheel、不需要 C 编译器」的 Python（3.10~3.12）。
// 系统 Python 3.15 太新，pyyaml / qrcode_terminal 没 wheel，会卡在源码编译。
// 按顺序探测：显式 pythonPath → py launcher 3.11/3.12/3.10 → 常见路径。
function findCompatPython(appendInstall) {
  const candidates = []
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    candidates.push(
      // AI-EMS-v2 项目里带的 3.11（本机实测存在）
      'C:\\AI-project\\codex-work\\AI-EMS-v2\\_runtime\\python\\python.exe',
      'C:\\AI-project\\AI-EMS-v2\\_runtime\\python\\python.exe',
      join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
      join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
      join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
      'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe', 'C:\\Python310\\python.exe',
    )
  } else {
    candidates.push('/usr/bin/python3.12', '/usr/bin/python3.11', '/usr/bin/python3.10')
  }
  for (const p of candidates) {
    if (p && existsSync(p)) { appendInstall(`找到兼容 Python：${p}\n`); return p }
  }
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
export function runInstall({ pluginDir, stateDir, pythonPath, log = () => {}, onReady = () => {}, onDone = () => {} }) {
  const installLogFile = join(stateDir, 'install.log')
  const appendInstall = (s) => { try { appendFileSync(installLogFile, s, 'utf8') } catch { /* 写不进去就算了 */ } }

  appendInstall(`\n=== ${stamp()} 开始装 B站 依赖 ===\n`)
  ;(async () => {
    try {
      const venvPy = venvPython(stateDir)
      // 优先用「有 wheel、不编译」的 Python（3.10~3.12）；拿不到再退回显式 pythonPath / 系统 python
      const compatPy = findCompatPython(appendInstall) || String(pythonPath || 'python')

      if (existsSync(venvPy)) {
        appendInstall('venv 已存在 —— 这次是「重装/补装依赖」：不会重建 venv，也不会删已装好的包。\n')
      }
      if (!existsSync(venvPy)) {
        // 用兼容 Python 建 venv（不用系统 3.15，避免 pyyaml 源码编译）
        const code = await spawnLogged(compatPy, ['-m', 'venv', join(stateDir, '.venv')], { stateDir, appendInstall })
        if (code !== 0) {
          // 退回：uv 建（uv 能拉 3.12 独立环境）
          const uvCmd = await resolveUv(stateDir, appendInstall)
          if (uvCmd) {
            let c2 = await spawnLogged(uvCmd, ['venv', '--seed', '--python', '3.12', join(stateDir, '.venv')], { stateDir, appendInstall })
            if (c2 !== 0) c2 = await spawnLogged(uvCmd, ['venv', '--seed', join(stateDir, '.venv')], { stateDir, appendInstall })
          }
        }
      }

      // 建完 venv 若还是不存在（或建出来是 3.15），放弃本轮，提示用户
      if (!existsSync(venvPy)) {
        appendInstall('建 venv 失败：没有可用的 Python。请装 Python 3.11（有预编译 wheel，不编译）。\n')
        log('装 B站 依赖失败：建 venv 没成功（缺兼容 Python 3.10~3.12）')
        return
      }

      const mirrors = ['https://pypi.tuna.tsinghua.edu.cn/simple', 'https://mirrors.ustc.edu.cn/pypi/simple', 'https://mirrors.aliyun.com/pypi/simple']

      // ══ 关键：绕开「pyyaml / qrcode_terminal 无 wheel 需 C 编译」这条死路 ══
      // 正确顺序（本机实测全绿）：
      //   ① 升级 pip（旧 pip 解析 3.11 wheel 有 bug）
      //   ② pyyaml —— 3.11 有 wheel，--only-binary 秒装
      //   ③ qrcode_terminal —— 纯 Python，--no-deps 装（它连锁拉 pyyaml 源码构建才是死因）
      //   ④ bilibili-api-python —— --no-deps 装主包（避开它对 qrcode_terminal 的硬依赖解析）
      //   ⑤ 其余运行时依赖 —— --only-binary :all:（全部有 wheel）
      let code = 1
      const pip = (args) => spawnLogged(venvPy, ['-m', 'pip', ...args], { stateDir, appendInstall })

      for (let i = 0; i < mirrors.length && code !== 0; i++) {
        const m = mirrors[i]
        if (i > 0) appendInstall(`\n--- 换个镜像再试：${m} ---\n`)
        // ⚠️ 必须带 `install` 子命令！少了它 pip 会把 --only-binary/-i 当成全局选项，报
        //    "no such option: -i"（exit 2），而且因为 venv 已存在，表面像是"装过了"。
        const mi = ['install', '--no-cache-dir', '-i', m]
        // ① 升级 pip
        await pip([...mi, '--upgrade', 'pip'])
        // ② pyyaml
        code = await pip([...mi, '--only-binary', ':all:', 'pyyaml'])
        if (code !== 0) continue
        // ③ qrcode_terminal（纯 python，no-deps）
        code = await pip([...mi, '--no-deps', 'qrcode_terminal'])
        if (code !== 0) continue
        // ④ bilibili-api-python 主包（no-deps）
        code = await pip([...mi, '--no-deps', 'bilibili-api-python>=17.4.1,<18'])
        if (code !== 0) continue
        // ⑤ 其余依赖（都有 wheel）
        code = await pip([...mi, '--only-binary', ':all:',
          'beautifulsoup4', 'colorama', 'lxml', 'brotli', 'qrcode[pil]', 'APScheduler', 'pillow',
          'yarl', 'pycryptodomex', 'PyJWT', 'aiohttp>=3.9.0', 'mcp>=1.0.0,<2'])
      }

      const miss = VENV_DEPS.filter((n) => !hasPkg(join(stateDir, '.venv'), n))
      appendInstall(`=== 结束（exit ${code}，venvReady=${venvReadyNow(stateDir)}${miss.length ? '，缺：' + miss.join(' / ') : ''}）===\n`)
      log(`装 B站 依赖结束：exit=${code} venvReady=${venvReadyNow(stateDir)}${miss.length ? ' 缺：' + miss.join(',') : ''}`)
      if (code === 0 && existsSync(venvPy)) onReady(venvPy)
      onDone(code)
    } catch (e) {
      appendInstall(`装依赖崩了：${e?.stack ?? e}\n`)
      log(`装依赖崩了：${e?.message ?? e}`)
      onDone(1)
    }
  })()

  return { ok: true, started: true, log: installLogFile }
}
