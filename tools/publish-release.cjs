'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { validateMetadata } = require('./release-metadata.cjs')

function run(command, argumentsList, capture = false) {
  return execFileSync(command, argumentsList, {
    encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: 15 * 60 * 1000
  })
}

function githubJson(endpoint, optional = false) {
  try {
    return JSON.parse(run('gh', ['api', endpoint], true))
  } catch (error) {
    if (optional && /HTTP 404/.test(String(error.stderr))) return null
    throw error
  }
}

function findRelease(repository, tag, execute = run) {
  try {
    // gh performs a draft-aware lookup; REST releases/tags only finds published releases.
    const release = JSON.parse(execute('gh', ['release', 'view', tag, '--repo', repository, '--json', 'isDraft'], true))
    return { draft: release.isDraft }
  } catch (error) {
    if (/release not found/i.test(String(error.stderr))) return null
    throw error
  }
}

function shouldUpdateLatest({ version, mainVersion, comparisonStatus }) {
  return version === mainVersion && ['ahead', 'identical'].includes(comparisonStatus)
}

function validateExistingRelease({ tagCommit, release, commit }) {
  if (tagCommit && tagCommit !== commit) throw new Error('Version tag already belongs to another commit; bump package.json version')
  if (release && !release.draft) throw new Error('This release is already published; use a new version or a build-only run')
}

function validateImageOwnership(imageMetadata, commit) {
  const images = imageMetadata?.architecture ? [imageMetadata] : Object.values(imageMetadata || {})
  const linuxImages = images.filter(image => image?.os === 'linux')
  assert.ok(linuxImages.length > 0, 'Existing Docker version has no identifiable image config')
  for (const image of linuxImages) {
    assert.equal(image.config?.Labels?.['org.opencontainers.image.revision'], commit,
      'Docker version already belongs to another or unknown commit; bump package.json version')
  }
}

function checkDockerVersion(imageReference, commit) {
  let imageMetadata
  try {
    imageMetadata = JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', imageReference, '--format', '{{json .Image}}'], true))
  } catch (error) {
    if (/manifest unknown|: not found\s*$/im.test(String(error.stderr))) return
    throw error
  }
  validateImageOwnership(imageMetadata, commit)
}

function verifyChecksum(archivePath) {
  const filename = path.basename(archivePath)
  const expected = readFileSync(`${archivePath}.sha256`, 'utf8').trim()
  const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
  assert.equal(expected, `${actual}  ${filename}`, `Checksum mismatch: ${filename}`)
  return expected
}

