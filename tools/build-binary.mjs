import { build } from 'bun'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { values } = parseArgs({ options: { target: { type: 'string' }, outfile: { type: 'string' } } })
const platform = process.platform === 'win32' ? 'windows' : process.platform
const compileTarget = values.target || `bun-${platform}-${process.arch}`
if (!/^bun-(?:(windows|darwin)-(x64|arm64)|linux-(x64|arm64)(-musl)?)$/.test(compileTarget)) {
  throw new Error(`Unsupported target: ${compileTarget}`)
}

const frontendDirectory = path.join(projectRoot, 'public/dist')
await stat(path.join(frontendDirectory, 'index.html')).catch(() => {
  throw new Error('Build the frontend first: bun run build:frontend')
})

async function listAssets(directory, prefix = '') {
  const assets = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) assets.push(...await listAssets(path.join(directory, entry.name), relativePath))
    else if (entry.isFile()) assets.push(relativePath)
  }
  return assets.sort()
}

const assets = await listAssets(frontendDirectory)
const assetImports = assets.map((relativePath, index) =>
  `import asset${index} from ${JSON.stringify(path.join(frontendDirectory, relativePath).replaceAll('\\', '/'))} with { type: "file" };`
)
const assetEntries = assets.map((relativePath, index) => `[${JSON.stringify(`/${relativePath}`)}, asset${index}]`)
const embeddedAssetsModule = `${assetImports.join('\n')}\nexport default new Map([${assetEntries.join(',\n')}]);`
const outputDirectory = path.join(projectRoot, 'pkg_dist')
const extension = compileTarget.includes('windows') ? '.exe' : ''
const outputPath = values.outfile
  ? path.resolve(projectRoot, values.outfile)
  : path.join(outputDirectory, `qwen2api-${compileTarget.slice(4)}${extension}`)
await mkdir(path.dirname(outputPath), { recursive: true })

const result = await build({
  entrypoints: [path.join(projectRoot, 'tools/binary-entry.mjs')],
  target: 'bun',
  env: 'disable',
  minify: true,
  // urllib only requires proxy-agent lazily (detectProxyAgent) and we never enable it;
  // it is not installed, so keep the bundler from trying to resolve it.
  external: ['proxy-agent'],
  compile: {
    target: compileTarget,
    outfile: outputPath,
    autoloadDotenv: false,
    autoloadBunfig: false
  },
  plugins: [{
    name: 'standalone-resources',
    setup(builder) {
      builder.onResolve({ filter: /^tiktoken$/ }, () => ({ path: require.resolve('tiktoken/init') }))
      builder.onResolve({ filter: /^\.\/utils\/frontend\.js$/ }, () => ({
        path: path.join(projectRoot, 'tools/binary-frontend.mjs')
      }))
      builder.onResolve({ filter: /^qwen2api:frontend-assets$/ }, () => ({
        path: 'frontend-assets', namespace: 'qwen2api-embedded'
      }))
      builder.onLoad({ filter: /.*/, namespace: 'qwen2api-embedded' }, () => ({
        contents: embeddedAssetsModule, loader: 'js'
      }))
    }
  }]
})

for (const message of result.logs) console.log(message)
if (!result.success) throw new Error('Standalone build failed')
const binarySize = (await stat(outputPath)).size
console.log(`Built ${outputPath}`)
console.log(`Size: ${(binarySize / 1024 / 1024).toFixed(1)} MiB; embedded frontend assets: ${assets.length}`)
