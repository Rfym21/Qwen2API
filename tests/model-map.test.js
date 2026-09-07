// Pure tests for src/utils/model-map.js: no network, and account.js must never load.
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

// models-map.js is stubbed in require.cache before the resolver ever lazy-requires it.
// This relies on node:test running every test file in its own process: the stub is
// process-wide and would leak into any other file that shared this process.
const modelsMapPath = require.resolve('../src/models/models-map.js')
let upstreamModels = []
const modelsMapStub = new Module(modelsMapPath)
modelsMapStub.filename = modelsMapPath
modelsMapStub.loaded = true
modelsMapStub.exports = { getLatestModels: async () => upstreamModels }
require.cache[modelsMapPath] = modelsMapStub

const config = require('../src/config/index.js')
const { logger } = require('../src/utils/logger')
const {
  UNMAPPED_CAP,
  NAME_MAX_LENGTH,
  MODEL_MAP_MAX_ROWS,
  stripBracketSuffix,
  sanitizeName,
  parseModelMap,
  isKnownUpstreamModel,
  buildModelMap,
  resolveModel,
  recordUnmapped,
  getUnmappedModels,
  forgetUnmapped,
  resetUnmappedModels,
  resetModelMapState,
  mapIncomingModel
} = require('../src/utils/model-map.js')

const T2T = (id, extra = {}) => ({ id, ...extra, info: { meta: { chat_type: ['t2t', 'search'] } } })
const T2I = (id) => ({ id, info: { meta: { chat_type: ['t2i'] } } })
const UPSTREAM = [
  T2I('qwen-image'),
  T2T('qwen3.8-max', { name: 'Qwen3.8-Max-Preview', display_name: 'Qwen 3.8 Max' }),
  T2T('qwen3-max')
]

const captureLogs = () => {
  const lines = { warn: [], info: [] }
  const originalWarn = logger.warn
  const originalInfo = logger.info
  logger.warn = (message) => { lines.warn.push(String(message)) }
  logger.info = (message) => { lines.info.push(String(message)) }
  return { lines, restore: () => { logger.warn = originalWarn; logger.info = originalInfo } }
}

const withMap = async (raw, models, fn) => {
  const previous = config.modelMap
  config.modelMap = raw
  upstreamModels = models
  resetModelMapState()
  const logs = captureLogs()
  try {
    return await fn(logs.lines)
  } finally {
    logs.restore()
    config.modelMap = previous
    upstreamModels = []
    resetModelMapState()
  }
}

test('exact entry wins and the target keeps its suffix so thinking detection sees it', async () => {
  const map = parseModelMap('claude-opus-5=qwen3.8-max-thinking')
  assert.deepEqual(resolveModel('claude-opus-5', map, UPSTREAM), { model: 'qwen3.8-max-thinking', source: 'exact' })
  await withMap('claude-opus-5=qwen3.8-max-thinking', UPSTREAM, async (lines) => {
    assert.equal(await mapIncomingModel('claude-opus-5'), 'qwen3.8-max-thinking')
    assert.deepEqual(getUnmappedModels(), [])
    assert.equal(lines.warn.length, 0, 'a known target with a real suffix must not warn')
    assert.match(lines.info[0], /claude-opus-5 -> qwen3\.8-max-thinking \[exact\]/)
  })
})

test('trailing [..] groups are stripped before the lookup, repeated and spaced too', () => {
  assert.equal(stripBracketSuffix('foo[1m]'), 'foo')
  assert.equal(stripBracketSuffix('foo[1m][x]'), 'foo')
  assert.equal(stripBracketSuffix('foo [1m]'), 'foo')
  assert.equal(stripBracketSuffix('  foo [1m] [x]  '), 'foo')
  assert.equal(stripBracketSuffix('foo[1m]bar'), 'foo[1m]bar', 'only trailing groups are stripped')
  const map = parseModelMap('claude-opus-5=qwen3.8-max-thinking')
  assert.deepEqual(resolveModel('claude-opus-5[1m]', map, UPSTREAM), resolveModel('claude-opus-5', map, UPSTREAM))
  assert.deepEqual(resolveModel('claude-opus-5 [1m][x]', map, UPSTREAM), { model: 'qwen3.8-max-thinking', source: 'exact' })
})

