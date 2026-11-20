import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestHost } from '/root/.dsh/skills/dsh-go-plugin/kit/lib/testing.js'
import { checkView } from '/root/.dsh/skills/dsh-go-plugin/kit/lib/view-check.js'
import { checkerView, createChecker, formatBeijingTime, resultDetails } from '../lib/index.js'
import { probe, classifyFailure, cleanText } from '../lib/probe.js'

const DIR = new URL('..', import.meta.url).pathname
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(check, message = 'condition') {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)) }
  assert.fail(`Timed out: ${message}`)
}
const ok = () => [{ type: 'text-delta', index: 0, text: 'OK' }, { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }, { type: 'finish', reason: { kind: 'stop' } }]
function service({ count = 3, behavior, providers = [{ id: 'relay', name: '测试渠道' }] } = {}) {
  const calls = [], configs = []
  let concurrent = 0, peak = 0
  const llm = {
    listProviders: () => providers,
    listModels: async () => Array.from({ length: count }, (_, i) => ({ id: `m${i}`, name: `模型 ${i}` })),
    prepareCall: async (config, signal, configure) => {
      signal.throwIfAborted()
      const selected = configure(config, { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } })
      configs.push(selected)
      return { config: selected, stream: async function* (options) {
        calls.push(options)
        concurrent++; peak = Math.max(peak, concurrent)
        try {
          if (behavior) yield* behavior(options)
          else for (const chunk of ok()) yield chunk
        } finally { concurrent-- }
      } }
    },
  }
  return { llm, calls, configs, get peak() { return peak } }
}
function setup(fake = service(), timing = {}) {
  const host = createTestHost({ dir: DIR, services: { llm: fake.llm } })
  host.ctx.inject(['dshGo'], ctx => createChecker(ctx, timing))
  const feed = host.subscribe('checker', { sessionId: 's1' })
  const call = (action, value) => host.invoke('checker', { scope: { sessionId: 's1' }, action, value })
  async function choose(index = 0) {
    const value = feed.data.providerOptions[index].value
    const reply = await call('pick-provider', { value })
    assert.ok(reply.pending)
    await reply.settled
  }
  async function start() { await call('prepare-run'); assert.equal(feed.data.confirmation.length, 2); await call(feed.data.confirmation[1].id, { confirmed: true }) }
  return { host, feed, call, choose, start, fake }
}

test('single probe reuses config, sends no history or tools, assembles blocks without duplication', async () => {
  const fake = service()
  const outcome = await probe(fake.llm, { provider: 'relay', model: 'm0' })
  assert.equal(outcome.result.status, 'success')
  assert.equal(outcome.result.output, 'OK')
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].messages.length, 1)
  assert.equal(fake.calls[0].messages[0].content[0].text, '只回复 OK')
  assert.equal(fake.calls[0].tools, undefined)
  assert.equal(fake.calls[0].maxTokens, 256)
  assert.equal(fake.calls[0].reasoningEffort, 'off')
  assert.ok(Number.isFinite(outcome.result.firstTextMs))
})

test('normal stop, empty, reasoning-only, missing finish and truncation remain distinct', async () => {
  for (const [chunks, expected] of [
    [[{ type: 'finish', reason: { kind: 'stop' } }], 'empty'],
    [[{ type: 'reasoning-delta', index: 0, text: 'thinking' }, { type: 'finish', reason: { kind: 'max-tokens' } }], 'empty'],
    [[{ type: 'text-delta', index: 0, text: 'partial' }], 'incomplete'],
    [[{ type: 'text-delta', index: 0, text: 'partial' }, { type: 'finish', reason: { kind: 'max-tokens' } }], 'truncated'],
    [[{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: 'secret' } } }], 'failed'],
  ]) {
    const fake = service({ behavior: async function* () { yield* chunks } })
    const result = (await probe(fake.llm, { provider: 'relay', model: 'm0' })).result
    assert.equal(result.status, expected)
    assert.ok(!JSON.stringify(result).includes('secret'))
  }
})

test('failure diagnostics use only validated facts and redact obvious secrets', () => {
  const result = classifyFailure(Object.assign(new Error('sk-supersecret123 https://relay.test/?key=secret'), { status: 401 }))
  assert.equal(result.halt, true)
  assert.equal(result.httpStatus, 401)
  assert.ok(!JSON.stringify(result).includes('secret'))
  const hostile = Object.defineProperty({}, 'status', { get() { throw new Error('no') } })
  assert.equal(classifyFailure(hostile).halt, false)
  assert.equal(cleanText('sk-supersecret123'), '[已隐藏]')
  assert.ok(!cleanText('https://relay.test/?key=secret').includes('secret'))
})

