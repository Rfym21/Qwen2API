const test = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough, Readable } = require('node:stream')

const {
  SSEDecoder,
  consumeSSEStream,
  formatSSEFrame,
  createUpstreamResponseFilter
} = require('../src/utils/sse.js')

test('SSEDecoder handles arbitrary TCP, UTF-8 and CRLF boundaries', () => {
  const decoder = new SSEDecoder()
  const wire = Buffer.from(
    'event: content\r\ndata: {"text":"你好"}\r\n\r\n' +
    'data: first\ndata: second\n\n' +
    'data: [DONE]\n\n'
  )
  const frames = []
  for (let i = 0; i < wire.length; i += 3) {
    frames.push(...decoder.push(wire.subarray(i, i + 3)))
  }
  frames.push(...decoder.end())

  assert.equal(frames.length, 3)
  assert.equal(frames[0].event, 'content')
  assert.equal(frames[0].data, '{"text":"你好"}')
  assert.equal(frames[1].data, 'first\nsecond')
  assert.equal(frames[2].data, '[DONE]')
})

test('SSEDecoder dispatches the final event even without a trailing blank line', () => {
  const decoder = new SSEDecoder()
  assert.deepEqual(decoder.push('data: {"ok":true}'), [])
  const frames = decoder.end()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].data, '{"ok":true}')
})

test('SSEDecoder surfaces HTTP-200 bare JSON business responses', () => {
  const decoder = new SSEDecoder()
  const payload = '{"ret":["FAIL_SYS_USER_VALIDATE"],"success":false}'
  assert.deepEqual(decoder.push(payload), [])
  const frames = decoder.end()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].data, payload)
})

test('consumeSSEStream serializes async handlers before resolving', async () => {
  const stream = new PassThrough()
  const seen = []
  const consuming = consumeSSEStream(stream, async frame => {
    await new Promise(resolve => setTimeout(resolve, 10))
    seen.push(frame.data)
  })

  stream.end('data: one\n\ndata: two\n\ndata: [DONE]\n\n')
  const result = await consuming

  assert.deepEqual(seen, ['one', 'two', '[DONE]'])
  assert.equal(result.sawDone, true)
  assert.equal(result.eventCount, 3)
  assert.equal(result.completed, true)
})

test('consumeSSEStream without shouldStop consumes to EOF and reports stopped=false', async () => {
  const stream = new PassThrough()
  const seen = []
  const consuming = consumeSSEStream(stream, frame => {
    seen.push(frame.data)
  })

  stream.end('data: one\n\ndata: two\n\ndata: [DONE]\n\n')
  const result = await consuming

  assert.deepEqual(seen, ['one', 'two', '[DONE]'])
  assert.equal(result.stopped, false, 'la ruta normal nunca reporta stopped')
  assert.equal(result.completed, true)
})

test('consumeSSEStream stops early on shouldStop, destroys the source and still settles', async () => {
  // El upstream nunca manda [DONE] ni cierra: si el consumidor no corta, la promesa cuelga.
  const stream = new PassThrough()
  const seen = []
  const consuming = consumeSSEStream(stream, frame => {
    seen.push(frame.data)
  }, { shouldStop: () => seen.length >= 2 })

  stream.write('data: one\n\ndata: two\n\ndata: three\n\n')
  const result = await consuming

  assert.deepEqual(seen, ['one', 'two'], 'el frame que dispara el stop es el ultimo entregado')
  assert.equal(result.stopped, true)
  assert.equal(result.completed, true, 'completed = sin fallo de transporte; un corte propio no lo es')
  assert.equal(result.sawDone, false)
  assert.equal(result.eventCount, 2)
  assert.equal(stream.destroyed, true, 'el break del for-await debe destruir la fuente')
})

test('consumeSSEStream with a never-true shouldStop consumes everything and reports stopped=false', async () => {
  const stream = new PassThrough()
  const seen = []
  const consuming = consumeSSEStream(stream, frame => {
    seen.push(frame.data)
  }, { shouldStop: () => false })

  stream.end('data: one\n\ndata: two\n\ndata: [DONE]\n\n')
  const result = await consuming

  assert.deepEqual(seen, ['one', 'two', '[DONE]'])
  assert.equal(result.stopped, false)
  assert.equal(result.completed, true)
  assert.equal(result.sawDone, true)
})