test('exact lookup is case-insensitive on the alias; targets keep their case', () => {
  assert.deepEqual(resolveModel('Claude-Opus-5', parseModelMap('claude-opus-5=qwen3.8-max'), UPSTREAM), { model: 'qwen3.8-max', source: 'exact' })
  assert.deepEqual(resolveModel('claude-opus-5', parseModelMap('Claude-Opus-5=qwen3.8-max'), UPSTREAM), { model: 'qwen3.8-max', source: 'exact' })
  assert.deepEqual({ ...parseModelMap('Claude-Opus-5=Qwen3.8-Max') }, { 'claude-opus-5': 'Qwen3.8-Max' })
})

test('a map key may carry a [..] suffix; it is stripped like the incoming name', () => {
  const map = parseModelMap('claude-opus-5[1m]=qwen3.8-max')
  assert.deepEqual({ ...map }, { 'claude-opus-5': 'qwen3.8-max' })
  assert.deepEqual(resolveModel('claude-opus-5', map, UPSTREAM), { model: 'qwen3.8-max', source: 'exact' })
  assert.deepEqual(resolveModel('claude-opus-5[1m]', map, UPSTREAM), { model: 'qwen3.8-max', source: 'exact' })
})

test('isKnownUpstreamModel: exact id, real suffix variants, aliases, case; not arbitrary suffixes', () => {
  assert.equal(isKnownUpstreamModel('qwen3.8-max', UPSTREAM), true)
  assert.equal(isKnownUpstreamModel('qwen3.8-max-thinking', UPSTREAM), true)
  assert.equal(isKnownUpstreamModel('qwen3.8-max-thinking-search', UPSTREAM), true)
  assert.equal(isKnownUpstreamModel('qwen-image', UPSTREAM), true)
  assert.equal(isKnownUpstreamModel('qwen3.8-max-fast', UPSTREAM), false, 'unknown suffix is not a known variant')
  assert.equal(isKnownUpstreamModel('qwen-plus-latest', UPSTREAM), false)
  assert.equal(isKnownUpstreamModel('qwen3.8-max-preview', UPSTREAM), true, 'name alias')
  assert.equal(isKnownUpstreamModel('qwen 3.8 max', UPSTREAM), true, 'display_name alias')
  assert.equal(isKnownUpstreamModel('QWEN3.8-MAX-THINKING', UPSTREAM), true, 'case-insensitive')
  assert.equal(isKnownUpstreamModel('', UPSTREAM), false)
  assert.equal(isKnownUpstreamModel('qwen3.8-max', []), false)
  // the prefix heuristic is gone: an unknown variant falls to * instead of hitting upstream
  assert.deepEqual(resolveModel('qwen3.8-max-fast', parseModelMap('*=qwen3-max'), UPSTREAM), { model: 'qwen3-max', source: 'wildcard' })
})

test('* entry catches unlisted names and records them as unmapped', async () => {
  await withMap('*=qwen3.8-max', UPSTREAM, async (lines) => {
    assert.deepEqual(resolveModel('gpt-4o', parseModelMap(config.modelMap), UPSTREAM), { model: 'qwen3.8-max', source: 'wildcard' })
    assert.equal(await mapIncomingModel('gpt-4o'), 'qwen3.8-max')
    assert.deepEqual(getUnmappedModels(), ['gpt-4o'])
    assert.equal(lines.warn.length, 1)
    assert.match(lines.warn[0], /MODEL_MAP/)
    assert.match(lines.info[0], /gpt-4o -> qwen3\.8-max \[wildcard\]/)
    // second hit: same target, no second warn
    assert.equal(await mapIncomingModel('gpt-4o'), 'qwen3.8-max')
    assert.equal(lines.warn.length, 1)
  })
})

