const { StringDecoder } = require('node:string_decoder')

/**
 * 解析单个 SSE frame。
 * 支持 event/id/retry 以及多行 data 字段；注释行会被忽略。
 * @param {string} rawFrame
 * @returns {{event: string|null, data: string, id: string|null, retry: number|null, raw: string}|null}
 */
const parseSSEFrame = (rawFrame) => {
    if (typeof rawFrame !== 'string') return null

    let event = null
    let id = null
    let retry = null
    const dataLines = []
    let hasField = false

    for (const line of rawFrame.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue

        const colonIndex = line.indexOf(':')
        const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
        let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
        if (value.startsWith(' ')) value = value.slice(1)

        if (field === 'data') {
            dataLines.push(value)
            hasField = true
        } else if (field === 'event') {
            event = value || null
            hasField = true
        } else if (field === 'id') {
            id = value
            hasField = true
        } else if (field === 'retry') {
            const parsedRetry = Number.parseInt(value, 10)
            retry = Number.isFinite(parsedRetry) ? parsedRetry : null
            hasField = true
        }
    }

    if (!hasField) {
        // Qwen 的 WAF/业务失败偶尔以 HTTP 200 + 裸 JSON 返回，而不是 SSE data 字段。
        // 将完整 JSON 作为一个 data frame 交给上层分类，避免被当成“0 个事件的正常 EOF”。
        const trimmed = rawFrame.trim()
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                JSON.parse(trimmed)
                return { event: null, data: trimmed, id: null, retry: null, raw: rawFrame }
            } catch (_) {
                // 非完整 JSON 继续按无效 SSE 忽略。
            }
        }
        return null
    }
    return { event, data: dataLines.join('\n'), id, retry, raw: rawFrame }
}

/**
 * 增量 SSE 解码器。TCP 分块可以落在 UTF-8 字符、字段名、JSON 或空行中的任意位置。
 */
class SSEDecoder {
    constructor() {
        this.decoder = new StringDecoder('utf8')
        this.buffer = ''
    }

    /**
     * @param {Buffer|string|Uint8Array} chunk
     * @returns {Array<ReturnType<typeof parseSSEFrame>>}
     */
    push(chunk) {
        if (chunk !== undefined && chunk !== null) {
            this.buffer += typeof chunk === 'string'
                ? chunk
                : this.decoder.write(Buffer.from(chunk))
        }
        return this.#drain(false)
    }

    /**
     * 冲刷 UTF-8 decoder，并按 SSE 规范分派 EOF 前尚未带空行的最后一个事件。
     * @returns {Array<ReturnType<typeof parseSSEFrame>>}
     */
    end() {
        this.buffer += this.decoder.end()
        return this.#drain(true)
    }

    #drain(flush) {
        const frames = []

        while (this.buffer.length > 0) {
            const boundary = this.buffer.match(/\r?\n\r?\n/)
            if (!boundary || boundary.index === undefined) break

            const rawFrame = this.buffer.slice(0, boundary.index)
            this.buffer = this.buffer.slice(boundary.index + boundary[0].length)
            const parsed = parseSSEFrame(rawFrame)
            if (parsed) frames.push(parsed)
        }

        if (flush && this.buffer.trim()) {
            const parsed = parseSSEFrame(this.buffer)
            if (parsed) frames.push(parsed)
            this.buffer = ''
        }

        return frames
    }
}

/**
 * 把解析后的事件重新编码为规范 SSE。用于安全透传，不依赖上游 TCP 分块方式。
 * @param {{event?: string|null, data?: string, id?: string|null, retry?: number|null}} frame
 * @returns {string}
 */
const formatSSEFrame = (frame = {}) => {
    const lines = []
    if (frame.event) lines.push(`event: ${frame.event}`)
    if (frame.id !== null && frame.id !== undefined) lines.push(`id: ${frame.id}`)
    if (frame.retry !== null && frame.retry !== undefined) lines.push(`retry: ${frame.retry}`)

    const data = typeof frame.data === 'string' ? frame.data : String(frame.data ?? '')
    for (const line of data.split('\n')) {
        lines.push(`data: ${line}`)
    }
    return `${lines.join('\n')}\n\n`
}

