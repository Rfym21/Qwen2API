const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

const { consumeSSEStream } = require('../src/utils/sse')

// A mid-stream failure has to say how far the upstream got. The controller decides from
// it whether a retry is safe, and the [EGRESS] log needs the byte count to tell an early
// close (a few KB) from a late one (tens of KB) — the three live closes on 2026-09-16 were
// all late, 63–90 KiB in.

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const socketClose = () => Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })

test('a transport failure mid-stream carries the bytes and frames consumed so far', async () => {
  const first = frame({ a: 1 })
  const failing = Readable.from((async function* () {
    yield Buffer.from(first)
    throw socketClose()
  })())
  const seen = []
  await assert.rejects(
    consumeSSEStream(failing, async (f) => { seen.push(f.data) }),
    (err) => {
      assert.equal(err.code, 'UND_ERR_SOCKET')
      assert.equal(err.upstreamBytesRead, Buffer.byteLength(first))
      assert.equal(err.upstreamEventCount, 1)
      return true
    }
  )
  assert.equal(seen.length, 1, 'the frame before the failure was still delivered')
})

test('a failure before any byte reports zero, not undefined', async () => {
  const failing = new Readable({ read() { this.destroy(socketClose()) } })
  await assert.rejects(consumeSSEStream(failing, async () => {}), (err) => {
    assert.equal(err.upstreamBytesRead, 0)
    assert.equal(err.upstreamEventCount, 0)
    return true
  })
})

test('an onFrame rejection (upstream business error such as RateLimited) is annotated too', async () => {
  const text = frame({ success: false, data: { code: 'RateLimited' } })
  await assert.rejects(
    consumeSSEStream(Readable.from([text]), async () => {
      throw Object.assign(new Error('quota'), { code: 'RateLimited' })
    }),
    (err) => {
      assert.equal(err.code, 'RateLimited')
      assert.equal(err.upstreamBytesRead, Buffer.byteLength(text))
      assert.equal(err.upstreamEventCount, 1)
      return true
    }
  )
})

test('a clean stream reports bytesRead alongside eventCount; string and Buffer chunks count the same', async () => {
  const text = frame({ a: 1 }) + frame({ b: 2 }) + 'data: [DONE]\n\n'
  const asString = await consumeSSEStream(Readable.from([text]), async () => {})
  const asBuffer = await consumeSSEStream(Readable.from([Buffer.from(text)]), async () => {})
  assert.equal(asString.bytesRead, Buffer.byteLength(text))
  assert.equal(asBuffer.bytesRead, Buffer.byteLength(text))
  assert.equal(asString.eventCount, 3)
  assert.equal(asString.sawDone, true)
  assert.equal(asString.completed, true)
})