test('entering panel and selecting models never dispatch generation; confirmation required', async t => {
  const c = setup(); t.after(() => c.host.dispose())
  assert.equal(c.fake.calls.length, 0)
  await c.choose(); await c.call('select-page')
  assert.equal(c.fake.calls.length, 0)
  await c.call('prepare-run'); await c.call(c.feed.data.confirmation[1].id, { confirmed: false })
  assert.equal(c.fake.calls.length, 0)
  await c.call('confirm-run', { confirmed: true })
  assert.equal(c.fake.calls.length, 0)
})

test('batch is serial, progress is complete, and repeated confirmation cannot restart it', async t => {
  const c = setup(); t.after(() => c.host.dispose())
  await c.choose(); await c.call('select-page'); await c.start()
  await c.call('confirm-run', { confirmed: true })
  await until(() => c.feed.data.progressLabel.includes('本轮完成'))
  assert.equal(c.fake.calls.length, 3)
  assert.equal(c.fake.peak, 1)
  assert.equal(c.feed.data.completed, 3)
  assert.match(c.feed.data.summary, /成功 3/)
  assert.equal(c.feed.data.confirmation.length, 0)
  assert.equal(c.feed.errors.length, 0)
  assert.equal(c.host.violations.length, 0)
})

test('authentication and rate-limit failures stop the tail, general model failures continue', async t => {
  for (const [status, expected] of [[401, 1], [403, 1], [429, 1], [404, 3], [500, 3]]) {
    const c = setup(service({ behavior: async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'do-not-display', code: 'UNKNOWN', status } } } } }))
    t.after(() => c.host.dispose())
    await c.choose(); await c.call('select-page'); await c.start()
    await until(() => !c.feed.data.progressLabel.includes('准备中') && c.feed.data.runActions.some(a => a.action === 'prepare-run'))
    assert.equal(c.fake.calls.length, expected)
    assert.ok(!JSON.stringify(c.feed.data).includes('do-not-display'))
  }
})

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
test('cooperative timeout continues serially, cancellation stops without replaying', async t => {
  const timeout = setup(service({ behavior: async function* (options) { await waitForAbort(options.signal) } }), { timeoutMs: 12, graceMs: 10 })
  t.after(() => timeout.host.dispose())
  await timeout.choose(); await timeout.call('select-page'); await timeout.start()
  await until(() => timeout.feed.data.progressLabel.includes('本轮完成'))
  assert.equal(timeout.fake.calls.length, 3)
  assert.equal(timeout.fake.peak, 1)
  assert.ok(timeout.feed.data.resultRows.every(r => r.subtitle.startsWith('超时')))

  const cancel = setup(service({ behavior: async function* (options) { await waitForAbort(options.signal) } }))
  t.after(() => cancel.host.dispose())
  await cancel.choose(); await cancel.call('select-page'); await cancel.start()
  await until(() => cancel.fake.calls.length === 1)
  await cancel.call('stop-run')
  await until(() => cancel.feed.data.runActions.some(a => a.action === 'prepare-run'))
  assert.equal(cancel.fake.calls.length, 1)
  assert.match(cancel.feed.data.summary, /未检测 2/)
  assert.equal(cancel.feed.data.resultRows[0].subtitle.startsWith('已取消'), true)
})

test('uncooperative adapter keeps global lock until cleanup and does not dispatch tail', async t => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const c = setup(service({ behavior: async function* () { await pending; yield* ok() } }), { timeoutMs: 10, graceMs: 5 })
  t.after(() => { finish(); c.host.dispose() })
  await c.choose(); await c.call('select-page'); await c.start()
  await until(() => c.feed.data.progressLabel.includes('等待清理'))
  assert.equal(c.fake.calls.length, 1)
  const blocked = await c.call('prepare-run')
  assert.match(JSON.stringify(blocked), /清理/)
  finish()
  await until(() => c.feed.data.runActions.some(a => a.action === 'prepare-run'))
  assert.equal(c.fake.calls.length, 1)
  assert.match(c.feed.data.summary, /未检测 2/)
})

test('feed cleanup cancels in-flight generation and no tail starts', async t => {
  const c = setup(service({ behavior: async function* (options) { await waitForAbort(options.signal) } }))
  t.after(() => c.host.dispose())
  await c.choose(); await c.call('select-page'); await c.start()
  await until(() => c.fake.calls.length === 1)
  c.feed.stop()
  await tick(); await tick()
  assert.equal(c.fake.calls.length, 1)
  assert.equal(c.fake.calls[0].signal.aborted, true)
})