test('no map: first upstream t2t model, recorded, one warn naming MODEL_MAP', async () => {
  await withMap('', UPSTREAM, async (lines) => {
    assert.deepEqual(resolveModel('claude-sonnet-5', parseModelMap(''), UPSTREAM), { model: 'qwen3.8-max', source: 'default' })
    assert.equal(await mapIncomingModel('claude-sonnet-5'), 'qwen3.8-max')
    assert.equal(await mapIncomingModel('claude-sonnet-5[1m]'), 'qwen3.8-max')
    assert.deepEqual(getUnmappedModels(), ['claude-sonnet-5'])
    assert.equal(lines.warn.length, 1)
    assert.match(lines.warn[0], /MODEL_MAP/)
    assert.match(lines.info[0], /claude-sonnet-5 -> qwen3\.8-max \[default\]/)
  })
})

test('empty upstream list: nothing after the exact lookup applies, one warn per process', async () => {
  // no map: unchanged (upstream error as today), not recorded
  assert.deepEqual(resolveModel('claude-sonnet-5[1m]', parseModelMap(''), []), { model: 'claude-sonnet-5', source: 'unchanged' })
  await withMap('', [], async (lines) => {
    assert.equal(await mapIncomingModel('claude-sonnet-5'), 'claude-sonnet-5')
    assert.deepEqual(getUnmappedModels(), [])
    assert.equal(lines.warn.length, 1)
    assert.match(lines.warn[0], /upstream model list unavailable; MODEL_MAP "\*" not applied/)
    assert.equal(lines.info.length, 0)
  })
  // * set: still unchanged, not recorded, the warn fires once per process
  assert.deepEqual(resolveModel('gpt-4o', parseModelMap('*=qwen3.8-max'), []), { model: 'gpt-4o', source: 'unchanged' })
  await withMap('*=qwen3.8-max', [], async (lines) => {
    assert.equal(await mapIncomingModel('gpt-4o'), 'gpt-4o')
    assert.equal(await mapIncomingModel('qwen3.8-max-thinking'), 'qwen3.8-max-thinking')
    assert.equal(await mapIncomingModel('claude-x[1m]'), 'claude-x')
    assert.deepEqual(getUnmappedModels(), [])
    assert.equal(lines.warn.length, 1)
    assert.match(lines.warn[0], /MODEL_MAP "\*" not applied/)
    assert.equal(lines.info.length, 0)
    // exact entries still work without the list
    config.modelMap = 'claude-a=qwen3.8-max,*=qwen3-max'
    assert.equal(await mapIncomingModel('claude-a'), 'qwen3.8-max')
    assert.equal(lines.warn.length, 1, 'target validation is skipped without a list')
  })
})

test('known Qwen id with no entry is untouched and not recorded, even with * set', async () => {
  for (const raw of ['', '*=qwen3-max', 'claude-opus-5=qwen3-max,*=qwen3-max']) {
    await withMap(raw, UPSTREAM, async (lines) => {
      const map = parseModelMap(raw)
      assert.deepEqual(resolveModel('qwen3.8-max-thinking', map, UPSTREAM), { model: 'qwen3.8-max-thinking', source: 'known' })
      assert.deepEqual(resolveModel('qwen3.8-max', map, UPSTREAM), { model: 'qwen3.8-max', source: 'known' })
      assert.deepEqual(resolveModel('qwen-image', map, UPSTREAM), { model: 'qwen-image', source: 'known' })
      assert.equal(await mapIncomingModel('qwen3.8-max-thinking'), 'qwen3.8-max-thinking')
      // bracket-only strip on a Qwen id: no info line either
      assert.equal(await mapIncomingModel('qwen3.8-max[1m]'), 'qwen3.8-max')
      assert.deepEqual(getUnmappedModels(), [])
      assert.equal(lines.warn.length, 0)
      assert.equal(lines.info.length, 0)
    })
  }
})

