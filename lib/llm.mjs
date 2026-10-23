/**
 * lib/llm.mjs —— OpenAI 兼容客户端（功能 C 用：插件自己调模型做复盘）
 * ============================================================================
 * 只做一件事：发一次 chat.completions 请求，拿回文本。不缓存、不重试（调用方兜）。
 * ============================================================================
 */

/** 调一次 OpenAI 兼容的 chat.completions，返回 { ok, text } 或 { ok:false, error } */
export async function chat(baseUrl, apiKey, model, messages, { temperature = 0.3, maxTokens = 4000, timeoutMs = 120000 } = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  const key = String(apiKey || '').trim()
  const mdl = String(model || '').trim()
  if (!base || !key || !mdl) return { ok: false, error: '缺少 baseUrl / apiKey / model 之一' }

  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: mdl,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 300)}` }
    }
    const j = await res.json()
    const text = j?.choices?.[0]?.message?.content
    if (typeof text !== 'string') return { ok: false, error: '响应里没有 choices[0].message.content' }
    return { ok: true, text, usage: j?.usage || null }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
