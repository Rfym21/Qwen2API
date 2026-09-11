import { readFileSync } from 'node:fs'
import dotenv from 'dotenv'
import { init } from 'tiktoken/init'
import tokenizerWasmPath from 'tiktoken/tiktoken_bg.wasm' with { type: 'file' }
import packageMetadata from '../package.json'

if (process.argv.includes('--version')) {
  console.log(`qwen2api ${packageMetadata.version}`)
  process.exit(0)
}

dotenv.config()
process.env.QWEN2API_RUNTIME_DIR ||= process.cwd()

// The build aliases all tiktoken imports to this initialized module. Explicit
// asset imports keep its WASM available without node_modules on the target host.
await init(imports => WebAssembly.instantiate(readFileSync(tokenizerWasmPath), imports))
await import('../src/server.js')
