// Exercise the installed, REAL third-party adapter and its event conversion.
// Only its upstream event source is replaced. No real credentials or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAiAdapter } from '/opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
import { probe } from '../lib/probe.js'

function realAdapterHarness(api, events) {
  const model = { id: 'fixture-model', name: 'Fixture', provider: 'fixture', api, baseUrl: 'https://fixture.invalid/v1', reasoning: false, input: ['text'], contextWindow: 32_768, maxTokens: 4096 }
  const profile = { displayName: 'Fixture', configuredMaxTokens: new Map(), modelErrors: new Map(), streamIdleTimeoutMs: 1000, headers: {} }
  const captured = []
  const snapshot = { profiles: new Map([['fixture', profile]]), models: {
    getModel: () => model,
    streamSimple: (_model, context, options) => {
      captured.push({ context, options })
      return (async function* () { yield* events(api) })()
    },
  } }
  const adapter = new PiAiAdapter({ resolveApiKey: async () => undefined })
  adapter.current = () => snapshot
  const llm = { prepareCall: async (config, signal, configure) => {
    const prepared = await adapter.prepareCall(config.provider, config.model, signal)
    const { provider, model, ...controls } = config
    const resolved = { ...configure(controls, prepared.model), provider, model }
    return { config: resolved, stream: options => prepared.stream(options) }
  } }
  return { llm, captured }
}
const usage = { input: 4, output: 1, totalTokens: 5, cacheRead: 0, cacheWrite: 0 }
function message(api, overrides = {}) {
  return { role: 'assistant', api, provider: 'fixture', model: 'fixture-model', content: [{ type: 'text', text: 'OK' }], usage, stopReason: 'stop', timestamp: 0, ...overrides }
}

test('installed PiAiAdapter accepts the probe message shape for three protocols', async () => {
  for (const api of ['openai-completions', 'anthropic-messages', 'openai-responses']) {
    const harness = realAdapterHarness(api, api => [
      { type: 'text_start', contentIndex: 0 },
      { type: 'text_delta', contentIndex: 0, delta: 'OK' },
      { type: 'text_end', contentIndex: 0, content: 'OK' },
      { type: 'done', message: message(api) },
    ])
    const outcome = await probe(harness.llm, { provider: 'fixture', model: 'fixture-model' }, { timeoutMs: 500 })
    assert.equal(outcome.result.status, 'success', JSON.stringify(outcome.result))
    assert.equal(outcome.result.output, 'OK')
    assert.equal(harness.captured.length, 1)
    assert.equal(harness.captured[0].context.messages[0].content, '只回复 OK')
    assert.equal(harness.captured[0].options.maxTokens, 256)
    assert.equal(harness.captured[0].options.maxRetries, 0)
  }
})

test('actual PiAiAdapter network/timeout/parameter failures no longer collapse to generic errors', async () => {
  for (const [errorMessage, code, expected] of [
    ['fetch failed', 'TRANSPORT', 'failed'],
    ['connection timeout', 'TIMEOUT', 'timeout'],
    ['400 invalid_request: max_tokens must be greater than budget_tokens', 'INVALID_REQUEST', 'failed'],
    ['502 gateway error', 'SERVER', 'failed'],
  ]) {
    const harness = realAdapterHarness('anthropic-messages', api => [
      { type: 'error', error: message(api, { stopReason: 'error', errorMessage, content: [] }) },
    ])
    const outcome = await probe(harness.llm, { provider: 'fixture', model: 'fixture-model' }, { timeoutMs: 500 })
    assert.equal(outcome.result.code, code, JSON.stringify(outcome.result))
    assert.equal(outcome.result.status, expected)
    if (code === 'INVALID_REQUEST') {
      assert.equal(outcome.result.httpStatus, 400)
      assert.equal(outcome.result.httpStatusSource, 'message')
      assert.match(outcome.result.hint, /参数 max_tokens/)
    }
  }
})
