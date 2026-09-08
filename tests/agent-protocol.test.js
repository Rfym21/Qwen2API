const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

process.env.API_KEY = process.env.API_KEY || 'test-only-key'

const { createUpstreamDeltaNormalizer, formatHistoryMessages } = require('../src/utils/chat-helpers.js')
const {
  normalizeOpenAIFinishReason,
  handleStreamResponse,
  handleNonStreamResponse
} = require('../src/controllers/chat.js')
const {
  mapAnthropicStopReason,
  handleAnthropicStream,
  handleAnthropicNonStream
} = require('../src/controllers/anthropic.js')
const {
  externalizeOversizedAgentContext,
  compactAgentContextFallback
} = require('../src/utils/request.js')
const { assertNoUpstreamFailure } = require('../src/utils/upstream-error.js')
const {
  shouldEnableToolRuntime,
  ensureAgentCurrentEnvelope
} = require('../src/middlewares/chat-middleware.js')
const {
  buildAgentTurnDirective,
  parseAgentControlText,
  createAgentControlStreamParser
} = require('../src/utils/agent-turn.js')
const { logger } = require('../src/utils/logger.js')

test.after(() => {
  require('../src/utils/account.js').destroy()
})

const createMockResponse = () => ({
  output: '',
  headers: {},
  headersSent: false,
  writableEnded: false,
  statusCode: 200,
  set(headers) {
    Object.assign(this.headers, headers)
    return this
  },
  setHeader(name, value) {
    this.headers[name] = value
  },
  write(chunk) {
    this.headersSent = true
    this.output += String(chunk)
    return true
  },
  end(chunk = '') {
    if (chunk) this.write(chunk)
    this.writableEnded = true
  },
  status(code) {
    this.statusCode = code
    return this
  },
  json(value) {
    this.headersSent = true
    this.output += JSON.stringify(value)
    this.writableEnded = true
    return this
  }
})

test('phase-less answer content is not silently discarded', () => {
  const normalize = createUpstreamDeltaNormalizer()
  assert.deepEqual(normalize({ content: 'final answer' }), {
    phase: 'answer',
    content: 'final answer'
  })
  assert.deepEqual(normalize({ reasoning_content: 'thinking' }), {
    phase: 'think',
    content: 'thinking'
  })
})

// Defect A: Upstream role:"function" deltas are Qwen's own tool results, not the assistant
test('Defect A: upstream role:function deltas are dropped', () => {
  const normalize = createUpstreamDeltaNormalizer()
  // Qwen injects tool-registry results as role:"function" deltas with content like "Tool X does not exists."
  const result = normalize({
    role: 'function',
    phase: 'answer',
    name: 'read_file',
    content: 'Tool read_file does not exists.'
  })
  assert.equal(result, null, 'role:function delta should be dropped, not emitted as text')
})

test('Defect A: role:function with phase:code_interpreter is dropped', () => {
  const normalize = createUpstreamDeltaNormalizer()
  // Sandbox results from Qwen also use role:function
  const result = normalize({
    role: 'function',
    phase: 'code_interpreter',
    extra: { tool_result: 'some output' }
  })
  assert.equal(result, null, 'role:function sandbox result should be dropped')
})

test('Defect A: normal role:assistant answers pass through', () => {
  const normalize = createUpstreamDeltaNormalizer()
  const result = normalize({
    role: 'assistant',
    phase: 'answer',
    content: 'Here is the answer'
  })
  assert.deepEqual(result, {
    phase: 'answer',
    content: 'Here is the answer'
  }, 'normal assistant messages should pass through unchanged')
})

test('Defect A: thinking deltas pass through even with no role', () => {
  const normalize = createUpstreamDeltaNormalizer()
  const result = normalize({
    phase: 'think',
    content: 'thinking about this...'
  })
  assert.deepEqual(result, {
    phase: 'think',
    content: 'thinking about this...'
  }, 'thinking deltas should pass through')
})

test('finish reasons preserve truncation instead of reporting normal completion', () => {
  assert.equal(normalizeOpenAIFinishReason('length', false, true), 'length')
  assert.equal(normalizeOpenAIFinishReason(null, false, false), null)
  assert.equal(mapAnthropicStopReason('length', false, true), 'max_tokens')
  assert.equal(mapAnthropicStopReason(null, false, false), null)
  assert.equal(mapAnthropicStopReason('stop', true, true), 'tool_use')
})

test('history envelope preserves role and punctuation with JSONL', () => {
  const history = formatHistoryMessages([
    { role: 'system', content: 'keep: semicolons; intact' },
    { role: 'assistant', content: 'done; not really' }
  ])
  const lines = history.split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines, [
    { role: 'system', content: 'keep: semicolons; intact' },
    { role: 'assistant', content: 'done; not really' }
  ])
})

test('controller modules can consume fragmented terminal frames', async () => {
  const chunks = [
    Buffer.from('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"len'),
    Buffer.from('gth"}]}\r\n\r\ndata: [DO'),
    Buffer.from('NE]\r\n\r\n')
  ]
  const { consumeUpstream } = require('../src/controllers/anthropic.js')
  const seen = []
  const result = await consumeUpstream(Readable.from(chunks), json => seen.push(json))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].choices[0].finish_reason, 'length')
  assert.equal(result.sawDone, true)
})

test('OpenAI stream preserves length, accepts clean EOF and rejects transport aborts', async () => {
  const completedRes = createMockResponse()
  await handleStreamResponse(
    completedRes,
    Readable.from([
      'data: {"choices":[{"delta":{"content":"partial answer"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
    ]),
    false,
    false,
    { messages: [] },
    {}
  )
  assert.match(completedRes.output, /"finish_reason":"length"/)
  assert.doesNotMatch(completedRes.output, /"finish_reason":"stop"/)

  const cleanEofRes = createMockResponse()
  await handleStreamResponse(
    cleanEofRes,
    Readable.from(['data: {"choices":[{"delta":{"content":"normal eof"},"finish_reason":null}]}\n\n']),
    false,
    false,
    { messages: [] },
    {}
  )
  assert.match(cleanEofRes.output, /"finish_reason":"stop"/)
  assert.doesNotMatch(cleanEofRes.output, /upstream_incomplete/)

  async function * brokenStream() {
    yield 'data: {"choices":[{"delta":{"content":"cut"},"finish_reason":null}]}\n\n'
    const error = new Error('socket reset')
    error.code = 'ECONNRESET'
    throw error
  }
  const abortedRes = createMockResponse()
  await handleStreamResponse(
    abortedRes,
    Readable.from(brokenStream()),
    false,
    false,
    { messages: [] },
    {}
  )
  assert.match(abortedRes.output, /"code":"upstream_stream_error"/)
  assert.doesNotMatch(abortedRes.output, /"finish_reason":"stop"/)
})

test('thinking-only Agent turns retry once and recover visible output', async () => {
  let openAIRetries = 0
  const openAIRes = createMockResponse()
  // R11d: la ruta legacy (sin has_tools) pasa por chat.js:831 — antes un
  // logger.warning?.() mudo; ahora el retry de compensacion debe dejar linea.
  const warnLines = []
  const savedWarn = logger.warn
  logger.warn = (msg) => { warnLines.push(String(msg)) }
  try {
    await handleStreamResponse(
      openAIRes,
      Readable.from(['data: {"choices":[{"delta":{"phase":"think","content":"planning"},"finish_reason":null}]}\n\n']),
      true,
      false,
      { messages: [{ role: 'user', content: 'finish the task' }] },
      {
        sendChatRequest: async () => {
          openAIRetries += 1
          return {
            status: true,
            response: Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"recovered"},"finish_reason":null}]}\n\n'])
          }
        }
      }
    )
  } finally {
    logger.warn = savedWarn
  }
  assert.equal(openAIRetries, 1)
  assert.match(openAIRes.output, /recovered/)
  assert.match(openAIRes.output, /"finish_reason":"stop"/)
  assert.ok(
    warnLines.some(line => /Agent 首次响应没有正文或工具调用，进行一次补偿重试/.test(line)),
    `chat.js legacy stream retry must log its compensation line, got:\n${warnLines.join('\n')}`
  )

  let anthropicRetries = 0
  const anthropicRes = createMockResponse()
  await handleAnthropicStream(
    anthropicRes,
    {
      message_id: 'msg_retry',
      model: 'qwen-test',
      hasTools: false,
      requestBody: { messages: [{ role: 'user', content: 'finish the task' }] },
      sendRequest: async () => {
        anthropicRetries += 1
        return {
          status: true,
          response: Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"recovered"},"finish_reason":null}]}\n\n'])
        }
      }
    },
    Readable.from(['data: {"choices":[{"delta":{"phase":"think","content":"planning"},"finish_reason":null}]}\n\n'])
  )
  assert.equal(anthropicRetries, 1)
  assert.match(anthropicRes.output, /recovered/)
  assert.match(anthropicRes.output, /event: message_stop/)
})

// R11d: el gemelo non-stream de la ruta legacy (chat.js:1174, otro logger.warning?.()
// mudo hasta este ciclo) — un turno solo-thinking reintenta una vez y deja linea.
test('legacy non-stream empty-output retry logs its compensation line', async () => {
  const warnLines = []
  const savedWarn = logger.warn
  logger.warn = (msg) => { warnLines.push(String(msg)) }
  const res = createMockResponse()
  try {
    await handleNonStreamResponse(
      res,
      Readable.from(['data: {"choices":[{"delta":{"phase":"think","content":"planning"},"finish_reason":null}]}\n\ndata: [DONE]\n\n']),
      false,
      false,
      'qwen-test',
      { messages: [{ role: 'user', content: 'finish the task' }] },
      {
        sendChatRequest: async () => ({
          status: true,
          response: Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'])
        })
      }
    )
  } finally {
    logger.warn = savedWarn
  }
  assert.match(res.output, /recovered/)
  assert.ok(
    warnLines.some(line => /Agent 首次响应没有正文或工具调用，进行一次补偿重试/.test(line)),
    `chat.js legacy non-stream retry must log its compensation line, got:\n${warnLines.join('\n')}`
  )
})