test('malformed map keeps only the well-formed entry and never throws', () => {
  const map = parseModelMap('foo, =x, claude-a = qwen3.8-max')
  assert.deepEqual({ ...map }, { 'claude-a': 'qwen3.8-max' })
  assert.deepEqual({ ...parseModelMap('') }, {})
  assert.deepEqual({ ...parseModelMap(undefined) }, {})
  assert.deepEqual({ ...parseModelMap('a=1,a=2') }, { a: '2' })
  // prototype keys are not entries
  assert.deepEqual(resolveModel('constructor', parseModelMap(''), UPSTREAM.slice(0, 1)), { model: 'constructor', source: 'unchanged' })
})

test('unmapped record is capped at 100 distinct names; cap warns once, then silence', async () => {
  resetModelMapState()
  for (let i = 0; i < UNMAPPED_CAP; i += 1) assert.equal(recordUnmapped(`model-${i}`), true)
  assert.equal(recordUnmapped('model-0'), false)
  assert.equal(recordUnmapped('model-100'), false)
  assert.equal(getUnmappedModels().length, UNMAPPED_CAP)
  assert.ok(!getUnmappedModels().includes('model-100'))

  const previous = config.modelMap
  config.modelMap = '*=qwen3-max'
  upstreamModels = UPSTREAM
  const logs = captureLogs()
  try {
    assert.equal(await mapIncomingModel('extra-1'), 'qwen3-max')
    assert.equal(await mapIncomingModel('extra-2'), 'qwen3-max')
    assert.equal(await mapIncomingModel('model-0'), 'qwen3-max')
    assert.equal(getUnmappedModels().length, UNMAPPED_CAP)
    assert.equal(logs.lines.warn.length, 1)
    assert.match(logs.lines.warn[0], /unmapped model record is full \(100 names\); further names are not tracked/)
    assert.equal(logs.lines.info.length, 3, 'the per-request info line is not gated by the cap')
  } finally {
    logs.restore()
    config.modelMap = previous
    upstreamModels = []
    resetModelMapState()
  }
  resetUnmappedModels()
})

test('incoming names are sanitized before being recorded or logged', async () => {
  const long = `${'x'.repeat(150)}\n${'y'.repeat(150)}`
  assert.equal(sanitizeName(long).length, NAME_MAX_LENGTH)
  assert.ok(!sanitizeName(long).includes('\n'))
  await withMap('*=qwen3-max', UPSTREAM, async (lines) => {
    assert.equal(await mapIncomingModel(long), 'qwen3-max')
    const [recorded] = getUnmappedModels()
    assert.equal(recorded.length, NAME_MAX_LENGTH)
    assert.ok(!recorded.includes('\n'))
    assert.equal(recorded, sanitizeName(long))
    for (const line of [...lines.warn, ...lines.info]) {
      assert.ok(!line.includes('\n'), 'no newline reaches a log line')
      assert.ok(!line.includes(long.replace('\n', '')), 'the full 300-char name never reaches a log line')
    }
    assert.equal(lines.warn.length, 1)
    assert.equal(lines.info.length, 1)
  })
})

test('blank model is "everything else": * target, else first t2t, else untouched; never recorded', async () => {
  await withMap('*=qwen3-max', UPSTREAM, async (lines) => {
    for (const blank of ['', '   ', undefined, null]) assert.equal(await mapIncomingModel(blank), 'qwen3-max')
    assert.deepEqual(getUnmappedModels(), [])
    assert.equal(lines.warn.length, 0)
    assert.equal(lines.info.length, 4)
    assert.match(lines.info[0], /\(empty\) -> qwen3-max \[wildcard\]/)
    // non-string values other than undefined/null pass through untouched
    assert.equal(await mapIncomingModel(123), 123)
    const obj = { id: 'x' }
    assert.equal(await mapIncomingModel(obj), obj)
  })
  await withMap('', UPSTREAM, async () => {
    assert.equal(await mapIncomingModel(''), 'qwen3.8-max')
    assert.equal(await mapIncomingModel(undefined), 'qwen3.8-max')
    assert.deepEqual(getUnmappedModels(), [])
  })
  await withMap('', [], async () => {
    assert.equal(await mapIncomingModel(''), '')
    assert.equal(await mapIncomingModel('   '), '   ')
    assert.equal(await mapIncomingModel(undefined), undefined)
    assert.equal(await mapIncomingModel(null), null)
  })
})

