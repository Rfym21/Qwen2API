const config = require('../config/index.js')
const { logger } = require('./logger')
const { MODEL_SUFFIXES } = require('./model-suffixes.js')

// 落到回退目标的入站模型名，去重、封顶。每个进程一份（PM2 多 worker 时各自独立）。
// 后续 dashboard（_bmad-output/implementation-artifacts/spec-model-map-ui.md，spec 2）会读它。
const UNMAPPED_CAP = 100
// 记录或打日志前先截断：请求体上限 128 MB（src/server.js），
// 不能让客户端把超长串留在内存里，也不能让换行混进日志行。
const NAME_MAX_LENGTH = 200
// dashboard 一次最多提交的映射行数
const MODEL_MAP_MAX_ROWS = 200
const unmappedModels = new Set()
let capWarned = false
let upstreamUnavailableWarned = false
const warnedTargets = new Set()

/**
 * 去掉客户端附加的尾部 [..] 后缀组，可重复、可带空格：foo[1m][x]、foo [1m] → foo
 * @param {string} name - 原始模型名
 * @returns {string} 去后缀并 trim 后的名字
 */
const stripBracketSuffix = (name) => String(name || '').trim().replace(/(\s*\[[^\]]*\])+$/, '').trim()

/**
 * 记录或打日志用的安全名字：去掉控制字符（含换行），最长 NAME_MAX_LENGTH
 * @param {string} name - 模型名
 * @returns {string}
 */
// 控制字符是这里要删的对象，正则里必须写出来
// eslint-disable-next-line no-control-regex
const sanitizeName = (name) => String(name || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, NAME_MAX_LENGTH)

/**
 * 解析 MODEL_MAP：alias=target,alias2=target2,*=fallback
 * alias 转小写并去掉尾部 [..]（查找时对入站名做同样处理），target 保留原样；
 * 无 '='、alias 或 target 为空的项静默丢弃；重复 alias 后者覆盖前者。永不抛错。
 * @param {string} raw - 环境变量原文
 * @returns {Object} 无原型对象 { alias: target }，'*' 键为通配回退
 */
const parseModelMap = (raw) => {
    const map = Object.create(null)
    for (const entry of String(raw || '').split(',')) {
        const eq = entry.indexOf('=')
        if (eq < 0) continue
        const alias = stripBracketSuffix(entry.slice(0, eq)).toLowerCase()
        const target = entry.slice(eq + 1).trim()
        if (!alias || !target) continue
        map[alias] = target
    }
    return map
}

const lookup = (map, key) => (map && typeof map[key] === 'string' && map[key]) ? map[key] : null

const modelAliases = (model) => [model?.id, model?.name, model?.display_name, model?.upstream_id]
    .filter(Boolean)
    .map(value => String(value).trim().toLowerCase())

/**
 * 名字等于某个上游 id/别名，或等于「id + 后缀表里的一个后缀」（qwen3.8-max-thinking）时为 true。
 * qwen3.8-max-fast 这类不在后缀表里的变体不算已知，会走 * 回退。大小写不敏感。
 * @param {string} name - 已去掉 [..] 的模型名
 * @param {Array} models - 上游模型列表（/api/models 的 data）
 * @returns {boolean}
 */
const isKnownUpstreamModel = (name, models) => {
    const needle = String(name || '').trim().toLowerCase()
    if (!needle || !Array.isArray(models)) return false
    return models.some(model => modelAliases(model).some(alias =>
        needle === alias || MODEL_SUFFIXES.some(suffix => needle === `${alias}${suffix}`)
    ))
}

// 出现在 alias / target 里会破坏 MODEL_MAP 原文的往返解析（* 只允许作为回退行）
const RESERVED_ALIAS_CHARS = /[,=*]/
const RESERVED_TARGET_CHARS = /[,=]/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

const asString = (value) => (typeof value === 'string' ? value : '')

/**
 * 纯函数：把 dashboard 的行 + 回退目标拼成 MODEL_MAP 原文，逐项校验。
 * alias：trim → 去 [..] → 小写；1..NAME_MAX_LENGTH 字符；不含 , = * 和控制字符；规范化后不得重复。
 * target 与非空 fallback：trim 后必须通过 isKnownUpstreamModel（允许 -thinking 等真实后缀）。
 * 上游列表为空时无法校验目标：报一条 field='upstream' 的错误，不逐行报。
 * 永不抛错；有任何错误时 raw 为 ''。空输入 → raw ''。
 * @param {Array<{alias: string, target: string}>} entries - 行
 * @param {string} fallback - '*' 的目标，空串表示不设置
 * @param {Array} upstreamModels - 上游模型列表（/api/models 的 data）
 * @returns {{ raw: string, errors: Array<{ index: number|null, field: string, value: string, message: string }> }}
 */