test('strict OpenAI Agent gate streams reasoning but keeps rejected answer attempts isolated', async () => {
  const retryOptions = []
  let retries = 0
  const res = createMockResponse()
  const retryFrames = [
    [
      'data: {"response.created":{"chat_id":"chat_agent","parent_id":"p1","response_id":"resp_2","response_index":"0"}}\n\n',
      'data: {"choices":[{"delta":{"phase":"answer","content":"I will inspect the repository now."},"finish_reason":"stop"}],"response_id":"resp_2"}\n\n'
    ],
    [
      'data: {"response.created":{"chat_id":"chat_agent","parent_id":"resp_2","response_id":"resp_3","response_index":"0"}}\n\n',
      'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}</tool_call>"},"finish_reason":"stop"}],"response_id":"resp_3"}\n\n'
    ]
  ]

  await handleStreamResponse(
    res,
    Readable.from([
      'data: {"response.created":{"chat_id":"chat_agent","parent_id":"root","response_id":"resp_1","response_index":"0"}}\n\n',
      'data: {"choices":[{"delta":{"phase":"think","content":"first attempt planning"},"finish_reason":"stop"}],"response_id":"resp_1"}\n\n'
    ]),
    true,
    false,
    { messages: [{ role: 'user', content: 'finish the whole task' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file'],
      agent_turn_max_attempts: 3,
      sendChatRequest: async (_body, options) => {
        retryOptions.push(options)
        const frames = retryFrames[retries]
        retries += 1
        return { status: true, response: Readable.from(frames), chatId: 'chat_agent' }
      }
    }
  )

  assert.equal(retries, 2)
  assert.equal(retryOptions[0].chatId, 'chat_agent')
  assert.equal(retryOptions[0].parentId, 'resp_1')
  assert.equal(retryOptions[1].parentId, 'resp_2')
  assert.match(res.output, /"name":"read_file"/)
  assert.match(res.output, /"finish_reason":"tool_calls"/)
  assert.match(res.output, /"reasoning_content":"first attempt planning"/)
  assert.doesNotMatch(res.output, /I will inspect/)
})

test('strict OpenAI Agent gate accepts only explicit verified completion and strips control tags', async () => {
  let retries = 0
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"answer","content":"<agent_final>All requested changes were implemented and tests passed.</agent_final>"},"finish_reason":"stop"}]}\n\n'
    ]),
    false,
    false,
    { messages: [{ role: 'user', content: 'finish the task' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file'],
      sendChatRequest: async () => { retries += 1 }
    }
  )

  assert.equal(retries, 0)
  assert.match(res.output, /All requested changes were implemented and tests passed/)
  assert.match(res.output, /"finish_reason":"stop"/)
  assert.doesNotMatch(res.output, /agent_final/)
})

test('strict OpenAI Agent stream returns an in-band terminal error instead of a normal stop', async () => {
  let retries = 0
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"Looks good."},"finish_reason":"stop"}]}\n\n']),
    false,
    false,
    { messages: [{ role: 'user', content: 'complete and verify the task' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['run_tests'],
      agent_turn_max_attempts: 3,
      sendChatRequest: async () => {
        retries += 1
        return {
          status: true,
          response: Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"Still looks good."},"finish_reason":"stop"}]}\n\n'])
        }
      }
    }
  )

  assert.equal(retries, 2)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Content-Type'], 'text/event-stream')
  assert.match(res.output, /upstream_agent_turn_incomplete/)
  assert.match(res.output, /\[DONE\]/)
  assert.doesNotMatch(res.output, /"finish_reason":"stop"/)
})

test('strict OpenAI Agent stream exposes thinking incrementally before the gated turn completes', async () => {
  let releaseUpstream
  let firstFrameYielded
  const firstFrameWasYielded = new Promise(resolve => { firstFrameYielded = resolve })
  const upstream = Readable.from((async function * () {
    yield 'data: {"choices":[{"delta":{"phase":"think","content":"live thought"},"finish_reason":null}]}\n\n'
    firstFrameYielded()
    await new Promise(resolve => { releaseUpstream = resolve })
    yield 'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}</tool_call>"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  })())
  const res = createMockResponse()

  const responsePromise = handleStreamResponse(
    res,
    upstream,
    true,
    false,
    { messages: [{ role: 'user', content: 'inspect the repository' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file']
    }
  )

  await firstFrameWasYielded
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(res.headers['Content-Type'], 'text/event-stream')
  assert.equal(res.headers['X-Accel-Buffering'], 'no')
  assert.match(res.output, /"role":"assistant"/)
  assert.match(res.output, /"reasoning_content":"live thought"/)
  assert.equal(res.writableEnded, false)

  releaseUpstream()
  await responsePromise
  assert.equal((res.output.match(/live thought/g) || []).length, 1)
  assert.match(res.output, /"name":"read_file"/)
  assert.match(res.output, /"finish_reason":"tool_calls"/)
  assert.match(res.output, /\[DONE\]/)
})

test('strict OpenAI Agent stream exposes formal content before the final wrapper closes', async () => {
  let releaseUpstream
  let liveContentYielded
  const liveContentWasYielded = new Promise(resolve => { liveContentYielded = resolve })
  const upstream = Readable.from((async function * () {
    yield 'data: {"choices":[{"delta":{"phase":"answer","content":"<agent_f"},"finish_reason":null}]}\n\n'
    yield 'data: {"choices":[{"delta":{"phase":"answer","content":"inal>live final "},"finish_reason":null}]}\n\n'
    liveContentYielded()
    await new Promise(resolve => { releaseUpstream = resolve })
    yield 'data: {"choices":[{"delta":{"phase":"answer","content":"continues</agent_final>"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  })())
  const res = createMockResponse()

  const responsePromise = handleStreamResponse(
    res,
    upstream,
    false,
    false,
    { messages: [{ role: 'user', content: 'finish the task' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file']
    }
  )

  await liveContentWasYielded
  await new Promise(resolve => setImmediate(resolve))
  assert.match(res.output, /"content":"live final"/)
  assert.doesNotMatch(res.output, /"finish_reason":"stop"/)
  assert.equal(res.writableEnded, false)

  releaseUpstream()
  await responsePromise
  const content = res.output
    .split('\n\n')
    .filter(frame => frame.startsWith('data: {'))
    .map(frame => JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content || '')
    .join('')
  assert.equal(content, 'live final continues')
  assert.match(res.output, /"finish_reason":"stop"/)
  assert.match(res.output, /\[DONE\]/)
  assert.doesNotMatch(res.output, /agent_final/)
})

test('a malformed final wrapper cannot retry after formal content was streamed', async () => {
  let retries = 0
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"answer","content":"<agent_final>committed partial"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    ]),
    false,
    false,
    { messages: [{ role: 'user', content: 'finish the task' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file'],
      sendChatRequest: async () => { retries += 1 }
    }
  )

  assert.equal(retries, 0)
  assert.match(res.output, /"content":"committed partial"/)
  assert.match(res.output, /upstream_agent_stream_invalidated/)
  assert.match(res.output, /\[DONE\]/)
  assert.doesNotMatch(res.output, /"finish_reason":"stop"/)
})

test('strict OpenAI Agent gate preserves max-token termination without synthetic retries', async () => {
  let retries = 0
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"answer","content":"partial output"},"finish_reason":"length"}]}\n\n'
    ]),
    false,
    false,
    { messages: [] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file'],
      sendChatRequest: async () => { retries += 1 }
    }
  )
  assert.equal(retries, 0)
  assert.match(res.output, /partial output/)
  assert.match(res.output, /"finish_reason":"length"/)
})

test('strict non-stream Agent gate uses the primary response id and isolates all correction attempts', async () => {
  const retryBodies = []
  const retryOptions = []
  const res = createMockResponse()
  const retryFrames = [
    [
      'data: {"response.created":{"chat_id":"chat_agent","response_id":"resp_2","response_index":"0"}}\n\n',
      'data: {"choices":[{"delta":{"phase":"answer","content":"I will run the tests next."},"finish_reason":"stop"}],"response_id":"resp_2"}\n\n'
    ],
    [
      'data: {"response.created":{"chat_id":"chat_agent","response_id":"resp_3","response_index":"0"}}\n\n',
      'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"run_tests\\",\\"arguments\\":{}}</tool_call>"},"finish_reason":"stop"}],"response_id":"resp_3"}\n\n'
    ]
  ]

  await handleNonStreamResponse(
    res,
    Readable.from([
      'data: {"response.created":{"chat_id":"chat_agent","response_id":"primary_1","response_index":"0"}}\n\n',
      'data: {"response.created":{"chat_id":"chat_agent","response_id":"fallback_1","response_index":"1"}}\n\n'
    ]),
    false,
    false,
    'qwen-test',
    { messages: [{ role: 'user', content: 'ORIGINAL_CONTEXT' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['run_tests'],
      agent_turn_max_attempts: 3,
      upstream_request_body: { messages: [{ role: 'user', content: 'EXTERNALIZED_LIVE_CONTEXT' }] },
      sendChatRequest: async (body, options) => {
        retryBodies.push(body)
        retryOptions.push(options)
        return {
          status: true,
          response: Readable.from(retryFrames[retryBodies.length - 1]),
          chatId: 'chat_agent'
        }
      }
    }
  )

  assert.equal(retryBodies.length, 2)
  assert.match(retryBodies[0].messages[0].content, /EXTERNALIZED_LIVE_CONTEXT/)
  assert.doesNotMatch(retryBodies[0].messages[0].content, /ORIGINAL_CONTEXT/)
  assert.equal(retryOptions[0].parentId, 'primary_1')
  assert.equal(retryOptions[1].parentId, 'resp_2')
  const payload = JSON.parse(res.output)
  assert.equal(payload.choices[0].finish_reason, 'tool_calls')
  assert.equal(payload.choices[0].message.content, null)
  assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'run_tests')
  assert.doesNotMatch(res.output, /I will run the tests next/)
})

test('strict non-stream Agent gate returns an HTTP error instead of a fake completion when attempts are exhausted', async () => {
  let retries = 0
  let processingHeartbeats = 0
  const res = createMockResponse()
  res.writeProcessing = () => { processingHeartbeats += 1 }
  await handleNonStreamResponse(
    res,
    Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"Done."},"finish_reason":"stop"}]}\n\n']),
    false,
    false,
    'qwen-test',
    { messages: [{ role: 'user', content: 'finish and verify everything' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['run_tests'],
      agent_turn_max_attempts: 2,
      agent_processing_heartbeat_ms: 1,
      sendChatRequest: async () => {
        retries += 1
        await new Promise(resolve => setTimeout(resolve, 8))
        return {
          status: true,
          response: Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"Still done."},"finish_reason":"stop"}]}\n\n'])
        }
      }
    }
  )

  assert.equal(retries, 1)
  assert.ok(processingHeartbeats > 0)
  assert.equal(res.statusCode, 429)
  const payload = JSON.parse(res.output)
  assert.equal(payload.error.code, 'upstream_agent_turn_incomplete')
  assert.equal(Object.hasOwn(payload, 'choices'), false)
})

test('a standalone tool call emitted in the thinking phase remains executable', async () => {
  let retries = 0
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"think","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}</tool_call>"},"finish_reason":"stop"}]}\n\n'
    ]),
    true,
    false,
    { messages: [{ role: 'user', content: 'inspect the repository' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file'],
      sendChatRequest: async () => { retries += 1 }
    }
  )

  assert.equal(retries, 0)
  assert.match(res.output, /"name":"read_file"/)
  assert.match(res.output, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(res.output, /<tool_call>/)
})

// Pin de las guardas de promocion del loop A (evidencia read-only, sin cambio de src):
// la promocion desde thinking exige cleanedText VACIO — un call flanqueado por prosa
// de razonamiento es una cita/deliberacion, no una accion. Los loops B y C copian
// estas guardas (openai-agent-runtime.js:232-243) y les SUMAN dos conjuntos mas
// estrictos que A no tiene — allowlist no vacia (fail closed) y cero tool errors del
// lado answer (spec toolcall-salvage-2 + review R1); si alguien relaja las de A aqui,
// este test se pone rojo antes de que la relajacion se propague por paridad.
test('A-parity pin: a think call flanked by reasoning prose is NOT promoted', async () => {
  let retries = 0
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"think","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{}}</tool_call> but let me weigh it first"},"finish_reason":"stop"}]}\n\n'
    ]),
    true,
    false,
    { messages: [{ role: 'user', content: 'inspect the repository' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file'],
      sendChatRequest: async () => {
        retries += 1
        return {
          status: true,
          response: Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"<agent_final>done safely</agent_final>"},"finish_reason":"stop"}]}\n\n'])
        }
      }
    }
  )

  assert.equal(retries, 1, 'non-empty reasoning cleanedText must block promotion and force a retry')
  assert.doesNotMatch(res.output, /"tool_calls":\[/, 'the quoted think call must never execute')
  assert.match(res.output, /done safely/)
})

