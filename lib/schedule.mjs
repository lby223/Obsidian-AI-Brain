// lib/schedule.mjs —— 「到点了吗」的判断
//
// 为什么单独抽出来：这个判断踩过两次坑，而且都只在真实运行里才暴露。
//   ⚠️ 别用「分钟字符串相等」（`hmNow() === '00:00'`）：
//      定时器是每 60 秒一跳，插件挂载时刻若落在目标分钟之外
//      （例：00:00:12 挂载 → 第一跳在 00:01:12），那一整天都不会触发。
//   ⚠️ 小时必须补零：`${d.getHours()}:...` 得到 '3:00'，和配置里的 '03:00' 永不相等。
//
// 改成「到点了 + 今天还没跑 + 没过宽限期」：宽限内补跑（启动晚了几分钟也能跑上），
// 超过宽限就不补（免得一开机就突然跑一轮）。

/** 到点后允许多久之内补跑（分钟） */
export const GRACE_MIN = 30

// ─────────────────────────────────────────────────────────────────────────────
// 「现在是几号几点」——一律用**本地时间**，不许再用 toISOString()。
//   ⚠️ `new Date().toISOString()` 是 UTC：本机 UTC+8，凌晨 03:00 复盘会写成前一天，
//      日志里 00:32 的逛网也会显示成 16:32（用户看到的就是这个）。
//   ⚠️ agent 读不到系统时间，所以「今天几号」必须由宿主显式告诉它，
//      否则它会自己猜——真实事故：逛网笔记全写成 2026-11-05/06/07（凭空多出十几天的未来日期）。

const p2 = (n) => String(n).padStart(2, '0')

/** 本地日期 YYYY-MM-DD */
export const dayKey = (now = new Date()) => `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`

/** 本地时刻 HH:mm（接受 epoch 毫秒或 Date） */
export const hmOf = (t = Date.now()) => {
  const d = t instanceof Date ? t : new Date(t)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** 日志时间戳：本地 YYYY-MM-DD HH:mm:ss */
export const stamp = (now = new Date()) =>
  `${dayKey(now)} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/** 给 agent 看的「现在」：2026-10-24 07:51（周六） */
export const humanNow = (now = new Date()) =>
  `${dayKey(now)} ${hmOf(now)}（周${WEEK[now.getDay()]}）`

/** 一天里的第几分钟（0–1439） */
export const nowMin = (now = new Date()) => now.getHours() * 60 + now.getMinutes()

/** 'HH:mm' → 一天里的第几分钟；格式不对返回 null */
export const hmMin = (hm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''))
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/**
 * 现在该不该跑？
 * @param {string} hm 目标时刻 'HH:mm'
 * @param {boolean} doneToday 今天已经跑过了吗
 * @param {{now?: Date, grace?: number}} [opts]
 */
export const due = (hm, doneToday, opts = {}) => {
  if (doneToday) return false
  const t = hmMin(hm)
  if (t == null) return false
  const n = nowMin(opts.now || new Date())
  const grace = opts.grace == null ? GRACE_MIN : opts.grace
  return n >= t && n <= t + grace
}
