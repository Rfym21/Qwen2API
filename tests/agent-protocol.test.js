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
  assert.equal(openAIRetries, 1)
  assert.match(openAIRes.output, /recovered/)
  assert.match(openAIRes.output, /"finish_reason":"stop"/)

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
    JSON.stringify({ role: 'user', content: `<tool_response name="bash">RECENT_PROGRESS_MUST_SURVIVE ${'x'.repeat(5000)}</tool_response>` }),
    '# Current message',
    JSON.stringify({ role: 'user', content: '<tool_response name="bash">CURRENT_RESULT_MUST_SURVIVE</tool_response>' }),
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
      retryReason: 'invalid_tool_call'
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