test('live reasoning never leaks fragmented tool markup before the Agent gate decides', async () => {
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"think","content":"checking <too"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"phase":"think","content":"l_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{}}</tool_call>"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"phase":"answer","content":"<agent_final>finished safely</agent_final>"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    ]),
    true,
    false,
    { messages: [{ role: 'user', content: 'finish safely' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file']
    }
  )

  assert.match(res.output, /"reasoning_content":"checking "/)
  assert.match(res.output, /finished safely/)
  assert.match(res.output, /"finish_reason":"stop"/)
  assert.doesNotMatch(res.output, /<tool_call>/)
  assert.doesNotMatch(res.output, /l_call>/)
})

test('a partially invalid multi-tool turn is rejected as a whole', async () => {
  let retries = 0
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}</tool_call><tool_call>{\\"name\\":\\"missing_tool\\",\\"arguments\\":{}}</tool_call>"},"finish_reason":"stop"}]}\n\n'
    ]),
    false,
    false,
    { messages: [{ role: 'user', content: 'inspect everything' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file'],
      sendChatRequest: async () => {
        retries += 1
        return {
          status: true,
          response: Readable.from([
            'data: {"choices":[{"delta":{"phase":"answer","content":"<agent_final>Unable to proceed without a valid second tool.</agent_final>"},"finish_reason":"stop"}]}\n\n'
          ])
        }
      }
    }
  )

  assert.equal(retries, 1)
  assert.match(res.output, /Unable to proceed/)
  assert.doesNotMatch(res.output, /"name":"read_file"/)
})

test('tool_choice none bypasses the Agent tool runtime even when definitions are present', () => {
  const tools = [{ type: 'function', function: { name: 'read_file' } }]
  assert.equal(shouldEnableToolRuntime(tools, 't2t', 'auto'), true)
  assert.equal(shouldEnableToolRuntime(tools, 't2t', 'none'), false)
})

test('single-message Agent requests get an explicit current-task envelope', () => {
  const wrapped = ensureAgentCurrentEnvelope('SINGLE_MESSAGE_TASK', 'user')
  assert.match(wrapped, /^# Current message\n/)
  assert.match(wrapped, /SINGLE_MESSAGE_TASK/)
  assert.equal(ensureAgentCurrentEnvelope(wrapped, 'user'), wrapped)
})

test('prose-only Agent actions are retried into executable tool calls', async () => {
  let openAIRetries = 0
  const openAIRes = createMockResponse()
  await handleStreamResponse(
    openAIRes,
    Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"I will inspect the repository now."},"finish_reason":null}]}\n\n']),
    false,
    false,
    { messages: [{ role: 'user', content: 'fix the project' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file'],
      sendChatRequest: async () => {
        openAIRetries += 1
        return {
          status: true,
          response: Readable.from([
            'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}</tool_call>"},"finish_reason":null}]}\n\n'
          ])
        }
      }
    }
  )
  assert.equal(openAIRetries, 1)
  assert.match(openAIRes.output, /"name":"read_file"/)
  assert.match(openAIRes.output, /"finish_reason":"tool_calls"/)

  let anthropicRetries = 0
  const anthropicRes = createMockResponse()
  await handleAnthropicStream(
    anthropicRes,
    {
      message_id: 'msg_action_retry',
      model: 'qwen-test',
      hasTools: true,
      toolChoice: 'auto',
      allowedToolNames: ['read_file'],
      requestBody: { messages: [{ role: 'user', content: 'fix the project' }] },
      sendRequest: async () => {
        anthropicRetries += 1
        return {
          status: true,
          response: Readable.from([
            'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}</tool_call>"},"finish_reason":null}]}\n\n'
          ])
        }
      }
    },
    Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"我将读取项目文件。"},"finish_reason":null}]}\n\n'])
  )
  assert.equal(anthropicRetries, 1)
  assert.match(anthropicRes.output, /"type":"tool_use"/)
  assert.match(anthropicRes.output, /"stop_reason":"tool_use"/)
})

test('clean-EOF tool turns keep Agent loops alive for OpenAI and Anthropic clients', async () => {
  const toolFrame = 'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}</tool_call>"},"finish_reason":null}]}\n\n'

  const openAIRes = createMockResponse()
  await handleStreamResponse(
    openAIRes,
    Readable.from([toolFrame]),
    false,
    false,
    { messages: [] },
    { has_tools: true, tool_choice: 'auto', allowed_tool_names: ['read_file'] }
  )
  assert.match(openAIRes.output, /"name":"read_file"/)
  assert.match(openAIRes.output, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(openAIRes.output, /"error"/)

  const anthropicRes = createMockResponse()
  await handleAnthropicStream(
    anthropicRes,
    {
      message_id: 'msg_tool_loop',
      model: 'qwen-test',
      hasTools: true,
      toolChoice: 'auto',
      allowedToolNames: ['read_file'],
      requestBody: { messages: [] }
    },
    Readable.from([toolFrame])
  )
  assert.match(anthropicRes.output, /"type":"tool_use"/)
  assert.match(anthropicRes.output, /"stop_reason":"tool_use"/)
  assert.match(anthropicRes.output, /event: message_stop/)
})

test('oversized Agent history is externalized while current turn stays live', async () => {
  const original = [
    '# Tools',
    'strict tool protocol',
    '# Conversation history (JSONL)',
    JSON.stringify({ role: 'tool', content: 'x'.repeat(12000) }),
    '# Current message',
    JSON.stringify({ role: 'user', content: 'continue fixing the project' })
  ].join('\n')
  let uploaded = ''
  const result = await externalizeOversizedAgentContext(
    { messages: [{ role: 'user', content: original, files: [] }], model: 'qwen-test' },
    'token',
    { email: 'test@example.com' },
    {
      thresholdBytes: 1024,
      livePromptBytes: 4096,
      uploader: async text => {
        uploaded = text
        return { id: 'file_context', type: 'file', name: 'QWEN2API_AGENT_CONTEXT.txt' }
      }
    }
  )

  assert.equal(result.externalized, true)
  assert.equal(uploaded, original)
  assert.equal(result.payload.messages[0].files[0].id, 'file_context')
  assert.match(result.payload.messages[0].content, /continue fixing the project/)
  assert.match(result.payload.messages[0].content, /Agent context attachment/)
  assert.ok(Buffer.byteLength(result.payload.messages[0].content) < Buffer.byteLength(original))
})

test('oversized multimodal Agent context is externalized and upload failure keeps tool schemas', async () => {
  const original = [
    '# Tools',
    'strict tool protocol with read_file(path: string)',
    '# Conversation history (JSONL)',
    JSON.stringify({ role: 'tool', content: 'x'.repeat(12000) }),
    '# Current message',
    JSON.stringify({ role: 'user', content: 'continue the unfinished task' })
  ].join('\n')
  const media = { type: 'image_url', image_url: { url: 'https://example.test/screenshot.png' } }
  const externalized = await externalizeOversizedAgentContext(
    { messages: [{ role: 'user', content: [{ type: 'text', text: original }, media] }] },
    'token',
    {},
    {
      thresholdBytes: 1024,
      livePromptBytes: 4096,
      uploader: async () => ({ id: 'file_context', name: 'QWEN2API_AGENT_CONTEXT_123.txt' })
    }
  )
  assert.equal(externalized.externalized, true)
  assert.match(externalized.payload.messages[0].content[0].text, /QWEN2API_AGENT_CONTEXT_123\.txt/)
  assert.deepEqual(externalized.payload.messages[0].content[1], media)

  const compacted = await externalizeOversizedAgentContext(
    { messages: [{ role: 'user', content: original }] },
    'token',
    {},
    {
      thresholdBytes: 1024,
      livePromptBytes: 4096,
      uploader: async () => { throw new Error('parse failed') }
    }
  )
  assert.equal(compacted.compacted, true)
  assert.match(compacted.payload.messages[0].content, /strict tool protocol with read_file/)
  assert.match(compacted.payload.messages[0].content, /continue the unfinished task/)
  assert.ok(Buffer.byteLength(compacted.payload.messages[0].content) <= 4096)
})

test('externalized Agent context keeps system rules active task and recent tool progress inline', async () => {
  const original = [
    '# Tools',
    'strict tool protocol',
    '# Conversation history (JSONL)',
    JSON.stringify({ role: 'system', content: 'SYSTEM_RULE_MUST_SURVIVE' }),
    JSON.stringify({ role: 'user', content: 'ACTIVE_TASK_MUST_SURVIVE: fix and verify the project' }),
    JSON.stringify({ role: 'assistant', content: '<tool_call>{"name":"bash","arguments":{"command":"test"}}</tool_call>' }),
    JSON.stringify({ role: 'user', content: `[TOOL RESULT: bash]\nRECENT_PROGRESS_MUST_SURVIVE ${'x'.repeat(5000)}\n[END TOOL RESULT]` }),
    '# Current message',
    JSON.stringify({ role: 'user', content: '[TOOL RESULT: bash]\nCURRENT_RESULT_MUST_SURVIVE\n[END TOOL RESULT]' }),
    buildAgentTurnDirective({ afterToolResult: true })
  ].join('\n')
  const result = await externalizeOversizedAgentContext(
    { messages: [{ role: 'user', content: original }] },
    'token',
    {},
    {
      thresholdBytes: 1024,
      livePromptBytes: 8192,
      uploader: async () => ({ id: 'agent_context', name: 'QWEN2API_AGENT_CONTEXT.txt' })
    }
  )
  const live = result.payload.messages[0].content
  assert.match(live, /SYSTEM_RULE_MUST_SURVIVE/)
  assert.match(live, /ACTIVE_TASK_MUST_SURVIVE/)
  assert.match(live, /RECENT_PROGRESS_MUST_SURVIVE/)
  assert.match(live, /CURRENT_RESULT_MUST_SURVIVE/)
  assert.match(live, /not a reason to stop after one action/)

  // El lock-step con foldToolMessages hay que afirmarlo SOBRE LA SECCION, no sobre el
  // prompt entero: ACTIVE_TASK_MUST_SURVIVE tambien aparece en el JSONL crudo de
  // "Recent Agent history", asi que la asercion global seguia verde con el guard borrado.
  // Si buildEssentialAgentHistory deja de reconocer [TOOL RESULT: ...], elige un bloque
  // de resultado como "tarea activa" y esta seccion trae TOOL RESULT.
  const activeSection = live.slice(live.indexOf('## Active user task')).split('\n# ')[0]
  assert.match(activeSection, /ACTIVE_TASK_MUST_SURVIVE/, 'la tarea activa real no quedo en su seccion')
  assert.doesNotMatch(activeSection, /TOOL RESULT/, 'un resultado de herramienta se eligio como tarea activa')
  assert.doesNotMatch(activeSection, /tool_response/, 'un resultado en formato viejo se eligio como tarea activa')

  const recovered = compactAgentContextFallback(original, 8192)
  assert.match(recovered, /SYSTEM_RULE_MUST_SURVIVE/)
  assert.match(recovered, /ACTIVE_TASK_MUST_SURVIVE/)
  assert.match(recovered, /RECENT_PROGRESS_MUST_SURVIVE/)
  assert.match(recovered, /CURRENT_RESULT_MUST_SURVIVE/)
  assert.doesNotMatch(recovered, /complete copy is in the attachment/)
  assert.ok(Buffer.byteLength(recovered) <= 8192)
})

test('externalized single-message Agent context keeps the original task outside large tool schemas', async () => {
  const original = [
    '# Tools',
    `LARGE_TOOL_SCHEMA ${'s'.repeat(12000)}`,
    ensureAgentCurrentEnvelope('SINGLE_ACTIVE_TASK_MUST_SURVIVE', 'user'),
    buildAgentTurnDirective()
  ].join('\n\n')
  const result = await externalizeOversizedAgentContext(
    { messages: [{ role: 'user', content: original }] },
    'token',
    {},
    {
      thresholdBytes: 1024,
      livePromptBytes: 4096,
      uploader: async () => ({ id: 'single_context', name: 'QWEN2API_AGENT_CONTEXT.txt' })
    }
  )

  assert.equal(result.externalized, true)
  assert.match(result.payload.messages[0].content, /SINGLE_ACTIVE_TASK_MUST_SURVIVE/)
  assert.ok(Buffer.byteLength(result.payload.messages[0].content) <= 4096)
})

test('Agent completion control parser rejects bare and mixed completion claims', () => {
  assert.deepEqual(parseAgentControlText('<agent_final>done</agent_final>'), { kind: 'final', text: 'done' })
  assert.equal(parseAgentControlText('done').kind, 'bare')
  assert.equal(parseAgentControlText('prefix <agent_final>done</agent_final>').kind, 'invalid_control')
})

test('Agent completion control stream parser handles split tags and trims only wrapper edges', () => {
  const parser = createAgentControlStreamParser()
  const deltas = [
    parser.push('  <agent_'),
    parser.push('blocked>  need '),
    parser.push('user input  </agent_'),
    parser.push('blocked>  '),
    parser.flush()
  ]
  assert.equal(deltas.map(item => item.textDelta).join(''), 'need user input')
  assert.equal(deltas.at(-1).kind, 'blocked')
  assert.equal(deltas.at(-1).closed, true)
  assert.equal(deltas.at(-1).invalid, false)

  const invalid = createAgentControlStreamParser()
  assert.equal(invalid.push('bare response').textDelta, '')
  assert.equal(invalid.flush().invalid, true)
})

test('Qwen HTTP-200 WAF payload is surfaced as an explicit failure', () => {
  assert.throws(
    () => assertNoUpstreamFailure({
      ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR'],
      data: { url: 'https://chat.qwen.ai/punish?action=captcha' }
    }),
    error => error.code === 'upstream_waf_challenge'
  )
})

test('Qwen HTTP-200 bare JSON WAF response reaches OpenAI clients explicitly', async () => {
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from([JSON.stringify({
      ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR'],
      data: { url: 'https://chat.qwen.ai/punish?action=captcha' }
    })]),
    false,
    false,
    { messages: [] },
    {}
  )
  assert.equal(res.statusCode, 502)
  assert.match(res.output, /upstream_waf_challenge/)
  assert.match(res.output, /WAF\\u002fcaptcha|WAF\/captcha/)
})

