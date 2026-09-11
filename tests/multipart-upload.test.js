const assert = require('node:assert/strict')
const { before, after, test } = require('node:test')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { request: requestHttp } = require('node:http')
const express = require('express')
const { createUploadMiddleware } = require('../src/middlewares/upload')

const API_KEY = 'multipart-test-key'
const BOUNDARY = 'qwen-multipart-test-boundary'
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`
const MEDIA_ROUTES = ['/v1/images/edits', '/v1/videos']
let handledRequests = 0

function echoUpload(request, response) {
    handledRequests += 1
    response.json({
        body: request.body,
        files: (request.files || []).map(file => ({
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            content: file.buffer.toString('hex')
        }))
    })
}

function loadOfflineRouter() {
    // Keep real routing, authentication and Multer; never import account/upstream code.
    const stubs = {
        '../src/middlewares/chat-middleware.js': { processRequestBody: echoUpload },
        '../src/controllers/chat.js': { handleChatCompletion: echoUpload },
        '../src/controllers/chat.image.video.js': {
            handleImageVideoCompletion: echoUpload,
            handleOpenAIImagesGeneration: echoUpload,
            handleOpenAIImagesEdit: echoUpload,
            handleOpenAIVideoGeneration: echoUpload
        }
    }
    const isolatedModules = [
        ...Object.keys(stubs), '../src/config/index.js',
        '../src/middlewares/authorization.js', '../src/routes/chat.js'
    ].map(moduleName => require.resolve(moduleName))
    const originalModules = new Map(isolatedModules.map(modulePath => [modulePath, require.cache[modulePath]]))
    const originalDirectory = process.cwd()
    const originalApiKey = process.env.API_KEY
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'qwen-multipart-'))
    try {
        writeFileSync(path.join(temporaryDirectory, '.env'), `API_KEY=${API_KEY}\n`)
        process.chdir(temporaryDirectory)
        delete process.env.API_KEY
        for (const modulePath of isolatedModules) delete require.cache[modulePath]
        for (const [moduleName, exports] of Object.entries(stubs)) {
            const modulePath = require.resolve(moduleName)
            const stub = new Module(modulePath)
            stub.filename = modulePath
            stub.loaded = true
            stub.exports = exports
            require.cache[modulePath] = stub
        }
        return {
            router: require('../src/routes/chat.js'),
            apiKeyVerify: require('../src/middlewares/authorization.js').apiKeyVerify
        }
    } finally {
        process.chdir(originalDirectory)
        if (originalApiKey === undefined) delete process.env.API_KEY
        else process.env.API_KEY = originalApiKey
        for (const [modulePath, originalModule] of originalModules) {
            if (originalModule) require.cache[modulePath] = originalModule
            else delete require.cache[modulePath]
        }
        rmSync(temporaryDirectory, { recursive: true, force: true })
    }
}

function buildMultipart(parts, complete = true) {
    const chunks = []
    for (const part of parts) {
        const filename = part.filename ? `; filename="${part.filename}"` : ''
        const contentType = part.filename ? '\r\nContent-Type: image/png' : ''
        chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"${filename}${contentType}\r\n\r\n`))
        chunks.push(Buffer.from(part.value), Buffer.from('\r\n'))
    }
    if (complete) chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
    return Buffer.concat(chunks)
}

let server
let baseUrl
before(async () => {
    const { router, apiKeyVerify } = loadOfflineRouter()
    const application = express()
    application.use(express.json())
    application.use(router)
    // Small limits exercise the same parser without allocating 100 MiB test files.
    application.post('/limited', apiKeyVerify, createUploadMiddleware({
        fileSize: 8, files: 2, fields: 3, parts: 8,
        fieldSize: 12, fieldNameSize: 24, fieldNestingDepth: 2, fieldArrayIndexLimit: 4
    }), echoUpload)
    application.post('/part-limit', apiKeyVerify, createUploadMiddleware({ parts: 2 }), echoUpload)
    application.get('/health', (request, response) => response.json({ status: 'ok' }))
    server = await new Promise(resolve => {
        const listener = application.listen(0, '127.0.0.1', () => resolve(listener))
    })
    baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
    if (!server) return
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
})

function sendRequest(route, body, { contentType = CONTENT_TYPE, apiKey = API_KEY } = {}) {
    return fetch(`${baseUrl}${route}`, {
        method: 'POST', body, signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': contentType, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }
    })
}

async function assertUploadError(response, status, code) {
    assert.equal(response.status, status)
    assert.match(response.headers.get('content-type'), /application\/json/)
    const payload = await response.json()
    assert.equal(payload.error.type, 'invalid_request_error')
    assert.equal(payload.error.code, code)
    assert.equal(typeof payload.error.message, 'string')
    assert.equal(payload.error.stack, undefined)
}

async function assertResponsive() {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
}

test('both media routes retain multipart fields and memoryStorage file buffers', async () => {
    const image = Buffer.from([0, 255, 13, 10, 42])
    for (const route of MEDIA_ROUTES) {
        const response = await sendRequest(route, buildMultipart([
            { name: 'prompt', value: 'edit this image' },
            { name: 'image', filename: 'reference.png', value: image },
            { name: 'mask', filename: 'mask.png', value: 'mask' }
        ]))
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), {
            body: { prompt: 'edit this image' },
            files: [
                { fieldname: 'image', originalname: 'reference.png', mimetype: 'image/png', size: image.length, content: image.toString('hex') },
                { fieldname: 'mask', originalname: 'mask.png', mimetype: 'image/png', size: 4, content: Buffer.from('mask').toString('hex') }
            ]
        })
    }
})