const buildModelMap = (entries, fallback, upstreamModels) => {
    const errors = []
    // 回显的 value 一律截断：请求体可以很大，错误响应和日志不能跟着变大
    const push = (index, field, value, message) => errors.push({ index, field, value: String(value ?? '').slice(0, NAME_MAX_LENGTH), message })

    const rows = (entries === undefined || entries === null) ? [] : entries
    if (!Array.isArray(rows)) {
        push(null, 'entries', '', 'entries must be an array')
        return { raw: '', errors }
    }
    if (rows.length > MODEL_MAP_MAX_ROWS) {
        push(null, 'entries', String(rows.length), `at most ${MODEL_MAP_MAX_ROWS} entries are allowed`)
        return { raw: '', errors }
    }
    if (fallback !== undefined && fallback !== null && typeof fallback !== 'string') {
        push(null, 'fallback', '', 'fallback must be a string')
        return { raw: '', errors }
    }

    const models = Array.isArray(upstreamModels) ? upstreamModels : []
    let upstreamMissing = false
    const checkTarget = (index, field, value) => {
        if (!value) return push(index, field, value, `${field} is empty`)
        if (value.length > NAME_MAX_LENGTH) return push(index, field, value, `${field} is longer than ${NAME_MAX_LENGTH} characters`)
        if (RESERVED_TARGET_CHARS.test(value) || CONTROL_CHARS.test(value)) {
            return push(index, field, value, `${field} must not contain "," "=" or control characters`)
        }
        if (models.length === 0) { upstreamMissing = true; return }
        if (!isKnownUpstreamModel(value, models)) push(index, field, value, `"${value}" is not an upstream model`)
    }

    const parts = []
    const seen = new Set()
    rows.forEach((row, index) => {
        const alias = stripBracketSuffix(asString(row?.alias)).toLowerCase()
        const target = asString(row?.target).trim()
        if (!alias) push(index, 'alias', alias, 'alias is empty')
        else if (alias.length > NAME_MAX_LENGTH) push(index, 'alias', alias, `alias is longer than ${NAME_MAX_LENGTH} characters`)
        else if (RESERVED_ALIAS_CHARS.test(alias) || CONTROL_CHARS.test(alias)) push(index, 'alias', alias, 'alias must not contain "," "=" "*" or control characters')
        else if (seen.has(alias)) push(index, 'alias', alias, `duplicate alias "${alias}"`)
        if (alias) seen.add(alias)
        checkTarget(index, 'target', target)
        parts.push(`${alias}=${target}`)
    })

    const fb = asString(fallback).trim()
    if (fb) {
        checkTarget(null, 'fallback', fb)
        parts.push(`*=${fb}`)
    }

    if (upstreamMissing) errors.unshift({ index: null, field: 'upstream', value: '', message: 'upstream model list unavailable; targets cannot be validated' })
    return { raw: errors.length > 0 ? '' : parts.join(','), errors }
}

const firstModelByChatType = (models, chatType) => {
    if (!Array.isArray(models)) return null
    const matched = models.find(model => model?.info?.meta?.chat_type?.includes(chatType))
    return matched?.id || null
}

/**
 * 纯函数：精确项（不区分大小写）> 上游已知 id 原样透传 > '*' 通配 > 上游第一个 t2t 模型 > 原样（已去掉 [..]）
 * 上游列表为空时分不清 Qwen id 和别名：精确项之后直接原样返回，不套用 *。
 * 空名字按「其余名字」处理：* > 第一个 t2t > 原样。
 * @param {string} name - 入站模型名（可带 [..] 后缀）
 * @param {Object} map - parseModelMap 的结果
 * @param {Array} upstreamModels - 上游模型列表
 * @returns {{ model: string, source: 'exact'|'known'|'wildcard'|'default'|'unchanged' }}
 */
const resolveModel = (name, map, upstreamModels = []) => {
    const stripped = stripBracketSuffix(name)

    const exact = stripped ? lookup(map, stripped.toLowerCase()) : null
    if (exact) return { model: exact, source: 'exact' }

    if (!Array.isArray(upstreamModels) || upstreamModels.length === 0) return { model: stripped, source: 'unchanged' }

    if (isKnownUpstreamModel(stripped, upstreamModels)) return { model: stripped, source: 'known' }

    const wildcard = lookup(map, '*')
    if (wildcard) return { model: wildcard, source: 'wildcard' }

    const fallback = firstModelByChatType(upstreamModels, 't2t')
    if (fallback) return { model: fallback, source: 'default' }

    return { model: stripped, source: 'unchanged' }
}

/**
 * 记录一个落到回退目标的入站名
 * @param {string} name - 已清洗的模型名
 * @returns {boolean} 本次是否新增（已存在或已封顶时 false）
 */
const recordUnmapped = (name) => {
    const key = String(name || '').trim()
    if (!key || unmappedModels.has(key) || unmappedModels.size >= UNMAPPED_CAP) return false
    unmappedModels.add(key)
    return true
}