test('Anthropic stream emits thinking signature, max_tokens and tool parse errors', async () => {
  const thinkingRes = createMockResponse()
  await handleAnthropicStream(
    thinkingRes,
    {
      message_id: 'msg_test',
      model: 'qwen-test',
      hasTools: false,
      requestBody: { messages: [] }
    },
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"think","content":"reason"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
    ])
  )
  assert.match(thinkingRes.output, /"type":"signature_delta"/)
  assert.match(thinkingRes.output, /"stop_reason":"max_tokens"/)
  assert.match(thinkingRes.output, /event: message_stop/)

  const invalidToolRes = createMockResponse()
  await handleAnthropicStream(
    invalidToolRes,
    {
      message_id: 'msg_tool',
      model: 'qwen-test',
      hasTools: true,
      toolChoice: 'auto',
      allowedToolNames: ['read_file'],
      requestBody: { messages: [] }
    },
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    ])
  )
  assert.match(invalidToolRes.output, /event: error/)
  assert.match(invalidToolRes.output, /invalid_tool_call_error/)
  assert.doesNotMatch(invalidToolRes.output, /event: message_stop/)
})

test('non-stream responses preserve truncation for both protocols', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
  ]

  const openAIRes = createMockResponse()
  await handleNonStreamResponse(
    openAIRes,
    Readable.from(frames),
    false,
    false,
    'qwen-test',
    { messages: [] },
    {}
  )
  assert.match(openAIRes.output, /"finish_reason":"length"/)

  const anthropicRes = createMockResponse()
  await handleAnthropicNonStream(
    anthropicRes,
    {
      message_id: 'msg_nonstream',
      model: 'qwen-test',
      hasTools: false,
      requestBody: { messages: [] }
    },
    Readable.from(frames)
  )
  assert.match(anthropicRes.output, /"stop_reason":"max_tokens"/)
})

test('interleaved multi-response frames are not merged into a duplicated answer', async () => {
  // 上游偶尔对同一次请求开启多路候选回答：先下发两个 response.created
  // （response_index "0"/"1"，各自 response_id 不同），随后两路增量帧交错到达。
  // 不按 response_id 区分就会把两路内容拼在一起，回答被复读（问题 #149）。
  // 下列帧取自 chat.qwen.ai 实际抓包。
  const dualResponseFrames = [
    'data: {"response.created":{"chat_id":"d8e2ce75","parent_id":"4cc3a56d","response_id":"4f79335b","response_index":"0"}}\n\n',
    'data: {"response.created":{"chat_id":"d8e2ce75","parent_id":"4cc3a56d","response_id":"4c2b7c86","response_index":"1"}}\n\n',
    'data: {"choices":[{"delta":{"role":"assistant","content":"巴","phase":"answer","status":"typing"}}],"response_id":"4c2b7c86"}\n\n',
    'data: {"choices":[{"delta":{"role":"assistant","content":"巴","phase":"answer","status":"typing"}}],"response_id":"4f79335b"}\n\n',
    'data: {"choices":[{"delta":{"role":"assistant","content":"黎","phase":"answer","status":"typing"}}],"response_id":"4c2b7c86"}\n\n',
    'data: {"choices":[{"delta":{"content":"","role":"assistant","status":"finished","phase":"answer"}}],"response_id":"4c2b7c86"}\n\n',
    'data: {"choices":[{"delta":{"role":"assistant","content":"黎","phase":"answer","status":"typing"}}],"response_id":"4f79335b"}\n\n',
    'data: {"choices":[{"delta":{"content":"","role":"assistant","status":"finished","phase":"answer"}}],"response_id":"4f79335b"}\n\n',
    'data: [DONE]\n\n'
  ]

  const readAnswer = (output) => output
    .split('\n\n')
    .map(frame => frame.replace(/^data: /, '').trim())
    .filter(frame => frame && frame !== '[DONE]')
    .map(frame => JSON.parse(frame))
    .map(json => json.choices?.[0]?.delta?.content || '')
    .join('')

  const streamRes = createMockResponse()
  await handleStreamResponse(streamRes, Readable.from(dualResponseFrames), false, false, { messages: [] }, {})
  assert.equal(readAnswer(streamRes.output), '巴黎')

  const nonStreamRes = createMockResponse()
  await handleNonStreamResponse(nonStreamRes, Readable.from(dualResponseFrames), false, false, { messages: [] }, {})
  assert.equal(JSON.parse(nonStreamRes.output).choices[0].message.content, '巴黎')
})

// ---------------------------------------------------------------------------
// 回合门禁放宽开关（默认关闭，严格行为不变）
// ---------------------------------------------------------------------------
const agentTurnConfig = require('../src/config/index.js')
const { evaluateOpenAIAgentAttempt: evaluateAgentTurn } = require('../src/utils/openai-agent-runtime.js')

const buildAttempt = (overrides = {}) => ({
  upstreamFinishReason: null,
  toolErrors: [],
  toolCalls: [],
  controlKind: 'empty',
  visibleText: '',
  ...overrides
})

const withAgentTurnFlags = (flags, fn) => {
  const saved = {
    agentTurnAllowProseWithTools: agentTurnConfig.agentTurnAllowProseWithTools,
    agentTurnAcceptBareFinal: agentTurnConfig.agentTurnAcceptBareFinal
  }
  Object.assign(agentTurnConfig, flags)
  try {
    return fn()
  } finally {
    Object.assign(agentTurnConfig, saved)
  }
}

test('默认严格模式：工具调用附带可见正文仍判为 invalid_tool_call', () => {
  const attempt = buildAttempt({
    toolCalls: [{ id: 'call_1', function: { name: 'read', arguments: '{}' } }],
    controlKind: 'bare',
    visibleText: '我先看一下这个文件。'
  })
  withAgentTurnFlags({ agentTurnAllowProseWithTools: false }, () => {
    assert.deepEqual(evaluateAgentTurn(attempt), {
      accepted: false,
      finishReason: null,
      retryReason: 'invalid_tool_call',
      // Ronda NO cortada (sin textChannelCut): el rechazo estricto se mantiene; `detail`
      // sólo etiqueta cuál de los dos invalid_tool_call fue, para los logs de producción.
      detail: 'prose_with_tools'
    })
  })
})

test('AGENT_TURN_ALLOW_PROSE_WITH_TOOLS 打开后接受正文与工具调用共存', () => {
  const attempt = buildAttempt({
    toolCalls: [{ id: 'call_1', function: { name: 'read', arguments: '{}' } }],
    controlKind: 'bare',
    visibleText: '我先看一下这个文件。'
  })
  withAgentTurnFlags({ agentTurnAllowProseWithTools: true }, () => {
    assert.deepEqual(evaluateAgentTurn(attempt), {
      accepted: true,
      finishReason: 'tool_calls',
      retryReason: null
    })
  })
})

test('打开放宽开关也不会接受非法工具调用', () => {
  const attempt = buildAttempt({
    toolErrors: [{ message: 'truncated tool_call' }],
    visibleText: '正文'
  })
  withAgentTurnFlags({ agentTurnAllowProseWithTools: true, agentTurnAcceptBareFinal: true }, () => {
    assert.equal(evaluateAgentTurn(attempt).accepted, false)
    assert.equal(evaluateAgentTurn(attempt).retryReason, 'invalid_tool_call')
  })
})