test('a target that is not an upstream model warns once per distinct target', async () => {
  await withMap('claude-a=qwen3.8-max-fast,claude-b=qwen3.8-max-thinking,*=nope-model', UPSTREAM, async (lines) => {
    assert.equal(await mapIncomingModel('claude-a'), 'qwen3.8-max-fast')
    assert.equal(await mapIncomingModel('claude-a'), 'qwen3.8-max-fast')
    assert.deepEqual(lines.warn, ['MODEL_MAP target "qwen3.8-max-fast" is not an upstream model'])
    assert.equal(await mapIncomingModel('claude-b'), 'qwen3.8-max-thinking')
    assert.equal(lines.warn.length, 1, 'a real suffix on a known id is a valid target')
    assert.equal(await mapIncomingModel('gpt-4o'), 'nope-model')
    assert.equal(await mapIncomingModel('gpt-4o-mini'), 'nope-model')
    const targetWarns = lines.warn.filter(line => line.includes('not an upstream model'))
    assert.deepEqual(targetWarns, [
      'MODEL_MAP target "qwen3.8-max-fast" is not an upstream model',
      'MODEL_MAP target "nope-model" is not an upstream model'
    ])
  })
})

test('a failing model fetch is logged, not swallowed', async () => {
  const original = modelsMapStub.exports.getLatestModels
  modelsMapStub.exports.getLatestModels = async () => { throw new Error('boom') }
  try {
    await withMap('*=qwen3-max', [], async (lines) => {
      assert.equal(await mapIncomingModel('gpt-4o'), 'gpt-4o')
      assert.match(lines.warn[0], /model list unavailable: boom/)
      assert.match(lines.warn[1], /MODEL_MAP "\*" not applied/)
    })
  } finally {
    modelsMapStub.exports.getLatestModels = original
  }
})

// --- buildModelMap (spec 2: dashboard rows -> MODEL_MAP raw string) ---

test('buildModelMap: valid rows + fallback produce a raw string that parseModelMap round-trips', () => {
  const { raw, errors } = buildModelMap([
    { alias: 'claude-opus-5', target: 'qwen3.8-max' },
    { alias: 'gpt-4o', target: 'qwen3.8-max-thinking' }
  ], 'qwen3-max', UPSTREAM)
  assert.deepEqual(errors, [])
  assert.equal(raw, 'claude-opus-5=qwen3.8-max,gpt-4o=qwen3.8-max-thinking,*=qwen3-max')
  assert.deepEqual({ ...parseModelMap(raw) }, {
    'claude-opus-5': 'qwen3.8-max',
    'gpt-4o': 'qwen3.8-max-thinking',
    '*': 'qwen3-max'
  })
})

test('buildModelMap: alias is trimmed, bracket-stripped and lowercased; target is trimmed and keeps its case', () => {
  const { raw, errors } = buildModelMap([{ alias: '  Claude-Opus-5 [1m][x] ', target: '  Qwen3.8-Max ' }], '', UPSTREAM)
  assert.deepEqual(errors, [])
  assert.equal(raw, 'claude-opus-5=Qwen3.8-Max')
})

