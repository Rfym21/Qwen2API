import { file } from 'bun'
import { lookup } from 'mime-types'
import frontendAssets from 'qwen2api:frontend-assets'

async function sendEmbeddedFile(request, response, next, requestedPath) {
  try {
    const asset = file(frontendAssets.get(requestedPath))
    // Express treats strings containing '/' as MIME types, not file paths.
    response.type(lookup(requestedPath) || 'application/octet-stream').set('Accept-Ranges', 'bytes')
    // fs.createReadStream/sendFile cannot open Bun's virtual paths on Windows.
    // Use Bun.file directly, preserving single-range requests for the background video.
    const ranges = request.method === 'GET' && !request.get('If-Range')
      ? request.range(asset.size)
      : undefined
    if (ranges === -1) {
      return response.status(416).set('Content-Range', `bytes */${asset.size}`).end()
    }
    if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1) {
      const { start, end } = ranges[0]
      response.status(206).set('Content-Range', `bytes ${start}-${end}/${asset.size}`)
      return response.send(Buffer.from(await asset.slice(start, end + 1).arrayBuffer()))
    }
    response.send(Buffer.from(await asset.arrayBuffer()))
  } catch (error) {
    next(error)
  }
}

export function mountFrontend(application) {
  application.use((request, response, next) => {
    if (!['GET', 'HEAD'].includes(request.method)) return next()
    let requestedPath
    try {
      requestedPath = decodeURIComponent(request.path)
    } catch {
      return response.status(400).send('Invalid URL encoding')
    }

    if (!frontendAssets.has(requestedPath)) return next()
    return sendEmbeddedFile(request, response, next, requestedPath)
  })

  application.get('*', (request, response, next) => {
    return sendEmbeddedFile(request, response, next, '/index.html')
  })
}
