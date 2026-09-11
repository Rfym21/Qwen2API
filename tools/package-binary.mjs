import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { validateMetadata } from './release-metadata.cjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { platform: { type: 'string' } } })
const platform = values.platform
if (!['windows-x64', 'linux-x64', 'linux-arm64'].includes(platform)) throw new Error('Unsupported release platform')
const { name, tag } = validateMetadata(JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')))
const filename = `${name}-${platform}${platform.startsWith('windows') ? '.exe' : ''}`
const outputDirectory = path.join(projectRoot, 'pkg_dist/releases')
await mkdir(outputDirectory, { recursive: true })
const stagingDirectory = await mkdtemp(path.join(outputDirectory, '.staging-'))

try {
  await copyFile(path.join(projectRoot, 'pkg_dist', filename), path.join(stagingDirectory, filename))
  if (!platform.startsWith('windows')) await chmod(path.join(stagingDirectory, filename), 0o755)
  await copyFile(path.join(projectRoot, '.env.example'), path.join(stagingDirectory, '.env.example'))
  await writeFile(path.join(stagingDirectory, 'RUNNING.md'), [
    `# ${name} ${tag} (${platform})`,
    '',
    'Extract this archive into a writable directory. Copy .env.example to .env and configure API_KEY and accounts/storage.',
    'Run the executable from that directory. No Node, Bun, or node_modules installation is needed.',
    'The .env file is read from the working directory; data/, logs/, and caches/ are also written there by default.',
    'QWEN2API_RUNTIME_DIR overrides the writable data root. --version prints the version without starting the service.',
    '',
    `Run: ${platform.startsWith('windows') ? '.\\' : './'}${filename}`,
    'Linux binaries in releases use glibc. The Docker images use separately tested musl binaries for Alpine.',
    ''
  ].join('\n'))
  const archiveName = `${name}-${tag}-${platform}.tar.gz`
  const archivePath = path.join(outputDirectory, archiveName)
  execFileSync('tar', ['-czf', archivePath, '-C', stagingDirectory, '.'], { stdio: 'inherit' })
  const digest = createHash('sha256').update(await readFile(archivePath)).digest('hex')
  await writeFile(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`)
  console.log(`Packaged ${archivePath}`)
} finally {
  await rm(stagingDirectory, { recursive: true, force: true })
}