/**
 * 串行消费 Node readable 中的 SSE。for-await 会等待 onFrame，避免 end 事件越过异步 data handler。
 * @param {AsyncIterable<Buffer|string>} stream
 * @param {(frame: ReturnType<typeof parseSSEFrame>) => Promise<void>|void} onFrame
 * @param {{ shouldStop?: () => boolean }} [options]
 * 正常迭代结束代表 HTTP 响应体被完整消费。真正的连接重置、premature close
 * 或解压失败会由 for-await 抛出，不能把“没有 [DONE]”等同于传输中断：
 * Qwen 网页端的正常流本来就可能以干净 EOF 收尾。
 *
 * options.shouldStop：每帧 onFrame 结束后询问一次；返回 true 则消费者自己 `break`
 * 出 for-await —— 异步迭代器的 return() 会干净地销毁 axios 流，不需要 AbortController，
 * 也绝不能在 onFrame 里 destroy()（那会以 ERR_STREAM_PREMATURE_CLOSE 重新抛出）。
 * break 前先挂一个空的 'error' 监听：解压管道在销毁时可能补发一个 error 事件。
 * 这样收尾的流 completed 仍为 true —— completed 只表示"没有传输故障"，主动截断不是故障；
 * 同一 chunk 里排在停止帧之后的帧被丢弃（那正是要丢的叙述），decoder.end() 不再调用。
 * @returns {Promise<{sawDone: boolean, eventCount: number, completed: boolean, stopped: boolean}>}
 */
const consumeSSEStream = async (stream, onFrame, options = {}) => {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw new TypeError('上游响应不是可读取的异步流')
    }

    const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : null
    const decoder = new SSEDecoder()
    let sawDone = false
    let eventCount = 0
    let stopped = false

    const consumeFrames = async (frames) => {
        for (const frame of frames) {
            eventCount += 1
            if (frame.data.trim() === '[DONE]') sawDone = true
            await onFrame(frame)
            if (shouldStop && shouldStop()) {
                stopped = true
                return
            }
        }
    }

    for await (const chunk of stream) {
        await consumeFrames(decoder.push(chunk))
        if (stopped) {
            if (typeof stream.on === 'function') stream.on('error', () => {})
            break
        }
    }
    if (!stopped) await consumeFrames(decoder.end())

    return { sawDone, eventCount, completed: true, stopped }
}

/**
 * 创建上游并发响应过滤器。
 * 上游偶尔会对同一次请求开启多路候选回答：先连续下发多个 response.created
 * （chat_id/parent_id 相同，response_index 为 "0"/"1"，各自 response_id 不同），
 * 随后两路增量帧交错到达。解析时不区分 response_id 就会把两路内容拼到一起，
 * 回答被复读（"巴黎巴黎"）。新版协议优先锁定 response_index=0 的官方主回答；
 * 只有旧协议缺少 response.created 元数据时，才退回锁定第一路正文。
 * 上游完全不带 response_id 时一律放行。
 * @returns {(json: object) => boolean} true 表示该帧属于已锁定的那一路，应继续处理
 */
const createUpstreamResponseFilter = () => {
    let acceptedId = null
    let sawCreatedEvent = false
    const responseIndexes = new Map()
    return (json) => {
        const created = json?.['response.created'] || json?.response?.created
        if (created && typeof created === 'object') {
            sawCreatedEvent = true
            const responseId = created.response_id || created.responseId || null
            const responseIndex = Number(created.response_index ?? created.responseIndex)
            if (responseId && Number.isFinite(responseIndex)) {
                responseIndexes.set(responseId, responseIndex)
            }
            // 网页端定义 response_index=0 为主回答。不能按“谁先吐 delta”抢锁，
            // 否则可能把备用候选当成主回答，并把错误 response_id 用作下一轮 parentId。
            if (responseId && responseIndex === 0) {
                acceptedId = responseId
            } else if (responseId && acceptedId === null && !Number.isFinite(responseIndex)) {
                acceptedId = responseId
            }
            return !responseId || acceptedId === null || responseId === acceptedId
        }

        const responseId = json && json.response_id
        if (!responseId) return true
        if (acceptedId !== null) return responseId === acceptedId

        const responseIndex = responseIndexes.get(responseId)
        if (responseIndex === 0) {
            acceptedId = responseId
            return true
        }
        if (Number.isFinite(responseIndex) || sawCreatedEvent) return false

        // 旧协议没有 response.created，只能锁定第一路带 response_id 的正文。
        acceptedId = responseId
        return true
    }
}

module.exports = {
    SSEDecoder,
    parseSSEFrame,
    formatSSEFrame,
    consumeSSEStream,
    createUpstreamResponseFilter
}
