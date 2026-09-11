'use strict'

// Exercise real Bun HTTP/stream/WASM behavior without real accounts or upstream traffic.
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { createServer } = require('node:http')
const { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')
const { countTokens } = require('../src/utils/precise-tokenizer')

const API_KEY = 'bun-smoke-key'
const MODEL = 'qwen-smoke-test'
const PROJECT_ROOT = path.resolve(__dirname, '..')

async function startListener(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function closeListener(server) {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

function parseServerEvents(responseText) {
  return responseText.split(/\r?\n\r?\n/)
    .map(frame => frame.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim()).join('\n'))
    .filter(data => data && data !== '[DONE]')
    .map(data => JSON.parse(data))
}

function assertFrontendContentType(response, assetPath) {
  const expectedTypes = {
    '.html': /^text\/html(?:;|$)/i,
    '.js': /^(?:application|text)\/javascript(?:;|$)/i,
    '.css': /^text\/css(?:;|$)/i,
    '.svg': /^image\/svg\+xml(?:;|$)/i,
    '.mp4': /^video\/mp4(?:;|$)/i
  }
  const expectedType = expectedTypes[path.extname(assetPath)]
  assert.ok(expectedType, `Add a MIME expectation for ${assetPath}`)
  assert.match(response.headers.get('content-type') || '', expectedType,
    `${assetPath}: browsers must receive a valid MIME type`)
}

async function main() {
  assert.ok(process.versions.bun, 'Run this smoke test with Bun, not Node')
  assert.equal(countTokens('hello'), 1, 'tiktoken WASM must load under Bun')
  const { values } = parseArgs({ options: {
    binary: { type: 'string' }, 'docker-image': { type: 'string' }
  } })
  const binaryPath = values.binary ? path.resolve(values.binary) : null
  const dockerImage = values['docker-image']
  assert.ok(!(binaryPath && dockerImage), 'Choose either --binary or --docker-image')
  if (dockerImage) assert.equal(process.platform, 'linux', 'Container smoke tests require Linux host networking')
  const standalone = Boolean(binaryPath || dockerImage)
  const containerName = dockerImage ? `qwen-smoke-${randomUUID()}` : null

  const expires = Math.floor(Date.now() / 1000) + 86400
  const smokeAccounts = ['smoke', 'replacement'].map(name => ({
    email: `${name}@example.invalid`, password: 'local-test-password', expires,
    token: [
      Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
      Buffer.from(JSON.stringify({ id: name, exp: expires })).toString('base64url'),
      'local-test-signature'
    ].join('.')
  }))
  let completionRequests = 0
  let replyDelayMilliseconds = 20
  let failoverMode = false
  const failoverTokens = []
  const upstreamServer = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    response.setHeader('Content-Type', 'application/json')
    if (pathname === '/api/v1/auths/signin') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const account = smokeAccounts.find(candidate => candidate.email === JSON.parse(body).email)
        response.end(JSON.stringify({ token: account?.token }))
      })
      return
    }
    request.resume()
    if (pathname === '/api/models') {
      response.end(JSON.stringify({ data: [{
        id: MODEL, name: MODEL, info: { meta: { chat_type: ['t2t'], abilities: {} } }
      }] }))
    } else if (pathname === '/api/v2/chats/new') {
      response.end(JSON.stringify({ data: { id: 'smoke-chat' } }))
    } else if (pathname === '/api/v2/chat/completions') {
      completionRequests += 1
      response.setHeader('Content-Type', 'text/event-stream')
      if (failoverMode) {
        const accountToken = request.headers.cookie?.split(';').find(part => part.trim().startsWith('token='))?.trim().slice(6)
        failoverTokens.push(accountToken)
        if (failoverTokens.length === 1) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { phase: 'answer', content: 'Uncommitted draft.' }, finish_reason: null }] })}\n\n`)
          response.end(`data: ${JSON.stringify({ success: false, data: { code: 'quota_limit' } })}\n\n`)
          return
        }
      }
      const content = failoverMode ? '<agent_final>OK</agent_final>' : 'OK'
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { phase: 'answer', content }, finish_reason: null }] })}\n\n`)
      setTimeout(() => response.end(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`
      ), replyDelayMilliseconds)
    } else {
      response.writeHead(404).end(JSON.stringify({ error: `Unexpected upstream path: ${pathname}` }))
    }
  })

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'qwen-bun-smoke-'))
  let application
  let applicationClosed
  let applicationLogs = ''
  try {
    let applicationExecutable = process.execPath
    let applicationArguments = ['--no-env-file', path.join(PROJECT_ROOT, 'src/server.js')]
    if (binaryPath) {
      applicationExecutable = path.join(temporaryDirectory, path.basename(binaryPath))
      applicationArguments = []
      await copyFile(binaryPath, applicationExecutable)
      if (process.platform !== 'win32') await chmod(applicationExecutable, 0o755)
    }
    if (standalone) {
      await mkdir(path.join(temporaryDirectory, 'data'))
      await writeFile(path.join(temporaryDirectory, 'data/data.json'), JSON.stringify({ accounts: smokeAccounts }))
      await writeFile(path.join(temporaryDirectory, '.env'), `API_KEY=${API_KEY}\n`)
    }
    const upstreamPort = await startListener(upstreamServer)
    const portReservation = createServer()
    const servicePort = await startListener(portReservation)
    await closeListener(portReservation)
    const baseUrl = `http://127.0.0.1:${servicePort}`

    // An empty cwd and a minimal environment prevent loading the developer's .env.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].includes(name.toUpperCase())
    ))
    const serviceEnvironment = {
      NODE_ENV: 'production',
      ...(standalone ? {} : { API_KEY }),
      SERVICE_PORT: String(servicePort),
      LISTEN_ADDRESS: '127.0.0.1',
      DATA_SAVE_MODE: standalone ? 'file' : 'none',
      ACCOUNTS: smokeAccounts.map(account => `${account.email}:${account.password}`).join(','),
      ENABLE_CLI: 'false',
      ENABLE_FILE_LOG: standalone ? 'true' : 'false',
      LOG_LEVEL: standalone ? 'INFO' : 'ERROR',
      CACHE_MODE: standalone ? 'file' : 'default',
      QWEN_CHAT_PROXY_URL: `http://127.0.0.1:${upstreamPort}`,
      QWEN_CLI_PROXY_URL: `http://127.0.0.1:${upstreamPort}`
    }
    if (dockerImage) {
      applicationExecutable = 'docker'
      applicationArguments = [
        'run', '--rm', '--pull=never', '--name', containerName, '--network', 'host',
        '--user', `${process.getuid()}:${process.getgid()}`,
        '--mount', `type=bind,source=${temporaryDirectory},target=/app`,
        ...Object.entries(serviceEnvironment).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
        dockerImage
      ]
    }
    application = spawn(applicationExecutable, applicationArguments, {
      cwd: temporaryDirectory,
      env: { ...environment, ...serviceEnvironment },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    application.stdout.on('data', chunk => { applicationLogs += chunk })
    application.stderr.on('data', chunk => { applicationLogs += chunk })
    applicationClosed = new Promise(resolve => application.once('close', resolve))
    let spawnError
    application.on('error', error => { spawnError = error })

    const request = (route, options = {}) => fetch(`${baseUrl}${route}`, {
      signal: AbortSignal.timeout(30000), ...options
    })
    let ready = false
    const readinessDeadline = Date.now() + 10000
    while (Date.now() < readinessDeadline) {
      if (spawnError) throw spawnError
      assert.equal(application.exitCode, null, `Application exited early: ${applicationLogs}`)
      try {
        const response = await request('/api/getAllAccounts', {
          headers: { 'x-api-key': API_KEY }, signal: AbortSignal.timeout(500)
        })
        const payload = await response.json()
        ready = response.ok && payload.data?.length === 2 && payload.data.every(account => account.expires === expires)
      } catch { /* The listener may not be ready yet. */ }
      if (ready) break
      await delay(100)
    }
    assert.ok(ready, `Application did not become ready: ${applicationLogs}`)

    const page = await request('/auth')
    assert.equal(page.status, 200, 'Build the frontend before running this smoke test')
    assertFrontendContentType(page, '/index.html')
    const pageHtml = await page.text()
    assert.match(pageHtml, /<div id="app">/)
    const frontendAssetNames = await readdir(path.join(PROJECT_ROOT, 'public/dist/assets'))
    const pageAssets = new Set([
      ...[...pageHtml.matchAll(/(?:src|href)="(\/[^"\s]+)"/g)].map(match => match[1]),
      ...frontendAssetNames.filter(name => /\.(js|css)$/.test(name)).map(name => `/assets/${name}`)
    ])
    assert.ok([...pageAssets].some(asset => asset.endsWith('.js')))
    for (const asset of pageAssets) {
      const assetResponse = await request(asset)
      assert.equal(assetResponse.status, 200, asset)
      assertFrontendContentType(assetResponse, asset)
      const expectedContents = await readFile(path.join(PROJECT_ROOT, 'public/dist', asset.slice(1)))
      assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), expectedContents, asset)
    }
    const headResponse = await request('/auth', { method: 'HEAD' })
    assert.equal(headResponse.status, 200)
    assertFrontendContentType(headResponse, '/index.html')
    assert.equal((await headResponse.arrayBuffer()).byteLength, 0)
    const videoName = frontendAssetNames.find(name => name.endsWith('.mp4'))
    if (videoName) {
      const videoResponse = await request(`/assets/${videoName}`, { headers: { Range: 'bytes=0-31' } })
      assert.equal(videoResponse.status, 206, 'Video range requests must work')
      assertFrontendContentType(videoResponse, `/assets/${videoName}`)
      assert.equal((await videoResponse.arrayBuffer()).byteLength, 32)
    }
    console.log('PASS: frontend MIME types, lazy-loaded scripts/styles, HEAD, and video ranges')
    const csrf = await request('/api/csrf-token')
    assert.equal(typeof (await csrf.json()).csrfToken, 'string')
    const login = await request('/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY })
    })
    assert.equal(login.status, 200)
    assert.equal((await login.json()).isAdmin, true)

    const uploadBoundary = 'bun-smoke-upload-boundary'
    const uploadFields = Array.from({ length: 33 }, () =>
      `--${uploadBoundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\ntext\r\n`
    ).join('') + `--${uploadBoundary}--\r\n`
    const invalidUploads = [
      { contentType: 'multipart/form-data', body: 'missing boundary', status: 400 },
      {
        contentType: `multipart/form-data; boundary=${uploadBoundary}`,
        body: `--${uploadBoundary}\r\nContent-Disposition: form-data; name="image"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\ntruncated`,
        status: 400
      },
      { contentType: `multipart/form-data; boundary=${uploadBoundary}`, body: uploadFields, status: 413 }
    ]
    for (const route of ['/v1/images/edits', '/v1/videos']) {
      const unauthorized = await request(route, {
        method: 'POST', headers: { 'x-api-key': 'invalid-smoke-key', 'Content-Type': 'multipart/form-data' },
        body: 'missing boundary'
      })
      assert.equal(unauthorized.status, 401, 'Authentication must run before multipart parsing')
      await unauthorized.text()
      for (const upload of invalidUploads) {
        const response = await request(route, {
          method: 'POST', headers: { 'x-api-key': API_KEY, 'Content-Type': upload.contentType }, body: upload.body
        })
        assert.equal(response.status, upload.status, `${route}: invalid upload status`)
        assert.equal((await response.json()).error.type, 'invalid_request_error')
      }
    }
    assert.equal(completionRequests, 0, 'Rejected uploads must not reach upstream completions')
    const afterUploads = await request('/api/csrf-token')
    assert.equal(typeof (await afterUploads.json()).csrfToken, 'string', 'Server stays responsive after invalid uploads')
    console.log('PASS: upload authentication, malformed multipart, field limits, and responsiveness')

    for (const route of ['/v1/messages', '/v1/chat/completions']) {
      const unauthorized = await request(route, {
        method: 'POST', headers: { 'x-api-key': 'invalid-smoke-key' }
      })
      assert.equal(unauthorized.status, 401)
      await unauthorized.text()
      for (const stream of [false, true]) {
        // Cross the usual ten-second idle window and the Anthropic heartbeat interval.
        replyDelayMilliseconds = stream && route === '/v1/messages' ? 16000 : 20
        const response = await request(route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: MODEL, max_tokens: 32, stream, messages: [{ role: 'user', content: 'Reply OK.' }] })
        })
        const responseText = await response.text()
        assert.equal(response.status, 200, responseText)
        if (stream) {
          assert.match(response.headers.get('content-type'), /text\/event-stream/)
          const events = parseServerEvents(responseText)
          assert.ok(!events.some(event => event.type === 'error' || event.error), responseText)
          const reply = route === '/v1/messages'
            ? events.filter(event => event.delta?.type === 'text_delta').map(event => event.delta.text).join('')
            : events.map(event => event.choices?.[0]?.delta?.content || '').join('')
          assert.equal(reply, 'OK')
          if (route === '/v1/messages') assert.equal(events.at(-1).type, 'message_stop')
          else assert.match(responseText, /data: \[DONE\]/)
        } else {
          const payload = JSON.parse(responseText)
          const reply = route === '/v1/messages'
            ? payload.content.filter(block => block.type === 'text').map(block => block.text).join('')
            : payload.choices[0].message.content
          assert.equal(reply, 'OK')
        }
        console.log(`PASS: ${route} stream=${stream}, upstream delay=${replyDelayMilliseconds}ms`)
      }
    }
    assert.equal(completionRequests, 4, 'Each request must reach the local upstream')
    failoverMode = true
    replyDelayMilliseconds = 20
    const failoverResponse = await request('/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        model: MODEL, stream: true, messages: [{ role: 'user', content: 'Reply OK when finished.' }],
        tools: [{ type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: {} } } }]
      })
    })
    assert.equal(failoverResponse.status, 200)
    const failoverEvents = parseServerEvents(await failoverResponse.text())
    assert.ok(!failoverEvents.some(event => event.error))
    assert.equal(failoverEvents.map(event => event.choices?.[0]?.delta?.content || '').join(''), 'OK')
    assert.equal(completionRequests, 6, 'Agent should retry exactly once after the injected quota failure')
    assert.ok(failoverTokens.every(token => smokeAccounts.some(account => account.token === token)))
    assert.equal(new Set(failoverTokens).size, 2, 'Failover must send a different account token upstream')
    console.log('PASS: Agent mid-stream quota failover with distinct account credentials')
    if (standalone) {
      const settingsResponse = await request('/api/setRetryConfig', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ chatRetryCount: 2, chatRetryBackoffMs: 10 })
      })
      assert.equal(settingsResponse.status, 200)
      assert.equal((await settingsResponse.json()).persisted, true)
      const savedData = JSON.parse(await readFile(path.join(temporaryDirectory, 'data/data.json'), 'utf8'))
      assert.equal(savedData.settings.chatRetryCount, 2)
      assert.ok((await stat(path.join(temporaryDirectory, 'logs/app.log'))).size > 0)
      assert.ok((await stat(path.join(temporaryDirectory, 'caches'))).isDirectory())
      const runtimeFiles = await readdir(temporaryDirectory)
      assert.ok(!runtimeFiles.includes('node_modules') && !runtimeFiles.includes('public'))
      console.log('PASS: standalone assets, .env, data persistence, logs, and cache directory')
    }
    if (dockerImage) {
      const stopResult = spawnSync('docker', ['stop', '--time', '10', containerName], { timeout: 15000, encoding: 'utf8' })
      assert.equal(stopResult.status, 0, stopResult.stderr || stopResult.error?.message)
    } else {
      application.kill('SIGTERM')
    }
    const shutdownTimer = setTimeout(() => application.kill('SIGKILL'), 10000)
    const exitCode = await applicationClosed
    clearTimeout(shutdownTimer)
    if (process.platform !== 'win32') assert.equal(exitCode, 0, 'SIGTERM should exit cleanly')
    console.log('PASS: Bun startup, login, frontend, WASM, HTTP/SSE, and shutdown')
  } catch (error) {
    if (applicationLogs) console.error(applicationLogs)
    throw error
  } finally {
    if (dockerImage) spawnSync('docker', ['rm', '--force', containerName], { timeout: 15000, stdio: 'pipe' })
    if (application && application.exitCode === null && application.signalCode === null) application.kill('SIGKILL')
    if (applicationClosed) await applicationClosed
    await closeListener(upstreamServer)
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
