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