test('both media routes leave valid JSON bodies unchanged', async () => {
    const body = { prompt: 'edit', image: ['data:image/png;base64,AA=='], model: 'test-model', stream: false }
    for (const route of MEDIA_ROUTES) {
        const response = await sendRequest(route, JSON.stringify(body), { contentType: 'application/json' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { body, files: [] })
    }
})

test('malformed boundaries, headers and truncated streams return JSON 400 without invoking handlers', async () => {
    const malformedRequests = [
        { body: 'missing boundary', contentType: 'multipart/form-data' },
        { body: 'empty boundary', contentType: 'multipart/form-data; boundary=' },
        { body: `--${BOUNDARY}\r\ninvalid header\r\n\r\npayload\r\n--${BOUNDARY}--\r\n` },
        { body: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="image"; filename="partial.png"\r\n` },
        { body: buildMultipart([{ name: 'prompt', value: 'incomplete field' }], false) },
        { body: buildMultipart([
            { name: 'image', filename: 'complete.png', value: 'complete' },
            { name: 'image', filename: 'partial.png', value: 'incomplete file' }
        ], false) }
    ]
    for (const route of MEDIA_ROUTES) {
        for (const malformed of malformedRequests) {
            const previouslyHandled = handledRequests
            await assertUploadError(await sendRequest(route, malformed.body, malformed), 400, 'invalid_multipart')
            assert.equal(handledRequests, previouslyHandled)
            await assertResponsive()
        }
        const recovery = await sendRequest(route, buildMultipart([{ name: 'prompt', value: 'still working' }]))
        assert.equal(recovery.status, 200)
        await recovery.json()
    }
})

test('upload size, count, name and nesting limits return JSON 413', async () => {
    const filePart = { name: 'image', filename: 'image.png', value: '12345678' }
    const allowed = await sendRequest('/limited', buildMultipart([filePart]))
    assert.equal(allowed.status, 200, 'a file exactly at the size limit remains valid')
    assert.equal((await allowed.json()).files[0].size, 8)
    const limitCases = [
        ['LIMIT_FILE_SIZE', [{ ...filePart, value: '123456789' }]],
        ['LIMIT_FILE_COUNT', [filePart, filePart, filePart]],
        ['LIMIT_FIELD_VALUE', [{ name: 'prompt', value: 'x'.repeat(13) }]],
        ['LIMIT_FIELD_COUNT', Array.from({ length: 4 }, () => ({ name: 'prompt', value: 'text' }))],
        ['LIMIT_FIELD_KEY', [{ name: 'x'.repeat(25), value: 'text' }]],
        ['LIMIT_FIELD_NESTING', [{ name: 'prompt[one][two][end]', value: 'text' }]],
        ['LIMIT_FIELD_ARRAY_INDEX', [{ name: 'prompt[1000000000]', value: 'text' }]]
    ]
    for (const [code, parts] of limitCases) {
        const previouslyHandled = handledRequests
        await assertUploadError(await sendRequest('/limited', buildMultipart(parts)), 413, code)
        assert.equal(handledRequests, previouslyHandled)
        await assertResponsive()
    }
    const parts = Array.from({ length: 3 }, () => ({ name: 'prompt', value: 'text' }))
    await assertUploadError(await sendRequest('/part-limit', buildMultipart(parts)), 413, 'LIMIT_PART_COUNT')
})

test('both media routes enforce bounded multipart field counts', async () => {
    const body = buildMultipart(Array.from({ length: 33 }, () => ({ name: 'prompt', value: 'text' })))
    for (const route of MEDIA_ROUTES) {
        const previouslyHandled = handledRequests
        await assertUploadError(await sendRequest(route, body), 413, 'LIMIT_FIELD_COUNT')
        assert.equal(handledRequests, previouslyHandled)
        await assertResponsive()
    }
})

test('authentication rejects malformed uploads before parsing or waiting for a body', async () => {
    const previouslyHandled = handledRequests
    for (const route of MEDIA_ROUTES) {
        for (const apiKey of [null, 'invalid-key']) {
            const response = await sendRequest(route, 'malformed', { apiKey, contentType: 'multipart/form-data' })
            const payload = await response.text()
            assert.equal(response.status, 401, `${route}, key=${apiKey}: ${payload}`)
            assert.deepEqual(JSON.parse(payload), { error: 'Unauthorized' })
        }
        await new Promise((resolve, reject) => {
            const pendingRequest = requestHttp(`${baseUrl}${route}`, {
                method: 'POST', agent: false, headers: {
                    'Content-Type': CONTENT_TYPE, Authorization: 'Bearer invalid-key',
                    'Transfer-Encoding': 'chunked', Connection: 'close'
                }
            }, response => {
                response.resume()
                response.once('end', () => {
                    pendingRequest.destroy()
                    try { assert.equal(response.statusCode, 401); resolve() } catch (error) { reject(error) }
                })
            })
            pendingRequest.on('error', reject)
            pendingRequest.setTimeout(3000, () => pendingRequest.destroy(new Error('Authentication waited for upload data')))
            pendingRequest.flushHeaders()
        })
    }
    assert.equal(handledRequests, previouslyHandled)
    await assertResponsive()
})
