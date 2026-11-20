// Provider-neutral probe. No credential access, retry loop, conversation, or tools.
export const PROBE_TIMEOUT_MS = 50_000
export const MAX_OUTPUT_TOKENS = 256

export function cleanText(value, limit = 160) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}/g, '[已隐藏]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/(["']?(?:api[_-]?key|authorization|access[_-]?token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[已隐藏]@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1[参数已隐藏]')
    .slice(0, limit)
}

// Error messages/bodies are intentionally never rendered. Only validated facts
// and known engine codes can influence user-facing diagnostics.
function own(value, key) {
  try {
    const d = value && Object.getOwnPropertyDescriptor(value, key)
    return d && 'value' in d ? d.value : undefined
  } catch { return undefined }
}
export function classifyFailure(error) {
  let value = error
  let code, status, statusSource
  const messages = []
  for (let i = 0; value && i < 4; i++) {
    const failure = own(value, 'failure')
    for (const fact of [value, failure]) {
      const c = own(fact, 'code'), s = own(fact, 'status'), m = own(fact, 'message')
      if (typeof c === 'string' && c !== 'UNKNOWN') code ??= c
      if (Number.isInteger(s) && s >= 100 && s <= 599 && status === undefined) { status = s; statusSource = 'adapter' }
      // Examine locally for fixed diagnostic patterns only. Never return/log
      // raw exception messages, bodies, keys, URLs, or arbitrary error codes.
      if (typeof m === 'string') messages.push(m.slice(0, 8192))
    }
    value = own(value, 'cause')
  }
  // pi-ai's in-band error contract often preserves HTTP status only in text.
  // Infer only from explicit HTTP/status markers or an SDK-leading 4xx/5xx.
  if (status === undefined) {
    for (const text of messages) {
      const match = /\b(?:HTTP(?:\/[\d.]+)?(?:\s+(?:error|status(?:\s+code)?))?|status(?:\s+code)?)\s*[:=]?\s*([45]\d\d)\b/i.exec(text)
        ?? /^(?:error:\s*)?([45]\d\d)(?:\s|:|$)/i.exec(text)
      if (match) { status = Number(match[1]); statusSource = 'message'; break }
    }
  }
  let message = '请求未通过；目前没有足够的错误信息确定原因，不能据此断定模型下线。'
  let halt = false
  if (status === 403) {
    message = '服务拒绝访问，请检查渠道或模型权限。'; halt = true
  } else if (status === 401 || code === 'INVALID_CREDENTIAL' || code === 'MISSING_CREDENTIAL' || code === 'AUTH') {
    message = '鉴权或访问权限检查失败，请检查渠道设置。'; halt = true
  } else if (status === 429 || code === 'RATE_LIMIT') {
    message = '服务限流，已停止批量检测；请稍后手动重试。'; halt = true
  } else if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') {
    message = '账户余额或配额不足，已停止批量检测。'; halt = true
  } else if (code === 'NO_ADAPTER') message = '渠道已移除或未启用，请刷新渠道列表。'
  else if (status === 404 || code === 'UNKNOWN_MODEL') message = '接口或模型不存在，请检查渠道地址和模型 ID。'
  else if (code === 'EMPTY_RESPONSE') message = '服务没有返回任何内容。'
  else if (code === 'UNSUPPORTED_REASONING_EFFORT') message = '渠道配置的思考档位与模型不兼容。'
  else if (code === 'INVALID_CONFIG') message = '渠道或模型配置无效，尚不能完成检测。'
  else if (code === 'REQUEST_HEADERS') message = '请求头准备失败，请检查渠道附加请求头或贡献请求头的插件。'
  else if (code === 'INVALID_REQUEST' || status === 400 || status === 422) message = '服务拒绝请求格式或参数；请核对渠道协议、模型及输出／思考预算。'
  else if (code === 'UNSUPPORTED_OPTION' || code === 'UNSUPPORTED_CONTENT') message = '请求选项或内容与当前适配器不兼容。'
  else if (code === 'TIMEOUT' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') message = '适配器或上游请求超时；不是插件自身 50 秒上限触发。'
  else if (code === 'STREAM_CLOSED' || code === 'MALFORMED_RESPONSE') message = '响应流提前结束或格式无法解析，未验证完整成功。'
  else if (['TRANSPORT', 'NETWORK', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) message = '网络或传输层失败，尚不能判断模型是否可用。'
  else if (status >= 500 || code === 'SERVER') message = '中转站或上游服务异常。'
  else if (code === 'PI_AI_ERROR') message = '三方适配器返回未归类错误；需要进一步核对请求和响应兼容性。'
  else if (code === 'CONTEXT_WINDOW_EXCEEDED') message = '服务报告上下文超限，请检查模型或渠道的上下文配置。'

  // Only whitelisted, generated hints leave this function; never an excerpt
  // from the raw exception, even when a response includes a secret or HTML.
  const text = messages.join('\n')
  let hint
  if (/\b(?:CERT_HAS_EXPIRED|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b|certificate (?:has expired|verify failed)/i.test(text)) hint = '检测到 TLS 证书校验错误。'
  else if (/\b(?:ENOTFOUND|EAI_AGAIN)\b|getaddrinfo\s/i.test(text)) hint = '检测到 DNS 域名解析错误。'
  else if (/\bECONNREFUSED\b|connection refused/i.test(text)) hint = '连接被拒绝，请检查地址、端口和代理。'
  else if (/\bECONNRESET\b|socket hang up|other side closed|premature close/i.test(text)) hint = '连接在收到完整响应前被关闭。'
  else if (/\b(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)\b|\b(?:timed out|timeout)\b/i.test(text)) hint = '底层连接或等待响应超时。'
  else if (/\bfetch failed\b/i.test(text)) hint = '底层网络请求失败，未确认收到 HTTP 响应。'
  else if (/stream ended (?:before|without)|unexpected end of (?:json|stream)|unexpected token.*(?:json|html)|not valid json/i.test(text)) hint = '响应流不完整，或返回内容不是预期的 JSON／流式协议。'
  else if (/\b(?:invalid|unsupported|must|minimum|at least|greater|less|between)\b|not support/i.test(text)) {
    const parameter = /\b(max_tokens|max_completion_tokens|max_output_tokens|budget_tokens|reasoning_effort|thinking)\b/i.exec(text)?.[1]?.toLowerCase()
    if (parameter) hint = `服务报告参数 ${parameter} 不兼容；插件未自动更改预算或重试。`
  }
  const allowedCodes = new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA', 'NO_ADAPTER', 'EMPTY_RESPONSE', 'UNSUPPORTED_REASONING_EFFORT', 'NETWORK', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'TRANSPORT', 'TIMEOUT', 'SERVER', 'INVALID_REQUEST', 'INVALID_CONFIG', 'UNKNOWN_MODEL', 'UNSUPPORTED_OPTION', 'UNSUPPORTED_CONTENT', 'REQUEST_HEADERS', 'STREAM_CLOSED', 'MALFORMED_RESPONSE', 'PI_AI_ERROR', 'CONTEXT_WINDOW_EXCEEDED'])
  return { message, halt, ...(hint ? { hint } : {}), ...(status ? { httpStatus: status, httpStatusSource: statusSource } : {}), ...(allowedCodes.has(code) ? { code } : {}) }
}

const abortReason = kind => Object.assign(new Error(kind), { probeAbort: kind })

/** One dispatch, bounded result delivery, and a separate cleanup lease.
 * If an adapter ignores abort, `cleanup` stays pending. The queue must retain
 * its global lock and must NOT dispatch another request until it settles.
 */
export async function probe(llm, route, { signal, timeoutMs = PROBE_TIMEOUT_MS, graceMs = 500 } = {}) {
  const start = performance.now()
  const controller = new AbortController()
  const abort = () => controller.abort(abortReason('cancelled'))
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(abortReason('timeout')), timeoutMs)
  let settled = false, text = '', firstTextMs, terminal, reasoning = false
  let phase = 'prepare', dispatchStarted = false
  const blocks = new Map()
  let characters = 0
  const elapsed = () => Math.max(0, Math.round(performance.now() - start))
  const readText = () => [...blocks.values()].filter(b => b.type === 'text').map(b => b.text).join('').slice(0, 1600)
  let chunkCount = 0
  const limitExceeded = () => {
    const error = abortReason('response-limit')
    // Abort before AsyncIteratorClose: an adapter's return() may wait for it.
    controller.abort(error)
    throw error
  }
  const capture = chunk => {
    if (++chunkCount > 20_000) limitExceeded()
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') characters += typeof chunk.text === 'string' ? chunk.text.length : 0
    if (chunk.type === 'block-end') characters += typeof chunk.block?.text === 'string' ? chunk.block.text.length : 0
    if (characters > 65_536) limitExceeded()
    if (chunk.type === 'finish') { terminal = chunk.reason; return }
    if (chunk.type === 'reasoning-delta' || (chunk.type === 'block-end' && chunk.block?.type === 'reasoning')) reasoning = true
    if (chunk.type !== 'text-delta' && chunk.type !== 'block-end') return
    const final = chunk.type === 'block-end'
    const type = final ? chunk.block?.type : 'text'
    if (type !== 'text') return
    if (!blocks.has(chunk.index) && blocks.size >= 32) limitExceeded()
    const old = blocks.get(chunk.index)
    if (old?.closed) return
    const fragment = final ? chunk.block.text : chunk.text
    if (typeof fragment !== 'string') return
    blocks.set(chunk.index, { type, text: (final ? fragment : (old?.text ?? '') + fragment).slice(0, 1600), closed: final })
    text = readText()
    if (firstTextMs === undefined && text.trim()) firstTextMs = elapsed()
  }
  // Start in a microtask so even synchronous service failures are owned.
  const work = Promise.resolve().then(async () => {
    controller.signal.throwIfAborted()
    const prepared = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: MAX_OUTPUT_TOKENS }, controller.signal,
      (controls, info) => ({ ...controls, ...(info.reasoning?.efforts?.some(e => e.id === 'off') ? { reasoningEffort: 'off' } : {}) }))
    controller.signal.throwIfAborted()
    const options = {
      ...prepared.config,
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回复 OK' }] }],
      signal: controller.signal,
    }
    phase = 'stream'
    dispatchStarted = true
    for await (const chunk of prepared.stream(options)) {
      controller.signal.throwIfAborted()
      capture(chunk)
    }
    controller.signal.throwIfAborted()
    if (terminal?.kind === 'error') {
      const failure = classifyFailure(terminal.failure)
      return { status: failure.code === 'TIMEOUT' ? 'timeout' : 'failed', ...failure }
    }
    if (terminal?.kind === 'aborted') return { status: 'cancelled', message: '适配器中止请求，未验证成功。', halt: false }
    if (!terminal) return { status: 'incomplete', message: '响应缺少结束事件，未验证完整成功。', halt: false }
    if (terminal.kind === 'max-tokens') return { status: text.trim() ? 'truncated' : 'empty', message: text.trim() ? '已响应，但达到输出预算；不能视为完整成功。' : reasoning ? '思考耗尽输出预算，没有可见文本；不能据此断定渠道不可用。' : '输出预算已耗尽，没有可见文本。', halt: false }
    if (terminal.kind !== 'stop') return { status: 'incomplete', message: '响应不是正常文本结束，未验证成功。', halt: false }
    if (!text.trim()) return { status: 'empty', message: reasoning ? '仅返回思考内容，没有可见文本。' : '服务正常结束，但没有可见文本。', halt: false }
    return { status: 'success', message: '本次文本请求正常完成。', halt: false }
  }).catch(error => {
    if (controller.signal.aborted) throw controller.signal.reason
    if (own(error, 'probeAbort') === 'response-limit') {
      controller.abort(error)
      return { status: 'incomplete', message: '响应超出本地安全预算，已停止读取。', halt: false }
    }
    const failure = classifyFailure(error)
    return { status: failure.code === 'TIMEOUT' ? 'timeout' : 'failed', ...failure }
  })
  const cleanup = work.then(() => { settled = true }, () => { settled = true })
  let listener
  const interrupted = new Promise((_, reject) => {
    listener = () => reject(controller.signal.reason)
    if (controller.signal.aborted) listener()
    else controller.signal.addEventListener('abort', listener, { once: true })
  })
  let result, lingering = false
  try {
    result = await Promise.race([work, interrupted])
  } catch (error) {
    const reason = own(error, 'probeAbort')
    result = { status: reason === 'timeout' ? 'timeout' : reason === 'response-limit' ? 'incomplete' : 'cancelled', message: reason === 'timeout' ? `超过 ${Math.round(timeoutMs / 1000)} 秒未完成。` : reason === 'response-limit' ? '响应超出本地安全预算。' : '已请求取消，服务端仍可能计费。', halt: false }
    let grace
    await Promise.race([cleanup, new Promise(resolve => { grace = setTimeout(resolve, graceMs) })])
    clearTimeout(grace)
    lingering = !settled
    if (lingering) result.message += ' 适配器尚未确认退出，结果未知；队列已暂停。'
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', listener)
  }
  return { result: { ...result, phase, dispatchStarted, elapsedMs: elapsed(), ...(firstTextMs === undefined ? {} : { firstTextMs }), output: cleanText(text, 800) }, lingering, cleanup }
}