test('默认严格模式：缺少 <agent_final> 包装的正文判为 bare', () => {
  const attempt = buildAttempt({ controlKind: 'bare', visibleText: '已经改完了。' })
  withAgentTurnFlags({ agentTurnAcceptBareFinal: false }, () => {
    assert.equal(evaluateAgentTurn(attempt).retryReason, 'bare')
  })
})

test('AGENT_TURN_ACCEPT_BARE_FINAL 打开后按 stop 接受，空正文仍判为 bare', () => {
  withAgentTurnFlags({ agentTurnAcceptBareFinal: true }, () => {
    assert.deepEqual(
      evaluateAgentTurn(buildAttempt({ controlKind: 'bare', visibleText: '已经改完了。' })),
      { accepted: true, finishReason: 'stop', retryReason: null }
    )
    assert.equal(
      evaluateAgentTurn(buildAttempt({ controlKind: 'bare', visibleText: '   ' })).retryReason,
      'bare'
    )
  })
})

// La ruta OpenAI viva es el turn gate (handleStreamResponse retorna temprano a
// handleOpenAIAgentStream siempre que has_tools sea truthy). Si el modelo cita el tag
// literal en el canal de razonamiento de un turno que el gate acepta, ese texto debe
// llegar entero: antes el parser se lo tragaba y la frase salía cortada en el tag.
//
// El mismo eco en el canal de respuesta NO llega: el gate estricto lo marca
// invalid_tool_call y, como ya salió texto, cierra con 422
// upstream_agent_stream_invalidated. Eso es comportamiento deliberado del gate
// (tests "默认严格模式" + los switches AGENT_TURN_*), no algo que este cambio toque.
// Anotado en deferred-work.md.
test('an echoed <tool_call> in accepted reasoning reaches the client whole', async () => {
  let retries = 0
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"think","content":"Use a `<tool_call>` block next time."},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"phase":"answer","content":"<agent_final>done</agent_final>"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    ]),
    true,
    false,
    { messages: [{ role: 'user', content: 'explain the protocol' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file'],
      sendChatRequest: async () => { retries += 1 }
    }
  )

  assert.equal(retries, 0, 'el turno era aceptable; no debía reintentarse')
  assert.match(res.output, /Use a /)
  assert.match(res.output, /block next time\./, 'la frase llegó cortada en el tag')
  assert.doesNotMatch(res.output, /upstream_agent|invalid_tool_call/)
})

// ── Defensa de recuperacion de protocolo en la ruta OpenAI (findings 9 y 10) ──
// La interceptacion de plataforma (drops role:function) y el protocolo de brackets
// escrito a medias (residuo huerfano / payload pelado) mataban el turno tambien en
// /v1/chat/completions: el gate aceptaba la narracion envuelta en <agent_final>
// como completacion legitima. Ahora ambos son razones de retry con tope compartido.

const { runOpenAIAgentTurn } = require('../src/utils/openai-agent-runtime.js')

const agentAnswerFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'answer', content }, finish_reason: null }]
})}\n\n`
const agentInterceptionFrame = (name) => `data: ${JSON.stringify({
  choices: [{
    delta: { role: 'function', phase: 'answer', name, content: `Tool ${name} does not exists` },
    finish_reason: null
  }]
})}\n\n`
const agentTurnStream = (...frames) => Readable.from([
  ...frames,
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
])

const WRAPPED_NARRATION = '<agent_final>The Bash tool seems unavailable, giving up on the task.</agent_final>'
const AGENT_BRACKET_CALL = '[TOOL CALL]{"name":"read_file","arguments":{"path":"a.txt"}}[END TOOL CALL]'
// Leak real #2 (2026-08-31): JSON completo y valido al inicio, closers doblados.
const AGENT_LEAK = [
  '{"name": "AskUserQuestion", "arguments": {"questions": [{"question": "Deploy to which environment?", "header": "Env", "options": [{"label": "dev", "description": "staging first"}, {"label": "prod", "description": "straight to production"}], "multiSelect": false}]}}',
  '[END TOOL CALL]',
  '[END TOOL CALL]'
].join('\n')
// El mismo payload SIN closer: residuo (forma de leak) pero no protocolo demostrable →
// sigue disparando malformed_protocol. Desde el spec narrated-toolcall (2026-09-02) la
// forma CON closer y nombre no declarado es un error duro (unknown_tool → invalid_tool_call).
const AGENT_LEAK_NO_CLOSER = AGENT_LEAK.split('\n')[0]

const runAgentTurn = (initialFrames, sendChatRequest, overrides = {}) => runOpenAIAgentTurn(
  agentTurnStream(...initialFrames),
  {
    has_tools: true,
    tool_choice: 'auto',
    allowed_tool_names: ['read_file'],
    agent_turn_max_attempts: 3,
    upstream_request_body: { messages: [{ role: 'user', content: 'do the task' }] },
    sendChatRequest,
    ...overrides
  }
)

test('OpenAI gate: la narracion envuelta tras drops se rechaza como intercepted, no se acepta', () => {
  const attempt = buildAttempt({
    controlKind: 'final',
    visibleText: 'The Bash tool seems unavailable, giving up.',
    interceptedToolNames: ['Bash']
  })
  assert.deepEqual(evaluateAgentTurn(attempt), {
    accepted: false,
    finishReason: null,
    retryReason: 'intercepted'
  })
  // Nombre agotado el tope compartido: se entrega por las reglas de siempre.
  assert.equal(evaluateAgentTurn(attempt, { protocol_recovery_used: true }).accepted, true)
  // Sin herramientas en juego, los drops no significan nada.
  assert.equal(evaluateAgentTurn(attempt, { has_tools: false }).accepted, true)
})

test('OpenAI gate: drops junto a una llamada aceptada no reintenta (drop especulativo benigno)', () => {
  const attempt = buildAttempt({
    toolCalls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{}' } }],
    interceptedToolNames: ['Bash']
  })
  assert.deepEqual(evaluateAgentTurn(attempt), {
    accepted: true,
    finishReason: 'tool_calls',
    retryReason: null
  })
})

test('OpenAI gate: el leak de protocolo malformado se rechaza; JSON ordinario no', () => {
  assert.equal(
    evaluateAgentTurn(buildAttempt({ controlKind: 'bare', visibleText: AGENT_LEAK })).retryReason,
    'malformed_protocol'
  )
  // JSON sin clave "arguments" al inicio: respuesta normal, cae en bare.
  assert.equal(
    evaluateAgentTurn(buildAttempt({ controlKind: 'bare', visibleText: '{"name": "results", "count": 3}' })).retryReason,
    'bare'
  )
})

test('OpenAI loop: turno interceptado reintenta una vez con el hint canonico y recupera', async () => {
  const sent = []
  const result = await runAgentTurn(
    [agentInterceptionFrame('read_file'), agentAnswerFrame(WRAPPED_NARRATION)],
    async (body) => {
      sent.push(body)
      return { status: true, response: agentTurnStream(agentAnswerFrame(AGENT_BRACKET_CALL)) }
    }
  )

  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(result.attempt.toolCalls[0].function.name, 'read_file')
  assert.equal(sent.length, 1)
  const hint = JSON.stringify(sent[0])
  assert.match(hint, /did not reach the client/)
  assert.ok(hint.includes('[TOOL CALL]'), 'el hint debe ensenar el marcador canonico')
  assert.doesNotMatch(hint, /<tool_call/i)
})

test('OpenAI loop: la segunda interceptacion entrega el final envuelto tal cual (tope de uno)', async () => {
  let sent = 0
  const result = await runAgentTurn(
    [agentInterceptionFrame('read_file'), agentAnswerFrame(WRAPPED_NARRATION)],
    async () => {
      sent += 1
      return {
        status: true,
        response: agentTurnStream(agentInterceptionFrame('read_file'), agentAnswerFrame(WRAPPED_NARRATION))
      }
    }
  )

  assert.equal(sent, 1, 'exactamente un retry de recuperacion de protocolo por request')
  assert.equal(result.ok, true, 'entregar tal cual, no agotar con 429')
  assert.equal(result.finishReason, 'stop')
  assert.match(result.attempt.visibleText, /unavailable/)
})

test('OpenAI loop: el leak malformado (sin closer) reintenta con su hint y recupera tool_calls', async () => {
  const sent = []
  const result = await runAgentTurn(
    [agentAnswerFrame(AGENT_LEAK_NO_CLOSER)],
    async (body) => {
      sent.push(body)
      return { status: true, response: agentTurnStream(agentAnswerFrame(AGENT_BRACKET_CALL)) }
    }
  )

  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(sent.length, 1)
  assert.match(JSON.stringify(sent[0]), /was NOT executed/)
})

test('OpenAI loop: el leak CON closer y nombre no declarado es error duro (spec narrated-toolcall) → invalid_tool_call, reintenta y recupera', async () => {
  const sent = []
  const result = await runAgentTurn(
    [agentAnswerFrame(AGENT_LEAK)],
    async (body) => {
      sent.push(body)
      return { status: true, response: agentTurnStream(agentAnswerFrame(AGENT_BRACKET_CALL)) }
    }
  )

  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(sent.length, 1)
  const hint = JSON.stringify(sent[0])
  assert.match(hint, /invalid, truncated, or unknown tool call/, 'la razon es invalid_tool_call (unknown_tool), no malformed_protocol')
  assert.doesNotMatch(hint, /was NOT executed/)
})

test('OpenAI loop: required_tool tapa la interceptacion pero el hint lleva el dato clave', async () => {
  const sent = []
  const result = await runAgentTurn(
    [agentInterceptionFrame('read_file'), agentAnswerFrame(WRAPPED_NARRATION)],
    async (body) => {
      sent.push(body)
      return { status: true, response: agentTurnStream(agentAnswerFrame(AGENT_BRACKET_CALL)) }
    },
    { tool_choice: 'required' }
  )

  assert.equal(result.ok, true)
  const hint = JSON.stringify(sent[0])
  assert.match(hint, /violated tool_choice/, 'la razon elegida sigue siendo required_tool')
  assert.match(hint, /did not reach the client/, 'el dato de la interceptacion no puede perderse')
})

// ── Salvage de aperturas ausentes en la ruta OpenAI (spec toolcall-salvage) ──
// El mismo AGENT_LEAK que arriba dispara malformed_protocol (nombre NO declarado)
// se vuelve la llamada real cuando el cliente SI declaro la herramienta: el parser
// compartido lo rescata y el turno se acepta como tool_calls sin gastar retries.

test('OpenAI loop: el leak con nombre declarado se rescata como tool_calls, cero retries', async () => {
  let sent = 0
  const result = await runAgentTurn(
    [agentAnswerFrame(AGENT_LEAK)],
    async () => { sent += 1; return { status: false } },
    { allowed_tool_names: ['read_file', 'AskUserQuestion'] }
  )

  assert.equal(sent, 0, 'la llamada rescatada no debe gastar ningun retry')
  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(result.attempt.toolCalls.length, 1)
  assert.equal(result.attempt.toolCalls[0].function.name, 'AskUserQuestion')
  const args = JSON.parse(result.attempt.toolCalls[0].function.arguments)
  assert.equal(args.questions[0].header, 'Env', 'los arguments anidados se perdieron en el rescate')
  assert.equal(result.attempt.visibleText.trim(), '', 'texto del payload sobrevivio como respuesta visible')
})

// ── Filtro clientToolNames sobre la evidencia de interceptacion (unidad) ──
// Solo los nombres que el cliente declaro cuentan como drops interceptados; los
// tools internos de la plataforma (web_search / web_extractor / sin nombre) se
// dropean y loguean igual, pero no arman el retry 'intercepted'.

test('normalizer: clientToolNames filtra que drops cuentan como interceptacion', () => {
  const filtered = createUpstreamDeltaNormalizer({ clientToolNames: ['read_file'] })
  filtered({ role: 'function', phase: 'answer', name: 'web_search', content: 'x' })
  filtered({ role: 'function', phase: 'answer', content: 'no-name frame' })
  assert.deepEqual(filtered.interceptedToolNames, [], 'un tool interno de plataforma conto como evidencia')
  filtered({ role: 'function', phase: 'answer', name: 'read_file', content: 'Tool read_file does not exists' })
  assert.deepEqual(filtered.interceptedToolNames, ['read_file'])

  // Sin la opcion, el comportamiento historico se conserva: todo drop se registra.
  const legacy = createUpstreamDeltaNormalizer()
  legacy({ role: 'function', phase: 'answer', name: 'web_search', content: 'x' })
  assert.deepEqual(legacy.interceptedToolNames, ['web_search'])

  // Un set vacio equivale a no filtrar (peticiones sin tools no cambian de semantica).
  const empty = createUpstreamDeltaNormalizer({ clientToolNames: [] })
  empty({ role: 'function', phase: 'answer', name: 'web_search', content: 'x' })
  assert.deepEqual(empty.interceptedToolNames, ['web_search'])

  // P9: un frame SIN nombre jamas cuenta como evidencia con el filtro activo — ni
  // siquiera si el cliente declaro un tool literalmente llamado "unknown". El
  // placeholder de log no puede dejar que un frame anonimo se haga pasar por el.
  const trap = createUpstreamDeltaNormalizer({ clientToolNames: ['unknown'] })
  trap({ role: 'function', phase: 'answer', content: 'nameless platform frame' })
  assert.deepEqual(trap.interceptedToolNames, [], 'un frame sin nombre conto como el tool "unknown"')
  trap({ role: 'function', phase: 'answer', name: 'unknown', content: 'x' })
  assert.deepEqual(trap.interceptedToolNames, ['unknown'], 'un tool declarado "unknown" con nombre real si cuenta')
})

// ── P10: el cableado clientToolNames de la ruta OpenAI, pinneado end-to-end ──
// Revertir openai-agent-runtime a createUpstreamDeltaNormalizer() pelado debe
// romper estas dos pruebas — antes nada las cubria.

test('P10: drops de tools internos en la ruta OpenAI no disparan intercepted', async () => {
  let sent = 0
  const result = await runAgentTurn(
    [agentInterceptionFrame('web_search'), agentAnswerFrame(WRAPPED_NARRATION)],
    async () => { sent += 1; return { status: false } }
  )
  assert.equal(sent, 0, 'un drop de web_search quemo un retry intercepted falso')
  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'stop')
  assert.match(result.attempt.visibleText, /unavailable/)
})

test('P10: los drops internos no queman el slot que malformed_protocol necesita', async () => {
  const sent = []
  const result = await runAgentTurn(
    [agentInterceptionFrame('web_search'), agentAnswerFrame(AGENT_LEAK_NO_CLOSER)],
    async (body) => {
      sent.push(body)
      return { status: true, response: agentTurnStream(agentAnswerFrame(AGENT_BRACKET_CALL)) }
    }
  )
  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(sent.length, 1)
  const hint = JSON.stringify(sent[0])
  assert.match(hint, /was NOT executed/, 'la razon debe ser malformed_protocol')
  assert.doesNotMatch(hint, /did not reach the client/,
    'web_search conto como interceptacion y robo la razon del retry')
})

// ── D5: promocion de function_call NATIVOS en la ruta OpenAI y en chat.js legacy ──
// El modelo llama a las herramientas del cliente por la via nativa de Qwen: upstream
// streamea `delta.function_call` con `arguments` como SNAPSHOT acumulativo (el final
// llega dos veces, sin function_id, phase "answer"), la plataforma inyecta
// `role:function "Tool X does not exists."` y el modelo narra que no tiene herramientas.
// Antes cada frame se hacia push() en index 0 con `+=` → JSON invalido → invalid_tool_call
// → retry quemado. Fixtures byte-fieles a scratchpad/capture-foreign.txt (2026-09-01).

const { createNativeToolCallAccumulator: createNativeAccumulatorForIndexPin } = require('../src/utils/tool-prompt.js')

const agentNativeCallFrame = (name, snapshot) => `data: ${JSON.stringify({
  choices: [{
    delta: {
      role: 'assistant',
      content: '',
      phase: 'answer',
      status: 'typing',
      function_call: { name, arguments: snapshot },
      extra: { display_position: 'answer' }
    },
    finish_reason: null
  }]
})}\n\n`

// Lookup del registry de la plataforma: role function, punto final incluido, name.
const agentNotExistsFrame = (name) => `data: ${JSON.stringify({
  choices: [{
    delta: { role: 'function', content: `Tool ${name} does not exists.`, phase: 'answer', status: 'typing', name },
    finish_reason: null
  }]
})}\n\n`

// Herramienta de PLATAFORMA (code_interpreter): phase propia + function_id round_N_call_<hex>.
const agentPlatformCallFrame = (name, snapshot, id) => `data: ${JSON.stringify({
  choices: [{
    delta: {
      role: 'assistant',
      content: '',
      phase: name,
      status: 'typing',
      function_call: { name, arguments: snapshot },
      function_id: id,
      extra: { display_position: 'answer' }
    },
    finish_reason: null
  }]
})}\n\n`

const agentPlatformResultFrame = (name, id, toolResult) => `data: ${JSON.stringify({
  choices: [{
    delta: {
      role: 'function',
      content: '',
      phase: name,
      status: 'finished',
      name,
      extra: { function_id: id.replace(/^round_\d+_/, ''), tool_result: toolResult, code_interpreter_info: toolResult, display_position: 'answer' },
      function_id: id
    },
    finish_reason: null
  }]
})}\n\n`

// Frame #45 de la captura: fin de la respuesta (status finished, sin finish_reason).
const AGENT_FINISHED_FRAME = `data: ${JSON.stringify({
  choices: [{ delta: { content: '', role: 'assistant', status: 'finished', phase: 'answer' }, finish_reason: null }]
})}\n\n`

const NATIVE_SEND_MESSAGE_ARGS = '{"to": "riky", "message": "build is green"}'
const NATIVE_SEND_MESSAGE_SNAPSHOTS = [
  '', '{"to": ', '{"to": "riky', '{"to": "riky"', '{"to": "riky", "message": ',
  '{"to": "riky", "message": "build is green', '{"to": "riky", "message": "build is green"',
  NATIVE_SEND_MESSAGE_ARGS, NATIVE_SEND_MESSAGE_ARGS
]
const NATIVE_BASH_ARGS = '{"command": "git status", "description": "Check git status on user\'s machine"}'
const NATIVE_BASH_SNAPSHOTS = [
  '', '{"command": ', '{"command": "git status', '{"command": "git status"',
  '{"command": "git status", "description": "Check',
  '{"command": "git status", "description": "Check git status on user',
  '{"command": "git status", "description": "Check git status on user\'s machine',
  '{"command": "git status", "description": "Check git status on user\'s machine"',
  NATIVE_BASH_ARGS, NATIVE_BASH_ARGS
]
const nativeAgentTurn = (name, snapshots) => snapshots.map(snapshot => agentNativeCallFrame(name, snapshot))

// Narracion de la captura (#23-#42).
const NATIVE_NARRATION_FRAMES = [
  'The', ' required', ' tools `SendMessage`', ' and `Bash', '` are not available',
  ' in my current environment', '. I', ' only have access to', ' `code_interpreter',
  '`, `web_search', '`, `web_extractor', '`, and `web', '_search_image`. Therefore',
  ', I cannot send', ' a', ' message to teammate "', 'riky" or', ' run `git status',
  '` on your machine', '.'
].map(agentAnswerFrame)
const NATIVE_NARRATION_MARKER = 'not available in my current environment'