function main() {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Publishing requires main')
  const repository = process.env.GITHUB_REPOSITORY
  const commit = process.env.GITHUB_SHA
  const username = process.env.DOCKERHUB_USERNAME
  assert.match(repository || '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  assert.match(commit || '', /^[a-f0-9]{40}$/)
  assert.match(username || '', /^[a-z0-9][a-z0-9_-]*$/)
  const { name, version, tag } = validateMetadata(JSON.parse(readFileSync('package.json', 'utf8')))
  assert.equal(process.env.RELEASE_TAG, tag)
  const imageRepository = `${username}/${name}`
  const apiRoot = `repos/${repository}`

  // Validate the complete artifact set before creating tags or pushing anything.
  const archives = ['windows-x64', 'linux-x64', 'linux-arm64'].map(platform =>
    path.resolve('pkg_dist/releases', `${name}-${tag}-${platform}.tar.gz`)
  )
  const checksumLines = archives.map(verifyChecksum)
  const checksumsPath = path.resolve('pkg_dist/releases/SHA256SUMS')
  writeFileSync(checksumsPath, `${checksumLines.join('\n')}\n`)
  const architectures = ['amd64', 'arm64']
  for (const architecture of architectures) {
    run('docker', ['load', '--input', `pkg_dist/images/docker-image-${architecture}.tar`])
    const [image] = JSON.parse(run('docker', ['image', 'inspect', `qwen2api:ci-${architecture}`], true))
    assert.equal(image.Architecture, architecture)
    assert.equal(image.Os, 'linux')
    assert.equal(image.Config.Labels?.['org.opencontainers.image.revision'], commit)
    assert.deepEqual(image.Config.Entrypoint, ['/usr/local/bin/qwen2api'])
  }

  const tagReference = githubJson(`${apiRoot}/git/ref/tags/${tag}`, true)
  let tagCommit = tagReference?.object.sha
  if (tagReference?.object.type === 'tag') {
    tagCommit = githubJson(`${apiRoot}/commits/${tag}`).sha
  }
  const existingRelease = findRelease(repository, tag)
  validateExistingRelease({ tagCommit, release: existingRelease, commit })
  checkDockerVersion(`${imageRepository}:${tag}`, commit)

  // Reserve the version before registry writes. Failed drafts may be retried only
  // at the same commit; completed releases and tags are never silently replaced.
  if (!tagReference) run('gh', ['api', `${apiRoot}/git/refs`, '--method', 'POST', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${commit}`])
  if (!existingRelease) {
    run('gh', ['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft', '--title', `${name} ${tag}`, '--notes', `Validated build of ${commit}.`])
  }
  run('gh', ['release', 'upload', tag, ...archives, checksumsPath, '--repo', repository, '--clobber'])

  const imageDigests = []
  for (const architecture of architectures) {
    const stagingTag = `${imageRepository}:sha-${commit}-${architecture}`
    run('docker', ['tag', `qwen2api:ci-${architecture}`, stagingTag])
    run('docker', ['push', stagingTag])
    const [image] = JSON.parse(run('docker', ['image', 'inspect', stagingTag], true))
    const reference = image.RepoDigests.find(digest => digest.startsWith(`${imageRepository}@sha256:`))
    assert.ok(reference, `Missing pushed digest for ${architecture}`)
    imageDigests.push(reference)
  }
  run('docker', ['buildx', 'imagetools', 'create', '--tag', `${imageRepository}:${tag}`, ...imageDigests])

  // Later documentation/source commits with the same version do not suppress
  // latest. A newer version or a history rewrite must not be rolled back.
  const mainCommit = githubJson(`${apiRoot}/git/ref/heads/main`).object.sha
  const mainPackageFile = githubJson(`${apiRoot}/contents/package.json?ref=${mainCommit}`)
  const mainPackage = JSON.parse(Buffer.from(mainPackageFile.content, 'base64').toString('utf8'))
  const comparisonStatus = mainCommit === commit ? 'identical' : githubJson(`${apiRoot}/compare/${commit}...${mainCommit}`).status
  const updateLatest = shouldUpdateLatest({ version, mainVersion: mainPackage.version, comparisonStatus })
  if (updateLatest) {
    run('docker', ['buildx', 'imagetools', 'create', '--tag', `${imageRepository}:latest`, ...imageDigests])
  }
  const notes = [
    `Commit: ${commit}`, '',
    `Docker: ${imageRepository}:${tag} (linux/amd64, linux/arm64)`,
    `latest updated: ${updateLatest}`, '',
    'Downloads: Windows x64 and Linux x64/arm64 (glibc), with configuration example and run instructions.',
    'Docker uses Alpine/musl with the frontend and WASM embedded. No Node, Bun CLI, or node_modules layer.',
    'Validate downloaded archives against SHA256SUMS.', '',
    'Validated: regression gate, Bun source runtime, native binaries, actual Alpine containers, frontend MIME types, JSON/SSE, persistence, and shutdown.',
    'API smoke tests use a local mock upstream, not production accounts.', ''
  ].join('\n')
  const notesPath = path.resolve('pkg_dist/releases/release-notes.md')
  writeFileSync(notesPath, notes)
  run('gh', ['release', 'edit', tag, '--repo', repository, '--draft=false', `--latest=${updateLatest}`, '--notes-file', notesPath])
  const url = run('gh', ['release', 'view', tag, '--repo', repository, '--json', 'url', '--jq', '.url'], true).trim()
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Published ${tag}\n\n${url}\n\n${notes}`)
}

module.exports = { findRelease, shouldUpdateLatest, validateExistingRelease, validateImageOwnership, verifyChecksum }
if (require.main === module) main()