test('pagination keeps selections, batch cap is enforced, dynamic view stays within budget', async t => {
  const c = setup(service({ count: 100 })); t.after(() => c.host.dispose())
  await c.choose(); await c.call('select-page'); await c.call('next-model'); await c.call('select-page')
  assert.match(c.feed.data.selectionLabel, /已选 40/)
  await c.call('next-model'); await c.call('select-page')
  assert.match(c.feed.data.selectionLabel, /已选 40/)
  for (const row of c.feed.data.modelRows.slice(0, 10)) await c.call('toggle-model', row.action.args)
  assert.match(c.feed.data.selectionLabel, /已选 50/)
  await c.start()
  await until(() => c.feed.data.progressLabel.includes('本轮完成'))
  assert.equal(c.fake.calls.length, 50)
  assert.equal(c.feed.data.resultRows.length, 10)
  assert.ok(Buffer.byteLength(JSON.stringify(c.feed.data)) <= 32768)
  const checked = checkView(checkerView(), { budget: 'panel', data: c.feed.data, lang: 'zh' })
  assert.equal(checked.fatal, false, JSON.stringify(checked))
  assert.equal(checked.placeholders, 0, JSON.stringify(checked.issues))
  assert.equal(checked.truncated, 0, JSON.stringify(checked.issues))
  await c.call('next-result')
  assert.equal(c.feed.data.resultRows.length, 10)
})

test('stale selection tokens are rejected after a catalog refresh', async t => {
  const c = setup(); t.after(() => c.host.dispose())
  await c.choose()
  const old = c.feed.data.modelRows[0].action.args
  const pending = await c.call('refresh-catalog'); await pending.settled
  await c.call('toggle-model', old)
  assert.match(c.feed.data.selectionLabel, /已选 0/)
})

test('out-of-order model discovery does not overwrite the current provider', async t => {
  const fake = service({ providers: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] })
  let finishA
  fake.llm.listModels = provider => provider === 'a' ? new Promise(resolve => { finishA = resolve }) : Promise.resolve([{ id: 'b-model', name: 'B model' }])
  const c = setup(fake); t.after(() => c.host.dispose())
  const a = await c.call('pick-provider', { value: c.feed.data.providerOptions[0].value })
  await tick()
  await c.choose(1)
  finishA([{ id: 'a-model', name: 'A model' }])
  await a.settled
  assert.equal(c.feed.data.modelRows[0].title, 'B model')
})

test('missing model service still renders a usable explanation', () => {
  const host = createTestHost({ dir: DIR })
  host.ctx.inject(['dshGo'], ctx => createChecker(ctx))
  const feed = host.subscribe('checker')
  assert.match(feed.data.notice, /没有可用的模型服务/)
  assert.equal(checkView(checkerView(), { data: feed.data }).fatal, false)
  host.dispose()
})

test('old confirmation cannot authorize a newly prepared model selection', async t => {
  const c = setup(); t.after(() => c.host.dispose())
  await c.choose(); await c.call('select-page'); await c.call('prepare-run')
  const oldConfirm = c.feed.data.confirmation[1].id
  await c.call('clear-selection')
  await c.call('toggle-model', c.feed.data.modelRows[0].action.args)
  await c.call('prepare-run')
  const currentConfirm = c.feed.data.confirmation[1].id
  assert.notEqual(oldConfirm, currentConfirm)
  await c.call(oldConfirm, { confirmed: true })
  assert.equal(c.fake.calls.length, 0)
  assert.equal(c.feed.data.confirmation[1].id, currentConfirm)
  await c.call(currentConfirm, { confirmed: true })
  await until(() => c.feed.data.progressLabel.includes('本轮完成'))
  assert.equal(c.fake.calls.length, 1)
})

test('disable/re-enable cannot overlap an old adapter that ignores abort', async t => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const old = setup(service({ behavior: async function* () { await pending; yield* ok() } }), { timeoutMs: 15, graceMs: 5 })
  await old.choose(); await old.call('select-page'); await old.start()
  await until(() => old.fake.calls.length === 1)
  old.host.dispose()
  const next = setup(); t.after(() => { finish(); next.host.dispose() })
  await next.choose(); await next.call('select-page')
  const blocked = await next.call('prepare-run')
  assert.match(JSON.stringify(blocked), /清理/)
  assert.equal(next.fake.calls.length, 0)
  finish()
  await until(() => next.feed.data.runActions.some(a => a.action === 'prepare-run'))
  await next.start()
  await until(() => next.feed.data.progressLabel.includes('本轮完成'))
  assert.equal(old.fake.calls.length, 1)
  assert.equal(next.fake.calls.length, 3)
})