const NATIVE_FOREIGN_FRAMES = [
  ...nativeAgentTurn('SendMessage', NATIVE_SEND_MESSAGE_SNAPSHOTS),
  ...nativeAgentTurn('Bash', NATIVE_BASH_SNAPSHOTS),
  agentNotExistsFrame('SendMessage'),
  agentNotExistsFrame('Bash'),
  ...NATIVE_NARRATION_FRAMES,
  AGENT_FINISHED_FRAME
]

// Plataforma: forma y function_id de OTRA captura (variante 'natural', frames #2-#12 — ver el
// header de tests/anthropic-native-toolcall.test.js); la lista de snapshots esta abreviada.
const CODE_INTERPRETER_ID = 'round_0_call_45542fe59a8346bf888dd458'
const CODE_INTERPRETER_SNAPSHOTS = ['', '{"code": "ls', '{"code": "ls -1 /tmp"}', '{"code": "ls -1 /tmp"}']

/**
 * Upstream que registra cada frame que el consumidor le PIDE. Generador crudo a proposito:
 * Readable.from pre-cargaria hasta highWaterMark objetos y served[] mentiria.
 */
const recordingAgentUpstream = (frames) => {
  const served = []
  async function * gen () {
    for (const frame of frames) {
      served.push(frame)
      yield frame
    }
  }
  return { served, stream: gen() }
}

const NATIVE_TOOLS = ['SendMessage', 'Bash']
const neverSend = () => { const fn = async () => { fn.calls += 1; return { status: false } }; fn.calls = 0; return fn }