/**
 * 落到回退目标的入站名快照（本进程）。spec 2 的 dashboard 会用它渲染「待分配」芯片。
 * @returns {string[]}
 */
const getUnmappedModels = () => Array.from(unmappedModels)

/**
 * 从「待分配」记录里删掉已经分配了映射的名字。记录里存的是原始大小写（只去了 [..] 和控制字符），
 * 别名是小写的，所以按去 [..] + 小写后比较。
 * @param {string[]} names - 已保存的别名
 * @returns {number} 删掉的条数
 */
const forgetUnmapped = (names) => {
    const wanted = new Set((Array.isArray(names) ? names : []).map(name => stripBracketSuffix(name).toLowerCase()).filter(Boolean))
    if (wanted.size === 0) return 0
    let removed = 0
    for (const recorded of unmappedModels) {
        if (wanted.has(stripBracketSuffix(recorded).toLowerCase())) {
            unmappedModels.delete(recorded)
            removed += 1
        }
    }
    // 腾出位置后，再次封顶时要能重新提醒
    if (removed > 0) capWarned = false
    return removed
}

const resetUnmappedModels = () => {
    unmappedModels.clear()
    capWarned = false
}

// 测试用：清掉全部模块级状态（记录、封顶标记、只打一次的 warn 标记、已提醒过的目标）
const resetModelMapState = () => {
    resetUnmappedModels()
    upstreamUnavailableWarned = false
    warnedTargets.clear()
}

const loadUpstreamModels = async () => {
    try {
        // 调用时才 require：models-map.js 顶层加载 account.js，单元测试不能碰它。
        // 不在模块顶层解构 getLatestModels，让离线测试对它的 monkeypatch 仍然生效。
        const models = await require('../models/models-map.js').getLatestModels()
        return Array.isArray(models) ? models : []
    } catch (e) {
        logger.warn(`model list unavailable: ${e.message}`, 'MODEL')
        return []
    }
}

// 每个新名字 warn 一次；封顶后只在第一次丢弃时 warn 一次，之后沉默
const noteUnmapped = (safeName, model, source) => {
    if (unmappedModels.has(safeName)) return
    if (recordUnmapped(safeName)) {
        const via = source === 'wildcard'
            ? 'MODEL_MAP "*" entry'
            : 'first upstream t2t model; add a MODEL_MAP entry to pin it'
        logger.warn(`Model "${safeName}" has no MODEL_MAP entry, using "${model}" (${via})`, 'MODEL')
        return
    }
    if (!capWarned) {
        capWarned = true
        logger.warn(`unmapped model record is full (${UNMAPPED_CAP} names); further names are not tracked`, 'MODEL')
    }
}

// 映射目标不在上游列表里（允许 -thinking 等后缀）时，每个目标提醒一次
const noteUnknownTarget = (target, upstreamModels) => {
    if (upstreamModels.length === 0 || warnedTargets.has(target) || isKnownUpstreamModel(target, upstreamModels)) return
    warnedTargets.add(target)
    logger.warn(`MODEL_MAP target "${target}" is not an upstream model`, 'MODEL')
}

/**
 * 两个请求构造器的入口都走这里：在 thinking / chat_type 判定之前把入站模型名换成 Qwen id。
 * 每次重新解析 config.modelMap（spec 2 会在运行时改写它，所以这里不缓存）。
 * @param {string} name - 请求体里的 model
 * @returns {Promise<string>} 映射后的模型名；undefined/null 之外的非字符串原样返回
 */
const mapIncomingModel = async (name) => {
    if (name !== undefined && name !== null && typeof name !== 'string') return name
    const raw = typeof name === 'string' ? name : ''

    const map = parseModelMap(config.modelMap)
    // 精确命中也加载（有缓存）：目标校验需要上游列表
    const upstreamModels = await loadUpstreamModels()
    const { model, source } = resolveModel(raw, map, upstreamModels)
    const stripped = stripBracketSuffix(raw)
    const safeName = sanitizeName(stripped)

    if (source === 'unchanged') {
        if (upstreamModels.length === 0 && !upstreamUnavailableWarned) {
            upstreamUnavailableWarned = true
            logger.warn('upstream model list unavailable; MODEL_MAP "*" not applied', 'MODEL')
        }
        return stripped || name
    }

    if (source === 'exact' || source === 'wildcard') noteUnknownTarget(model, upstreamModels)
    if ((source === 'wildcard' || source === 'default') && safeName) noteUnmapped(safeName, model, source)

    if (source !== 'known' && model !== raw) {
        const origin = stripped === raw.trim() ? '' : ` (from "${sanitizeName(raw)}")`
        logger.info(`Model map: ${safeName || '(empty)'} -> ${model} [${source}]${origin}`, 'MODEL')
    }

    return model
}

module.exports = {
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
}