test('response limit aborts transport before waiting for iterator cleanup', async () => {
  let closed = false
  const llm = { prepareCall: async config => ({ config, stream(options) {
    return {
      [Symbol.asyncIterator]() { return this },
      next: async () => ({ done: false, value: { type: 'text-delta', index: 0, text: 'x'.repeat(66_000) } }),
      return: async () => {
        assert.equal(options.signal.aborted, true)
        closed = true
        return { done: true }
      },
    }
  } }) }
  const outcome = await probe(llm, { provider: 'relay', model: 'm0' }, { timeoutMs: 100 })
  assert.equal(outcome.result.status, 'incomplete')
  await outcome.cleanup
  assert.equal(closed, true)
  assert.equal(outcome.lingering, false)
})

test('JSON secret fields and URL userinfo are redacted', () => {
  assert.ok(!cleanText('{"api_key":"example-secret-value"}').includes('example-secret-value'))
  assert.ok(!cleanText('https://user:example-secret-value@host.test/v1').includes('example-secret-value'))
})

test('continue remaining tests never replays a cancelled item', async t => {
  let first = true
  const fake = service({ behavior: async function* (options) {
    if (first) { first = false; await waitForAbort(options.signal) }
    else yield* ok()
  } })
  const c = setup(fake); t.after(() => c.host.dispose())
  await c.choose(); await c.call('select-page'); await c.start()
  await until(() => fake.calls.length === 1)
  await c.call('stop-run')
  await until(() => c.feed.data.runActions.some(a => a.action === 'prepare-remaining'))
  await c.call('prepare-remaining')
  await c.call(c.feed.data.confirmation[1].id, { confirmed: true })
  await until(() => c.feed.data.progressLabel.includes('本轮完成'))
  assert.deepEqual(fake.calls.map(o => o.model), ['m0', 'm1', 'm2'])
})

test('third-party adapter codes are preserved and receive useful generated explanations', () => {
  for (const code of ['TRANSPORT', 'TIMEOUT', 'SERVER', 'INVALID_REQUEST', 'INVALID_CONFIG', 'UNKNOWN_MODEL', 'REQUEST_HEADERS', 'STREAM_CLOSED', 'MALFORMED_RESPONSE', 'PI_AI_ERROR']) {
    const result = classifyFailure({ code, message: 'private-fixture-do-not-copy' })
    assert.equal(result.code, code)
    assert.ok(!result.message.includes('没有足够'))
    assert.ok(!JSON.stringify(result).includes('private-fixture-do-not-copy'))
  }
})

test('HTTP status text inference is labeled and does not confuse timing with status', () => {
  const explicit = classifyFailure({ code: 'INVALID_REQUEST', message: 'HTTP status 400: {"api_key":"private-value"}' })
  assert.equal(explicit.httpStatus, 400)
  assert.equal(explicit.httpStatusSource, 'message')
  assert.ok(!JSON.stringify(explicit).includes('private-value'))
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR', message: '502 gateway error' }).httpStatus, 502)
  assert.equal(classifyFailure({ code: 'TRANSPORT', message: 'request failed after 400 ms' }).httpStatus, undefined)
})

test('network and parameter diagnostics emit only whitelisted hints, never raw messages', () => {
  for (const [message, hint] of [
    ['fetch failed; key=private-value', /底层网络请求/],
    ['getaddrinfo ENOTFOUND secret.host.test', /DNS/],
    ['connect ECONNREFUSED secret.host.test', /连接被拒绝/],
    ['CERT_HAS_EXPIRED https://name:private-value@secret.host.test', /TLS/],
    ['invalid max_tokens: must be greater than budget_tokens; api_key=private-value', /参数 max_tokens/],
  ]) {
    const result = classifyFailure({ code: 'PI_AI_ERROR', message })
    assert.match(result.hint, hint)
    assert.ok(!JSON.stringify(result).includes('private-value'))
    assert.ok(!JSON.stringify(result).includes('secret.host.test'))
  }
})