test('formatSSEFrame produces a frame that survives byte-by-byte decoding', async () => {
  const encoded = formatSSEFrame({ event: 'message', data: '第一行\n第二行', id: '42' })
  const frames = []
  await consumeSSEStream(Readable.from([...Buffer.from(encoded)].map(byte => Buffer.from([byte]))), frame => {
    frames.push(frame)
  })
  assert.equal(frames[0].event, 'message')
  assert.equal(frames[0].id, '42')
  assert.equal(frames[0].data, '第一行\n第二行')
})

// 上游偶尔对同一次请求开启多路候选回答，两路帧交错到达；
// 帧样本取自 chat.qwen.ai 实际抓包（问题 #149，回答被复读成 "巴黎巴黎"）。
const DUAL_RESPONSE_FRAMES = [
  '{"response.created":{"chat_id":"d8e2ce75","parent_id":"4cc3a56d","response_id":"4f79335b","response_index":"0"}}',
  '{"response.created":{"chat_id":"d8e2ce75","parent_id":"4cc3a56d","response_id":"4c2b7c86","response_index":"1"}}',
  '{"choices":[{"delta":{"role":"assistant","content":"巴","phase":"answer","status":"typing"}}],"response_id":"4c2b7c86"}',
  '{"choices":[{"delta":{"role":"assistant","content":"巴","phase":"answer","status":"typing"}}],"response_id":"4f79335b"}',
  '{"choices":[{"delta":{"role":"assistant","content":"黎","phase":"answer","status":"typing"}}],"response_id":"4c2b7c86"}',
  '{"choices":[{"delta":{"content":"","role":"assistant","status":"finished","phase":"answer"}}],"response_id":"4c2b7c86"}',
  '{"choices":[{"delta":{"role":"assistant","content":"黎","phase":"answer","status":"typing"}}],"response_id":"4f79335b"}',
  '{"choices":[{"delta":{"content":"","role":"assistant","status":"finished","phase":"answer"}}],"response_id":"4f79335b"}'
]

const collectAnswer = (rawFrames, accept) => {
  let answer = ''
  for (const raw of rawFrames) {
    const json = JSON.parse(raw)
    if (accept && !accept(json)) continue
    if (!json.choices || json.choices.length === 0) continue
    answer += json.choices[0].delta?.content || ''
  }
  return answer
}

test('createUpstreamResponseFilter keeps a single response when upstream opens several', () => {
  // 不过滤时两路内容被拼在一起 —— 这正是 #149 的复读现象
  assert.equal(collectAnswer(DUAL_RESPONSE_FRAMES, null), '巴巴黎黎')
  assert.equal(collectAnswer(DUAL_RESPONSE_FRAMES, createUpstreamResponseFilter()), '巴黎')

  const primaryAndFallbackDiffer = [
    '{"response.created":{"response_id":"primary","response_index":"0"}}',
    '{"response.created":{"response_id":"fallback","response_index":"1"}}',
    '{"choices":[{"delta":{"content":"wrong","phase":"answer"}}],"response_id":"fallback"}',
    '{"choices":[{"delta":{"content":"right","phase":"answer"}}],"response_id":"primary"}'
  ]
  assert.equal(
    collectAnswer(primaryAndFallbackDiffer, createUpstreamResponseFilter()),
    'right'
  )
})

test('createUpstreamResponseFilter passes frames through when upstream sends no response_id', () => {
  const legacyFrames = [
    '{"choices":[{"delta":{"role":"assistant","content":"巴","phase":"answer"}}]}',
    '{"choices":[{"delta":{"role":"assistant","content":"黎","phase":"answer"}}]}'
  ]
  assert.equal(collectAnswer(legacyFrames, createUpstreamResponseFilter()), '巴黎')
})