test('buildModelMap: a target that is not an upstream model is reported with its row and nothing is built', () => {
  const { raw, errors } = buildModelMap([
    { alias: 'claude-a', target: 'qwen3.8-max' },
    { alias: 'claude-b', target: 'qwen3.8-max-fast' }
  ], '', UPSTREAM)
  assert.equal(raw, '')
  assert.deepEqual(errors, [{ index: 1, field: 'target', value: 'qwen3.8-max-fast', message: '"qwen3.8-max-fast" is not an upstream model' }])
  // an unknown fallback is reported under field 'fallback' with index null
  const fb = buildModelMap([], 'nope-model', UPSTREAM)
  assert.equal(fb.raw, '')
  assert.deepEqual(fb.errors, [{ index: null, field: 'fallback', value: 'nope-model', message: '"nope-model" is not an upstream model' }])
  // an empty target on a row is an error too (the UI select left blank)
  const blank = buildModelMap([{ alias: 'claude-a', target: '' }], '', UPSTREAM)
  assert.deepEqual(blank.errors, [{ index: 0, field: 'target', value: '', message: 'target is empty' }])
})

test('buildModelMap: aliases containing "=", "," or "*" are rejected', () => {
  for (const alias of ['a=b', 'a,b', '*', 'claude*', 'x\ny']) {
    const { raw, errors } = buildModelMap([{ alias, target: 'qwen3.8-max' }], '', UPSTREAM)
    assert.equal(raw, '', alias)
    assert.equal(errors.length, 1, alias)
    assert.equal(errors[0].index, 0)
    assert.equal(errors[0].field, 'alias')
    assert.match(errors[0].message, /must not contain/)
  }
  // an empty alias and an over-long alias are rejected as well
  assert.match(buildModelMap([{ alias: ' [1m] ', target: 'qwen3.8-max' }], '', UPSTREAM).errors[0].message, /alias is empty/)
  const long = buildModelMap([{ alias: 'a'.repeat(NAME_MAX_LENGTH + 1), target: 'qwen3.8-max' }], '', UPSTREAM)
  assert.match(long.errors[0].message, /longer than 200/)
  assert.equal(long.errors[0].value.length, NAME_MAX_LENGTH, 'the echoed value is bounded')
  assert.equal(buildModelMap([{ alias: 'a'.repeat(NAME_MAX_LENGTH), target: 'qwen3.8-max' }], '', UPSTREAM).errors.length, 0)
  // a target carrying a separator can never round-trip
  assert.match(buildModelMap([{ alias: 'a', target: 'qwen3.8-max,x' }], '', UPSTREAM).errors[0].message, /must not contain/)
})

test('buildModelMap: duplicate alias after case and bracket normalization is rejected once per extra row', () => {
  const { raw, errors } = buildModelMap([
    { alias: 'claude-opus-5', target: 'qwen3.8-max' },
    { alias: 'Claude-Opus-5[1m]', target: 'qwen3-max' },
    { alias: 'CLAUDE-OPUS-5', target: 'qwen3-max' }
  ], '', UPSTREAM)
  assert.equal(raw, '')
  assert.deepEqual(errors.map(e => [e.index, e.field, e.message]), [
    [1, 'alias', 'duplicate alias "claude-opus-5"'],
    [2, 'alias', 'duplicate alias "claude-opus-5"']
  ])
})

test('buildModelMap: fallback only, and empty input clears the map', () => {
  assert.deepEqual(buildModelMap([], 'qwen3.8-max-thinking', UPSTREAM), { raw: '*=qwen3.8-max-thinking', errors: [] })
  assert.deepEqual(buildModelMap([], '', UPSTREAM), { raw: '', errors: [] })
  assert.deepEqual(buildModelMap([], '   ', UPSTREAM), { raw: '', errors: [] })
  assert.deepEqual(buildModelMap(undefined, undefined, UPSTREAM), { raw: '', errors: [] })
  assert.deepEqual(buildModelMap(null, null, UPSTREAM), { raw: '', errors: [] })
  // clearing needs no upstream list
  assert.deepEqual(buildModelMap([], '', []), { raw: '', errors: [] })
})

