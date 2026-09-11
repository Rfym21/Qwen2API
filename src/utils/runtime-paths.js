const path = require('node:path')

// Source deployments keep their existing project-relative layout. The binary
// entry point sets QWEN2API_RUNTIME_DIR to its working directory before startup.
function resolveRuntimePath(...segments) {
  const runtimeDirectory = process.env.QWEN2API_RUNTIME_DIR || path.resolve(__dirname, '../..')
  return path.resolve(runtimeDirectory, ...segments)
}

module.exports = { resolveRuntimePath }
