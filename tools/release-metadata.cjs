'use strict'

const { execFileSync } = require('node:child_process')
const { appendFileSync, readFileSync } = require('node:fs')

function validateMetadata(packageMetadata) {
  const name = String(packageMetadata.name || '').split('/').at(-1)
  const version = String(packageMetadata.version || '')
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(name)) throw new Error('Invalid package name for release artifacts')
  // The project's date-based versions are intentionally not restricted to semver.
  if (!/^[0-9][A-Za-z0-9.-]*$/.test(version) || version.length > 100 ||
      version.includes('..') || version.endsWith('.') || version.endsWith('.lock')) {
    throw new Error('Invalid package version for release tags')
  }
  return { name, version, tag: `v${version}` }
}

function planRelease({ eventName, ref, previousVersion, packageMetadata, manualPublish = false }) {
  const metadata = validateMetadata(packageMetadata)
  const manual = eventName === 'workflow_dispatch'
  const onMain = ref === 'refs/heads/main'
  if (manual && manualPublish && !onMain) throw new Error('Publishing is allowed only from main')
  const versionChanged = previousVersion != null && previousVersion !== metadata.version
  const shouldRun = manual || (eventName === 'push' && onMain && versionChanged)
  return { ...metadata, shouldRun, publish: shouldRun && onMain && (manual ? manualPublish : true) }
}

function main() {
  const packageMetadata = JSON.parse(readFileSync('package.json', 'utf8'))
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  let previousVersion = null
  if (process.env.GITHUB_EVENT_NAME === 'push' && event.before && !/^0+$/.test(event.before)) {
    if (!/^[a-f0-9]{40}$/.test(event.before)) throw new Error('Invalid previous commit')
    previousVersion = JSON.parse(execFileSync('git', ['show', `${event.before}:package.json`], { encoding: 'utf8' })).version
  }
  const plan = planRelease({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    previousVersion,
    packageMetadata,
    manualPublish: event.inputs?.publish === true || event.inputs?.publish === 'true'
  })
  for (const [key, value] of Object.entries({ should_run: plan.shouldRun, publish: plan.publish, tag: plan.tag })) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  }
  const message = plan.shouldRun
    ? `${plan.tag}: ${plan.publish ? 'validate, then publish' : 'validate and build artifacts only'}`
    : 'Version unchanged or no previous branch commit; release skipped.'
  console.log(message)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release plan\n\n${message}\n`)
}

module.exports = { planRelease, validateMetadata }
if (require.main === module) main()