test('OpenAI loop: los function_call nativos se promueven a tool_calls, cero retries, la narracion no llega', async () => {
  const sender = neverSend()
  const upstream = recordingAgentUpstream([...NATIVE_FOREIGN_FRAMES, 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'])
  const result = await runOpenAIAgentTurn(upstream.stream, {
    has_tools: true,
    tool_choice: 'auto',
    allowed_tool_names: NATIVE_TOOLS,
    agent_turn_max_attempts: 3,
    upstream_request_body: { messages: [{ role: 'user', content: 'do the task' }] },
    sendChatRequest: sender
  })

  assert.equal(sender.calls, 0, 'una promocion nativa no puede quemar retries')
  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(result.attempt.toolCalls.map(call => call.function.name), ['SendMessage', 'Bash'])
  assert.equal(result.attempt.toolCalls[0].function.arguments, NATIVE_SEND_MESSAGE_ARGS, 'arguments = snapshot final exacto')
  assert.equal(result.attempt.toolCalls[1].function.arguments, NATIVE_BASH_ARGS, 'arguments = snapshot final exacto')
  assert.deepEqual(result.attempt.toolCalls.map(call => call.index), [0, 1])
  assert.equal(result.attempt.nativeToolCalls.length, 2)
  assert.doesNotMatch(result.attempt.rawAnswer, new RegExp(NATIVE_NARRATION_MARKER), 'la narracion post-promocion es el eco del "does not exists"')
  assert.equal(result.attempt.visibleText.trim(), '')
  assert.equal(result.attempt.upstreamCompleted, true, 'el corte temprano no es una falla de transporte')
  // Corte temprano: el lote esta completo (2 calls, 2 result frames) y la primera prosa lo dispara.
  const narrationServed = upstream.served.filter(frame => NATIVE_NARRATION_FRAMES.includes(frame))
  assert.equal(narrationServed.length, 1, 'solo la primera prosa de la narracion debe pedirse al upstream')
  assert.ok(!upstream.served.includes(AGENT_FINISHED_FRAME), 'el upstream siguio consumiendose hasta el final')
})

// F5: espejo de anthropic.js (commit 58f56fd) — tras la paridad del lote, el PRIMER frame con
// contenido del modelo (think O answer) es el arranque de la narracion. En prod (18:05Z) el
// modelo penso 54s mas antes de abrir la boca; esperar la prosa hacia esperar al cliente.
const agentThinkFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'think', content }, finish_reason: null }]
})}\n\n`

test('OpenAI loop (F5): paridad → cinco frames think → prosa: el upstream se corta en el PRIMER think', async () => {
  const sender = neverSend()
  const thinkTail = ['The tools', ' seem to be', ' missing,', ' let me', ' reconsider...'].map(agentThinkFrame)
  const frames = [
    ...nativeAgentTurn('SendMessage', NATIVE_SEND_MESSAGE_SNAPSHOTS),
    ...nativeAgentTurn('Bash', NATIVE_BASH_SNAPSHOTS),
    agentNotExistsFrame('SendMessage'),
    agentNotExistsFrame('Bash'),
    ...thinkTail,
    ...NATIVE_NARRATION_FRAMES,
    AGENT_FINISHED_FRAME,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  ]
  const upstream = recordingAgentUpstream(frames)
  const result = await runOpenAIAgentTurn(upstream.stream, {
    has_tools: true,
    tool_choice: 'auto',
    allowed_tool_names: NATIVE_TOOLS,
    agent_turn_max_attempts: 3,
    upstream_request_body: { messages: [{ role: 'user', content: 'do the task' }] },
    sendChatRequest: sender
  })

  assert.equal(sender.calls, 0)
  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(result.attempt.toolCalls.map(call => call.function.name), ['SendMessage', 'Bash'])
  const parityAt = frames.indexOf(agentNotExistsFrame('Bash'))
  assert.equal(upstream.served.length, parityAt + 2, `must stop on the first think frame after parity, served ${upstream.served.length}`)
  assert.equal(upstream.served[upstream.served.length - 1], thinkTail[0], 'the stop frame is the first think frame')
  assert.doesNotMatch(result.attempt.reasoning, /reconsider/, 'post-parity thinking is discarded')
})

test('OpenAI loop: prosa ANTES de los frames nativos se conserva como visibleText junto a los tool_calls', async () => {
  const sender = neverSend()
  const result = await runAgentTurn(
    [agentAnswerFrame('Let me check.'), ...NATIVE_FOREIGN_FRAMES],
    sender,
    { allowed_tool_names: NATIVE_TOOLS }
  )
  assert.equal(sender.calls, 0)
  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'tool_calls', 'la prosa previa no puede tumbar una llamada nativa (no se toca AGENT_TURN_ALLOW_PROSE_WITH_TOOLS)')
  assert.deepEqual(result.attempt.toolCalls.map(call => call.function.name), ['SendMessage', 'Bash'])
  assert.equal(result.attempt.visibleText, 'Let me check.')
  assert.doesNotMatch(result.attempt.rawAnswer, new RegExp(NATIVE_NARRATION_MARKER))
})

// El [TOOL CALL] textual va ANTES de los frames nativos a proposito: despues del lote
// completo la primera prosa dispara el corte temprano y el texto ni se lee. Con el texto
// primero ambos canales producen el mismo Bash: el nativo supersede (F1) y queda uno.
test('OpenAI loop: [TOOL CALL] textual + nativo del mismo Bash con los mismos args → una sola llamada', async () => {
  const sender = neverSend()
  const shuffled = JSON.parse(NATIVE_BASH_ARGS)
  const textCall = `[TOOL CALL]{"name":"Bash","arguments":{"description":${JSON.stringify(shuffled.description)},"command":${JSON.stringify(shuffled.command)}}}[END TOOL CALL]`
  const result = await runAgentTurn(
    [agentAnswerFrame(textCall), ...nativeAgentTurn('Bash', NATIVE_BASH_SNAPSHOTS), agentNotExistsFrame('Bash')],
    sender,
    { allowed_tool_names: NATIVE_TOOLS }
  )
  assert.equal(sender.calls, 0)
  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(result.attempt.toolCalls.length, 1, 'el duplicado cruzado se descarta')
  assert.equal(result.attempt.toolCalls[0].function.name, 'Bash')
  assert.equal(result.attempt.toolCalls[0].function.arguments, NATIVE_BASH_ARGS, 'gana el nativo (cierra primero); el textual es la copia')
})

// F1: el canal nativo SUPERSEDE al textual — semantica pre-diff de este runtime
// (`nativeToolCalls.length > 0 ? nativeToolCalls : textTools.toolCalls`). Fusionar ambos
// canales dejaba ejecutar un [TOOL CALL] textual destructivo junto al Bash nativo distinto.
// Este runtime bufferiza toda la ronda, asi que PUEDE descartar el textual (anthropic.js
// emite el textual inline y no puede retirarlo).
test('OpenAI loop: nativo + [TOOL CALL] textual DISTINTOS en la misma ronda → solo el nativo, un warn', async () => {
  const sender = neverSend()
  const savedWarn = logger.warn
  const warnLines = []
  logger.warn = (msg) => { warnLines.push(String(msg)) }
  let result
  try {
    result = await runAgentTurn(
      [
        agentAnswerFrame('[TOOL CALL]{"name":"Bash","arguments":{"command":"rm -rf build"}}[END TOOL CALL]'),
        ...nativeAgentTurn('Bash', ['', '{"command": ', '{"command": "git status"}', '{"command": "git status"}']),
        agentNotExistsFrame('Bash')
      ],
      sender,
      { allowed_tool_names: NATIVE_TOOLS }
    )
  } finally {
    logger.warn = savedWarn
  }
  assert.equal(sender.calls, 0)
  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(
    result.attempt.toolCalls.map(call => [call.function.name, call.function.arguments]),
    [['Bash', '{"command": "git status"}']],
    'el textual "rm -rf build" jamas debe ejecutarse junto al nativo'
  )
  assert.deepEqual(result.attempt.toolCalls.map(call => call.index), [0])
  assert.equal(warnLines.filter(line => /文本通道/.test(line)).length, 1, `expected ONE precedence warn, got:\n${warnLines.join('\n')}`)
})

// Misma precedencia con nombres distintos: texto Read + nativo Bash → solo Bash. (Antes de
// F1 este test pinaba "dos llamadas con index unico [0,1]"; el index unico cruzado sigue
// pinado donde si aplica, en chat.js legacy mas abajo.)
test('OpenAI loop: texto Read + nativo Bash en la misma ronda → solo el nativo Bash', async () => {
  const sender = neverSend()
  const result = await runAgentTurn(
    [
      agentAnswerFrame('[TOOL CALL]{"name":"Read","arguments":{"path":"a.txt"}}[END TOOL CALL]'),
      ...nativeAgentTurn('Bash', NATIVE_BASH_SNAPSHOTS),
      agentNotExistsFrame('Bash')
    ],
    sender,
    { allowed_tool_names: ['Read', 'Bash'] }
  )
  assert.equal(sender.calls, 0)
  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(result.attempt.toolCalls.map(call => call.function.name), ['Bash'])
  assert.deepEqual(result.attempt.toolCalls.map(call => call.index), [0])
})

// Cinturon bajo el tirante del corte temprano: si los result frames nunca llegan, la
// primera prosa cierra la llamada abierta (se promueve igual), el lote nunca esta "completo"
// (no hay corte temprano) y la narracion posterior se descarta en la recoleccion.
test('OpenAI loop: sin result frames la prosa cierra la llamada nativa; no hay corte temprano y la narracion no entra', async () => {
  const sender = neverSend()
  const frames = [...nativeAgentTurn('Bash', NATIVE_BASH_SNAPSHOTS), ...NATIVE_NARRATION_FRAMES, AGENT_FINISHED_FRAME]
  const upstream = recordingAgentUpstream([...frames, 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'])
  const result = await runOpenAIAgentTurn(upstream.stream, {
    has_tools: true,
    tool_choice: 'auto',
    allowed_tool_names: NATIVE_TOOLS,
    agent_turn_max_attempts: 3,
    upstream_request_body: { messages: [{ role: 'user', content: 'do the task' }] },
    sendChatRequest: sender
  })
  assert.equal(sender.calls, 0)
  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(result.attempt.toolCalls.map(call => call.function.name), ['Bash'])
  assert.equal(result.attempt.toolCalls[0].function.arguments, NATIVE_BASH_ARGS)
  assert.equal(upstream.served.length, frames.length + 1, 'sin paridad de result frames no hay corte temprano')
  assert.doesNotMatch(result.attempt.rawAnswer, new RegExp(NATIVE_NARRATION_MARKER), 'la narracion post-promocion se descarta aunque no haya corte')
  assert.equal(result.attempt.visibleText.trim(), '')
})

test('OpenAI loop: la ronda de code_interpreter (plataforma) sigue siendo invalid_tool_call con retry, sin corte temprano', async () => {
  const sent = []
  const frames = [
    ...CODE_INTERPRETER_SNAPSHOTS.map(snapshot => agentPlatformCallFrame('code_interpreter', snapshot, CODE_INTERPRETER_ID)),
    agentPlatformResultFrame('code_interpreter', CODE_INTERPRETER_ID, '```\nCount: 1\n```'),
    agentAnswerFrame('There is 1 file in /tmp.'),
    AGENT_FINISHED_FRAME,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  ]
  const upstream = recordingAgentUpstream(frames)
  const result = await runOpenAIAgentTurn(upstream.stream, {
    has_tools: true,
    tool_choice: 'auto',
    allowed_tool_names: ['Bash'],
    agent_turn_max_attempts: 3,
    upstream_request_body: { messages: [{ role: 'user', content: 'do the task' }] },
    sendChatRequest: async (body) => {
      sent.push(body)
      return { status: true, response: agentTurnStream(agentAnswerFrame('[TOOL CALL]{"name":"Bash","arguments":{"command":"ls"}}[END TOOL CALL]')) }
    }
  })
  assert.equal(sent.length, 1, 'una llamada de plataforma es unknown_tool → un retry, como hoy')
  assert.match(JSON.stringify(sent[0]), /invalid, truncated, or unknown tool call/)
  assert.equal(result.ok, true)
  assert.equal(result.attempt.toolCalls[0].function.name, 'Bash')
  assert.equal(upstream.served.length, frames.length, 'las llamadas de plataforma no cuentan para el corte temprano')
})

// P5: la aceptacion por nativo va ANTES del veto de toolErrors. Una llamada de plataforma en la
// misma ronda deja un unknown_tool (origen nativo, no textual) en toolErrors; si el veto fuera
// primero, la ronda con el Bash promovido se rechazaria y quemaria un retry.
test('OpenAI loop (P5): plataforma (unknown_tool) + nativo Bash promovido en la misma ronda → aceptada sin retry, toolErrors no vacio', async () => {
  const sender = neverSend()
  const result = await runAgentTurn(
    [
      ...CODE_INTERPRETER_SNAPSHOTS.map(snapshot => agentPlatformCallFrame('code_interpreter', snapshot, CODE_INTERPRETER_ID)),
      agentPlatformResultFrame('code_interpreter', CODE_INTERPRETER_ID, '```\nCount: 1\n```'),
      ...nativeAgentTurn('Bash', NATIVE_BASH_SNAPSHOTS),
      agentNotExistsFrame('Bash'),
      agentAnswerFrame('There is 1 file in /tmp.')
    ],
    sender,
    { allowed_tool_names: ['Bash'] }
  )
  assert.equal(sender.calls, 0, 'un unknown_tool de origen nativo no puede vetar una ronda con promocion')
  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(result.attempt.toolCalls.map(call => call.function.name), ['Bash'])
  assert.deepEqual(result.attempt.toolErrors, [{ type: 'unknown_tool', name: 'code_interpreter' }])
  assert.deepEqual(result.attempt.textToolErrors, [], 'el error es de origen nativo: el content limpio sigue saliendo (F2 no aplica)')
  assert.equal(result.suppressVisibleText, false)
})

test('OpenAI loop: allowlist vacia → fail closed, cero tool_calls, un retry (gemelo R2)', async () => {
  let sent = 0
  const result = await runAgentTurn(
    [...nativeAgentTurn('Bash', NATIVE_BASH_SNAPSHOTS), agentNotExistsFrame('Bash'), ...NATIVE_NARRATION_FRAMES, AGENT_FINISHED_FRAME],
    async () => { sent += 1; return { status: false } },
    { allowed_tool_names: [] }
  )
  assert.equal(sent, 1, 'sin allowlist nada se promueve; la ronda se rechaza y reintenta una vez')
  assert.equal(result.ok, false)
  assert.equal(result.attempt.toolCalls.length, 0)
})

// e2e por handleStreamResponse (turn gate): la prosa previa sale como content y los dos
// tool_calls siguen; la narracion no aparece en el wire.
test('OpenAI stream e2e: prosa previa + tool_calls nativos en el wire, sin narracion', async () => {
  let retries = 0
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from([agentAnswerFrame('Let me check.'), ...NATIVE_FOREIGN_FRAMES]),
    false,
    false,
    { messages: [{ role: 'user', content: 'do the task' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: NATIVE_TOOLS,
      sendChatRequest: async () => { retries += 1; return { status: false } }
    }
  )
  assert.equal(retries, 0)
  const chunks = res.output.split('\n\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)))
  const headers = chunks.flatMap(chunk => (chunk.choices?.[0]?.delta?.tool_calls || []).filter(call => call.id))
  assert.deepEqual(headers.map(call => call.function.name), ['SendMessage', 'Bash'])
  assert.deepEqual(headers.map(call => call.index), [0, 1])
  const content = chunks.map(chunk => chunk.choices?.[0]?.delta?.content || '').join('')
  assert.equal(content, 'Let me check.')
  assert.doesNotMatch(res.output, new RegExp(NATIVE_NARRATION_MARKER))
  assert.match(res.output, /"finish_reason":"tool_calls"/)
})

// F2: la aceptacion por nativo se salta el veto de toolErrors y containsOrphanProtocolResidue
// a proposito (la llamada estructurada vale mas), pero el visibleText de esa ronda puede
// traer un [TOOL CALL] textual roto. Ese texto NO se reenvia como content junto a los
// tool_calls: content vacio, tool_calls intactos. La prosa limpia previa sigue saliendo
// (test anterior + el gemelo no-stream de abajo).
const TAINTED_PROSE = 'Sure. [TOOL CALL]{"name":"Bash","arguments":{"command":[END TOOL CALL]'
const NATIVE_GIT_STATUS_SNAPSHOTS = ['', '{"command": ', '{"command": "git status"}', '{"command": "git status"}']

test('OpenAI stream e2e (F2): [TOOL CALL] textual roto + nativo aceptado → content vacio, tool_calls presentes', async () => {
  let retries = 0
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from([
      agentAnswerFrame(TAINTED_PROSE),
      ...nativeAgentTurn('Bash', NATIVE_GIT_STATUS_SNAPSHOTS),
      agentNotExistsFrame('Bash'),
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    ]),
    false,
    false,
    { messages: [{ role: 'user', content: 'do the task' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: NATIVE_TOOLS,
      sendChatRequest: async () => { retries += 1; return { status: false } }
    }
  )
  assert.equal(retries, 0, 'la aceptacion por nativo sigue sin quemar retries')
  const chunks = res.output.split('\n\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)))
  const headers = chunks.flatMap(chunk => (chunk.choices?.[0]?.delta?.tool_calls || []).filter(call => call.id))
  assert.deepEqual(headers.map(call => call.function.name), ['Bash'])
  const content = chunks.map(chunk => chunk.choices?.[0]?.delta?.content || '').join('')
  assert.equal(content, '', 'el residuo de protocolo jamas llega al cliente junto a los tool_calls')
  assert.doesNotMatch(res.output, /TOOL CALL/)
  assert.match(res.output, /"finish_reason":"tool_calls"/)
})

test('OpenAI non-stream e2e (F2): texto contaminado → content null; prosa limpia → content junto a tool_calls', async () => {
  const runNonStream = async (firstFrame) => {
    const res = createMockResponse()
    await handleNonStreamResponse(
      res,
      Readable.from([
        agentAnswerFrame(firstFrame),
        ...nativeAgentTurn('Bash', NATIVE_GIT_STATUS_SNAPSHOTS),
        agentNotExistsFrame('Bash'),
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
      ]),
      false,
      false,
      'qwen-test',
      { messages: [{ role: 'user', content: 'do the task' }] },
      {
        has_tools: true,
        tool_choice: 'auto',
        allowed_tool_names: NATIVE_TOOLS,
        sendChatRequest: async () => ({ status: false })
      }
    )
    return JSON.parse(res.output).choices[0]
  }

  const tainted = await runNonStream(TAINTED_PROSE)
  assert.equal(tainted.finish_reason, 'tool_calls')
  assert.deepEqual(tainted.message.tool_calls.map(call => call.function.name), ['Bash'])
  assert.equal(tainted.message.content, null, 'texto con residuo de protocolo → sin content')

  const clean = await runNonStream('Let me check.')
  assert.equal(clean.finish_reason, 'tool_calls')
  assert.deepEqual(clean.message.tool_calls.map(call => call.function.name), ['Bash'])
  assert.equal(clean.message.content, 'Let me check.', 'la prosa limpia previa a la llamada sigue saliendo')
})

// ── chat.js legacy (strict_agent_turn: false): feed nativo, index unico, retry limpio ──

const legacyToolCallHeaders = (output) => output
  .split('\n\n')
  .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
  .map(line => JSON.parse(line.slice(6)))
  .flatMap(chunk => (chunk.choices?.[0]?.delta?.tool_calls || []))

const legacyArgsOf = (deltas, index) => deltas
  .filter(call => call.index === index && !call.id)
  .map(call => call.function.arguments)
  .join('')

const runLegacyStream = async (frames, options = {}) => {
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from(frames),
    false,
    false,
    { messages: [{ role: 'user', content: 'do the task' }] },
    { has_tools: true, strict_agent_turn: false, tool_choice: 'auto', allowed_tool_names: NATIVE_TOOLS, ...options }
  )
  return res
}

test('chat.js legacy stream: una llamada nativa produce exactamente un header tool_calls[0] con los arguments exactos', async () => {
  const res = await runLegacyStream([
    ...nativeAgentTurn('Bash', NATIVE_BASH_SNAPSHOTS),
    agentNotExistsFrame('Bash'),
    AGENT_FINISHED_FRAME,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  ])
  assert.doesNotMatch(res.output, /invalid_tool_call/)
  const deltas = legacyToolCallHeaders(res.output)
  const headers = deltas.filter(call => call.id)
  assert.equal(headers.length, 1, 'un snapshot repetido no puede abrir una segunda llamada')
  assert.equal(headers[0].index, 0)
  assert.equal(headers[0].function.name, 'Bash')
  assert.equal(legacyArgsOf(deltas, 0), NATIVE_BASH_ARGS)
  assert.match(res.output, /"finish_reason":"tool_calls"/)
})

test('chat.js legacy stream: la llamada textual y la nativa no pueden ser ambas tool_calls[0]', async () => {
  const res = await runLegacyStream([
    agentAnswerFrame('[TOOL CALL]{"name":"Bash","arguments":{"command":"ls"}}[END TOOL CALL]'),
    ...nativeAgentTurn('Bash', NATIVE_BASH_SNAPSHOTS),
    agentNotExistsFrame('Bash'),
    AGENT_FINISHED_FRAME,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  ])
  const deltas = legacyToolCallHeaders(res.output)
  const headers = deltas.filter(call => call.id)
  assert.deepEqual(headers.map(call => call.function.name), ['Bash', 'Bash'])
  assert.deepEqual(headers.map(call => call.index), [0, 1], 'el caller es dueno del unico index monotono')
  assert.equal(legacyArgsOf(deltas, 0), '{"command":"ls"}')
  assert.equal(legacyArgsOf(deltas, 1), NATIVE_BASH_ARGS)
  // El accumulator por si solo sigue numerando desde 0: la unificacion vive en el caller.
  const twin = createNativeAccumulatorForIndexPin({ allowedToolNames: NATIVE_TOOLS })
  twin.pushNativeSnapshot({ name: 'Bash', arguments: NATIVE_BASH_ARGS, phase: 'answer' })
  assert.equal(twin.finalize()[0].index, 0)
})

test('chat.js legacy stream: el retry de compensacion recrea parser y accumulator — el fragmento de la ronda 1 no reaparece', async () => {
  let sent = 0
  const res = await runLegacyStream(
    [
      agentAnswerFrame('[TOOL CALL]{"name":"Bash","arg'),
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    ],
    {
      tool_choice: 'required',
      sendChatRequest: async () => {
        sent += 1
        return {
          status: true,
          response: Readable.from([
            agentAnswerFrame('[TOOL CALL]{"name":"Bash","arguments":{"command":"ls"}}[END TOOL CALL]'),
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
          ])
        }
      }
    }
  )
  assert.equal(sent, 1, 'tool_choice=required sin llamada dispara la compensacion')
  assert.doesNotMatch(res.output, /invalid_tool_call/, 'el fragmento de la ronda 1 contamino el parser de la ronda 2')
  const deltas = legacyToolCallHeaders(res.output)
  const headers = deltas.filter(call => call.id)
  assert.equal(headers.length, 1)
  assert.equal(headers[0].function.name, 'Bash')
  assert.equal(legacyArgsOf(deltas, headers[0].index), '{"command":"ls"}')
  assert.match(res.output, /"finish_reason":"tool_calls"/)
})