test('pre-dispatch error, adapter timeout, and transport error remain distinguishable', async () => {
  const preparation = await probe({ prepareCall: async () => { throw Object.assign(new Error('bad config'), { code: 'INVALID_CONFIG' }) } }, { provider: 'p', model: 'm' })
  assert.equal(preparation.result.phase, 'prepare')
  assert.equal(preparation.result.dispatchStarted, false)
  for (const [code, expected] of [['TIMEOUT', 'timeout'], ['TRANSPORT', 'failed']]) {
    const fake = service({ behavior: async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code, message: 'fixture-private' } } } } })
    const result = (await probe(fake.llm, { provider: 'relay', model: 'm0' })).result
    assert.equal(result.status, expected)
    assert.equal(result.phase, 'stream')
    assert.equal(result.code, code)
  }
})

test('timestamps display Beijing time with correct date rollover and safe empty values', () => {
  assert.equal(formatBeijingTime('2026-11-20T21:05:08.655Z'), '2026-11-21 05:05:08')
  assert.equal(formatBeijingTime('2026-12-31T16:00:00.000Z'), '2027-01-01 00:00:00')
  assert.equal(formatBeijingTime('2026-11-21T05:05:08+08:00'), '2026-11-21 05:05:08')
  assert.equal(formatBeijingTime(undefined), '—')
  assert.equal(formatBeijingTime(''), '—')
  assert.equal(formatBeijingTime('not-a-date'), '—')
})

test('success detail omits empty diagnostics and unknown HTTP without inventing status 200', () => {
  const detail = Object.fromEntries(resultDetails({ name: 'Fixture', model: 'fixture', status: 'success', phase: 'stream', startedAt: '2026-11-20T21:05:08.655Z', elapsedMs: 4720, firstTextMs: 4200, message: '本次文本请求正常完成。' }))
  assert.equal(detail['开始时间（北京时间）'], '2026-11-21 05:05:08')
  assert.equal(detail['总耗时'], '4.72 秒')
  assert.equal(detail['首段文本等待'], '4.20 秒')
  assert.equal(detail['请求阶段'], '已正常完成')
  assert.equal('错误分类' in detail, false)
  assert.equal('诊断提示' in detail, false)
  assert.equal('HTTP 状态' in detail, false)
  const known = Object.fromEntries(resultDetails({ name: 'Fixture', model: 'fixture', status: 'success', httpStatus: 201 }))
  assert.equal(known['HTTP 状态'], '201')
})

test('failure, timeout, truncation and cancellation keep their diagnostic fields', () => {
  for (const status of ['failed', 'timeout', 'truncated', 'empty', 'incomplete', 'cancelled']) {
    const detail = Object.fromEntries(resultDetails({ name: 'Fixture', model: 'fixture', status, phase: 'stream', code: 'TRANSPORT', hint: '底层网络请求失败。' }))
    assert.equal(detail['错误分类'], 'TRANSPORT')
    assert.equal(detail['诊断提示'], '底层网络请求失败。')
    assert.equal(detail['HTTP 状态'], '未采集（适配器未提供）')
    assert.notEqual(detail['请求阶段'], '已正常完成')
  }
  const inferred = Object.fromEntries(resultDetails({ name: 'Fixture', model: 'fixture', status: 'failed', httpStatus: 400, httpStatusSource: 'message' }))
  assert.equal(inferred['HTTP 状态'], '400（从错误信息识别）')
  assert.deepEqual(resultDetails(undefined), [])
})

test('no empty confirmation card before preparation, after cancellation, or after success', async t => {
  const c = setup(); t.after(() => c.host.dispose())
  const assertNoEmptyCard = () => {
    assert.deepEqual(c.feed.data.confirmationView, [{ type: 'text', text: '' }])
    const checked = checkView({ type: 'stack', children: c.feed.data.confirmationView }, { data: c.feed.data })
    assert.equal(checked.fatal, false)
    assert.equal(checked.empty, 0)
    assert.equal(checked.placeholders, 0)
  }
  assertNoEmptyCard()
  await c.choose(); await c.call('select-page'); await c.call('prepare-run')
  assert.equal(c.feed.data.confirmationView.length, 2)
  assert.equal(c.feed.data.confirmationView[1].type, 'confirm')
  assert.equal(checkView(checkerView(), { data: c.feed.data }).placeholders, 0)
  await c.call(c.feed.data.confirmation[1].id, { confirmed: false })
  assertNoEmptyCard()
  assert.equal(c.fake.calls.length, 0)
  await c.start()
  await until(() => c.feed.data.progressLabel.includes('本轮完成'))
  assertNoEmptyCard()
  const detail = Object.fromEntries(c.feed.data.detail)
  assert.equal(detail['请求阶段'], '已正常完成')
  assert.equal('错误分类' in detail, false)
  assert.ok(Object.keys(detail).includes('开始时间（北京时间）'))
})