test('buildModelMap: with no upstream list targets cannot be validated -> one upstream error, aliases still checked', () => {
  const { raw, errors } = buildModelMap([{ alias: 'claude-a', target: 'qwen3.8-max' }, { alias: 'a=b', target: 'x' }], 'qwen3-max', [])
  assert.equal(raw, '')
  assert.equal(errors[0].field, 'upstream')
  assert.match(errors[0].message, /upstream model list unavailable/)
  assert.deepEqual(errors.slice(1).map(e => [e.index, e.field]), [[1, 'alias']])
  assert.equal(buildModelMap([{ alias: 'claude-a', target: 'qwen3.8-max' }], '', undefined).errors[0].field, 'upstream')
})

test('buildModelMap: malformed input is an error, never a throw', () => {
  assert.deepEqual(buildModelMap('claude-a=qwen3.8-max', '', UPSTREAM).errors, [{ index: null, field: 'entries', value: '', message: 'entries must be an array' }])
  assert.deepEqual(buildModelMap([], { x: 1 }, UPSTREAM).errors, [{ index: null, field: 'fallback', value: '', message: 'fallback must be a string' }])
  assert.deepEqual(buildModelMap({ alias: 'a', target: 'b' }, '', UPSTREAM).errors[0].field, 'entries')
  // rows that are not objects or carry non-string fields are reported per row, not thrown
  const { errors } = buildModelMap([null, 42, { alias: 7, target: ['qwen3.8-max'] }, { alias: 'ok', target: 'qwen3.8-max' }], 123, UPSTREAM)
  assert.deepEqual(errors.map(e => [e.index, e.field]), [[null, 'fallback']])
  const rows = buildModelMap([null, 42, { alias: 7, target: ['qwen3.8-max'] }, { alias: 'ok', target: 'qwen3.8-max' }], '', UPSTREAM)
  assert.deepEqual(rows.errors.map(e => [e.index, e.field]), [[0, 'alias'], [0, 'target'], [1, 'alias'], [1, 'target'], [2, 'alias'], [2, 'target']])
})

test('buildModelMap: row count and target length are capped; every echoed value is bounded', () => {
  const rows = Array.from({ length: MODEL_MAP_MAX_ROWS + 1 }, (_, i) => ({ alias: `a${i}`, target: 'qwen3.8-max' }))
  const capped = buildModelMap(rows, '', UPSTREAM)
  assert.equal(capped.raw, '')
  assert.deepEqual(capped.errors, [{ index: null, field: 'entries', value: '201', message: 'at most 200 entries are allowed' }])
  assert.equal(buildModelMap(rows.slice(0, MODEL_MAP_MAX_ROWS), '', UPSTREAM).errors.length, 0)
  const longTarget = 'q'.repeat(NAME_MAX_LENGTH + 1)
  const long = buildModelMap([{ alias: 'a', target: longTarget }], longTarget, UPSTREAM)
  assert.deepEqual(long.errors.map(e => [e.index, e.field, e.message, e.value.length]), [
    [0, 'target', 'target is longer than 200 characters', NAME_MAX_LENGTH],
    [null, 'fallback', 'fallback is longer than 200 characters', NAME_MAX_LENGTH]
  ])
  assert.equal(buildModelMap([{ alias: 'a', target: 'q'.repeat(NAME_MAX_LENGTH) }], '', UPSTREAM).errors[0].message, `"${'q'.repeat(NAME_MAX_LENGTH)}" is not an upstream model`)
})

test('forgetUnmapped drops saved aliases from the record, case- and bracket-insensitively', () => {
  resetModelMapState()
  assert.equal(recordUnmapped('Claude-Opus-5'), true)
  assert.equal(recordUnmapped('gpt-4o'), true)
  assert.equal(recordUnmapped('keep-me'), true)
  assert.equal(forgetUnmapped(['claude-opus-5', 'GPT-4o[1m]', 'never-seen']), 2)
  assert.deepEqual(getUnmappedModels(), ['keep-me'])
  assert.equal(forgetUnmapped([]), 0)
  assert.equal(forgetUnmapped(undefined), 0)
  assert.equal(forgetUnmapped(['*', '']), 0)
  resetModelMapState()
})

test('the resolver never loads account.js', () => {
  assert.equal(require.cache[require.resolve('../src/utils/account.js')], undefined)
})
