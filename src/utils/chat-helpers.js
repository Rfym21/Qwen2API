const { logger } = require('./logger')
const { sha256Encrypt, generateUUID } = require('./tools.js')
const { normalizeAllowedToolNames, ANSWER_PHASES } = require('./tool-prompt.js')
const { uploadFileToQwenOss } = require('./upload.js')
const { getLatestModels } = require('../models/models-map.js')
const accountManager = require('./account.js')
const CacheManager = require('./img-caches.js')
const { MODEL_SUFFIXES } = require('./model-suffixes.js')

const DATA_URI_REGEX = /^data:(.+);base64,(.*)$/i
const HTTP_URL_REGEX = /^https?:\/\//i

/**
 * 拆分模型后缀
 * @param {string} model - 原始模型名称
 * @returns {{ baseModel: string, suffix: string }} 拆分结果
 */
const splitModelSuffix = (model) => {
    const modelName = String(model || '')

    for (const suffix of MODEL_SUFFIXES) {
        if (modelName.endsWith(suffix)) {
            return {
                baseModel: modelName.slice(0, -suffix.length),
                suffix
            }
        }
    }

    return {
        baseModel: modelName,
        suffix: ''
    }
}

/**
 * 根据模型别名匹配原始模型
 * @param {Array<object>} models - 原始模型列表
 * @param {string} modelName - 输入模型名称
 * @returns {object|undefined} 命中的模型
 */
const findMatchedModel = (models, modelName) => {
    const normalizedModelName = String(modelName || '').trim().toLowerCase()
    if (!normalizedModelName) {
        return undefined
    }

    return models.find(model => {
        const aliases = [
            model?.id,
            model?.name,
            model?.display_name,
            model?.upstream_id
        ]

        return aliases
            .filter(Boolean)
            .some(alias => String(alias).trim().toLowerCase() === normalizedModelName)
    })
}

/**
 * 判断是否为媒体内容项
 * @param {object} item - 内容项
 * @returns {boolean} 是否为媒体内容项
 */
const isMediaContentItem = (item) => ['image', 'image_url', 'video', 'video_url', 'input_video'].includes(item?.type)

/**
 * 提取媒体信息
 * @param {object} item - 内容项
 * @returns {{ mediaType: string, url: string|null }|null} 媒体信息
 */
const getMediaDescriptor = (item) => {
    if (!item) {
        return null
    }

    if (item.type === 'image' || item.type === 'image_url') {
        return {
            mediaType: 'image',
            url: item.image || item.url || item.image_url?.url || null
        }
    }

    if (item.type === 'video' || item.type === 'video_url') {
        return {
            mediaType: 'video',
            url: item.video || item.url || item.video_url?.url || null
        }
    }

    if (item.type === 'input_video') {
        return {
            mediaType: 'video',
            url: item.input_video?.url || item.input_video?.video_url || item.video_url?.url || null
        }
    }

    return null
}

/**
 * 构造规范化媒体内容项
 * @param {string} mediaType - 媒体类型
 * @param {string} url - 媒体链接
 * @returns {object} 规范化后的内容项
 */
const buildNormalizedMediaItem = (mediaType, url) => {
    if (mediaType === 'video') {
        return {
            type: 'video',
            video: url
        }
    }

    return {
        type: 'image',
        image: url
    }
}

/**
 * 解析并上传媒体内容项
 * @param {object} item - 原始内容项
 * @param {object} imgCacheManager - 图片缓存管理器
 * @returns {Promise<object|null>} 规范化后的媒体内容项
 */
const normalizeMediaContentItem = async (item, imgCacheManager) => {
    const mediaDescriptor = getMediaDescriptor(item)
    if (!mediaDescriptor?.url) {
        return null
    }

    const { mediaType, url } = mediaDescriptor
    if (HTTP_URL_REGEX.test(url)) {
        return buildNormalizedMediaItem(mediaType, url)
    }

    const matchedDataURI = url.match(DATA_URI_REGEX)
    if (!matchedDataURI) {
        return buildNormalizedMediaItem(mediaType, url)
    }

    const mimeType = matchedDataURI[1]
    const base64Content = matchedDataURI[2]
    const fileExtension = mimeType?.split('/')[1] || (mediaType === 'video' ? 'mp4' : 'png')
    const filename = `${generateUUID()}.${fileExtension}`
    const signature = sha256Encrypt(base64Content)

    try {
        if (mediaType === 'image' && imgCacheManager.cacheIsExist(signature)) {
            return buildNormalizedMediaItem(mediaType, imgCacheManager.getCache(signature).url)
        }

        const buffer = Buffer.from(base64Content, 'base64')
        const uploadAccount = accountManager.getAccount()
        const uploadResult = await uploadFileToQwenOss(buffer, filename, uploadAccount ? uploadAccount.token : null, uploadAccount)

        if (!uploadResult || uploadResult.status !== 200) {
            return null
        }

        if (mediaType === 'image') {
            imgCacheManager.addCache(signature, uploadResult.file_url)
        }

        return buildNormalizedMediaItem(mediaType, uploadResult.file_url)
    } catch (error) {
        logger.error(`${mediaType === 'video' ? '视频' : '图片'}上传失败`, 'UPLOAD', '', error)
        return null
    }
}

/**
 * 判断聊天类型
 * @param {string} model - 模型名称
 * @param {boolean} search - 是否搜索模式
 * @returns {string} 聊天类型 ('search' 或 't2t')
 */
const isChatType = (model) => {
    if (!model) return 't2t'
    if (model.includes('-search')) {
        return 'search'
    } else if (model.includes('-image-edit')) {
        return 'image_edit'
    } else if (model.includes('-image')) {
        return 't2i'
    } else if (model.includes('-video')) {
        return 't2v'
    } else if (model.includes('-deep-research')) {
        return 'deep_research'
    } else {
        return 't2t'
    }
}

/**
 * 判断是否启用思考模式
 * @param {string} model - 模型名称
 * @param {boolean} enable_thinking - 是否启用思考
 * @param {number} thinking_budget - 思考预算
 * @returns {object} 思考配置对象
 */
const isThinkingEnabled = async (model, enable_thinking, thinking_budget) => {
    const thinking_config = {
        "output_schema": "phase",
        "thinking_enabled": false,
        "thinking_budget": 81920
    }

    if (!model) return thinking_config

    // 上游对不可跳过思考的模型（think_skip.enable === false，如 qwen3.8 系列）强制要求
    // thinking_enabled=true，否则返回 invalid_input 错误；qwen3.7 及以下系列可接受 false
    let modelSupportsThinking = false
    try {
        const latestModels = await getLatestModels()
        const { baseModel } = splitModelSuffix(model)
        const matchedModel = findMatchedModel(latestModels, baseModel)
        modelSupportsThinking = matchedModel?.info?.meta?.think_skip?.enable === false
    } catch (e) {
        // 查询失败时退回名称判断，不阻塞请求
    }

    if (model.includes('-thinking') || enable_thinking || modelSupportsThinking) {
        thinking_config.thinking_enabled = true
    }

    if (thinking_budget && !Number.isNaN(Number(thinking_budget)) && Number(thinking_budget) > 0 && Number(thinking_budget) < 131072) {
        thinking_config.budget = Number(thinking_budget)
    }

    return thinking_config
}

/**
 * 解析模型名称,移除特殊后缀
 * @param {string} model - 原始模型名称
 * @returns {string} 解析后的模型名称
 */
const parserModel = async (model) => {
    if (!model) return 'qwen3-coder-plus'

    try {
        const { baseModel } = splitModelSuffix(model)
        const latestModels = await getLatestModels()
        const matchedModel = findMatchedModel(latestModels, baseModel)

        return matchedModel?.id || baseModel
    } catch (e) {
        const { baseModel } = splitModelSuffix(model)
        return baseModel || 'qwen3-coder-plus'
    }
}

/**
 * 从消息中提取文本内容
 * @param {string|Array} content - 消息内容
 * @returns {string} 提取的文本
 */
const extractTextFromContent = (content) => {
    if (typeof content === 'string') {
        return content
    } else if (Array.isArray(content)) {
        const textParts = content
            .filter(item => item.type === 'text')
            .map(item => item.text || '')
        return textParts.join(' ')
    }
    return ''
}

/**
 * 格式化消息为文本（包含角色标注）
 * @param {object} message - 单条消息
 * @returns {string} 格式化后的消息文本
 */
const formatSingleMessage = (message) => {
    const role = message.role
    const content = extractTextFromContent(message.content)
    return content.trim() ? JSON.stringify({ role, content }) : ''
}

/**
 * 格式化历史消息为文本前缀
 * @param {Array} messages - 消息数组(不包含最后一条)
 * @returns {string} 格式化后的历史消息
 */
const formatHistoryMessages = (messages) => {
    const formattedParts = []
    
    for (let message of messages) {
        const formatted = formatSingleMessage(message)
        if (formatted) {
            formattedParts.push(formatted)
        }
    }
    
    return formattedParts.length > 0 ? formattedParts.join('\n') : ''
}

/**
 * 解析消息格式,处理图片上传和消息结构
 * @param {Array} messages - 原始消息数组
 * @param {object} thinking_config - 思考配置
 * @param {string} chat_type - 聊天类型
 * @returns {Promise<Array>} 解析后的消息数组
 */
const parserMessages = async (messages, thinking_config, chat_type) => {
    try {
        const feature_config = thinking_config
        const imgCacheManager = new CacheManager()

        // 如果只有一条消息,使用原有逻辑处理（不标注角色）
        if (messages.length <= 1) {
            logger.network('单条消息，使用原格式处理', 'PARSER')
            return await processOriginalLogic(messages, thinking_config, chat_type, imgCacheManager)
        }

        // 多条消息的情况:分离历史消息和最后一条消息
        logger.network('多条消息，格式化处理并标注角色', 'PARSER')
        const historyMessages = messages.slice(0, -1)
        const lastMessage = messages[messages.length - 1]

        // 格式化历史消息为文本前缀
        const historyText = formatHistoryMessages(historyMessages)

        // 处理最后一条消息
        let finalContent = []
        let lastMessageText = ''
        const lastMessageRole = lastMessage.role

        if (typeof lastMessage.content === 'string') {
            lastMessageText = lastMessage.content
        } else if (Array.isArray(lastMessage.content)) {
            // 处理最后一条消息中的内容
            for (let item of lastMessage.content) {
                if (item.type === 'text') {
                    lastMessageText += item.text || ''
                } else if (isMediaContentItem(item)) {
                    const normalizedMediaItem = await normalizeMediaContentItem(item, imgCacheManager)
                    if (normalizedMediaItem) {
                        finalContent.push(normalizedMediaItem)
                    }
                }
            }
        }

        // 网页上游只接受一个当前消息，因此用 JSONL 信封无损保留角色和换行。
        // 旧版用分号拼接 role:content，内容自身含分号/冒号时会破坏消息边界。
        const envelopeParts = []
        if (historyText) {
            envelopeParts.push('# Conversation history (JSONL)', historyText)
        }
        if (lastMessageText.trim()) {
            envelopeParts.push('# Current message', JSON.stringify({
                role: lastMessageRole,
                content: lastMessageText
            }))
        }
        const combinedText = envelopeParts.join('\n')

        // 如果有图片,创建包含文本和图片的content数组
        if (finalContent.length > 0) {
            finalContent.unshift({
                type: 'text',
                text: combinedText,
                chat_type: 't2t',
                feature_config: {
                    "output_schema": "phase",
                    "thinking_enabled": false,
                }
            });

            return [
                {
                    "role": "user",
                    "content": finalContent,
                    "chat_type": chat_type,
                    "extra": {},
                    "feature_config": feature_config
                }
            ]
        } else {
            // 纯文本情况
            return [
                {
                    "role": "user",
                    "content": combinedText,
                    "chat_type": chat_type,
                    "extra": {},
                    "feature_config": feature_config
                }
            ]
        }

    } catch (e) {
        logger.error('消息解析失败', 'PARSER', '', e)
        return [
            {
                "role": "user",
                "content": "直接返回字符串: '聊天历史处理有误...'",
                "chat_type": "t2t",
                "extra": {},
                "feature_config": {
                    "output_schema": "phase",
                    "enabled": false,
                }
            }
        ]
    }
}

/**
 * 原有的单条消息处理逻辑
 * @param {Array} messages - 消息数组
 * @param {object} thinking_config - 思考配置
 * @param {string} chat_type - 聊天类型
 * @param {object} imgCacheManager - 图片缓存管理器
 * @returns {Promise<Array>} 处理后的消息数组
 */
const processOriginalLogic = async (messages, thinking_config, chat_type, imgCacheManager) => {
    const feature_config = thinking_config

    for (let message of messages) {
        if (message.role === 'user' || message.role === 'assistant') {
            message.chat_type = "t2t"
            message.extra = {}
            message.feature_config = {
                "output_schema": "phase",
                "thinking_enabled": false,
            }

            if (!Array.isArray(message.content)) continue

            const newContent = []

            for (let item of message.content) {
                if (isMediaContentItem(item)) {
                    const normalizedMediaItem = await normalizeMediaContentItem(item, imgCacheManager)
                    if (normalizedMediaItem) {
                        newContent.push(normalizedMediaItem)
                    }
                } else if (item.type === 'text') {
                    item.chat_type = 't2t'
                    item.feature_config = {
                        "output_schema": "phase",
                        "thinking_enabled": false,
                    }

                    if (newContent.length >= 2) {
                        messages.push({
                            "role": "user",
                            "content": item.text,
                            "chat_type": "t2t",
                            "extra": {},
                            "feature_config": {
                                "output_schema": "phase",
                                "thinking_enabled": false,
                            }
                        })
                    } else {
                        newContent.push(item)
                    }
                }
            }

            message.content = newContent
        } else {
            if (Array.isArray(message.content)) {
                let system_prompt = ''
                for (let item of message.content) {
                    if (item.type === 'text') {
                        system_prompt += item.text
                    }
                }
                if (system_prompt) {
                    message.content = system_prompt
                }
            }
        }
    }

    messages[messages.length - 1].feature_config = feature_config
    messages[messages.length - 1].chat_type = chat_type

    return messages
}

/**
 * 是否为思考阶段 phase（兼容 thinking_summary）
 * @param {string} phase
 * @returns {boolean}
 */
const isThinkPhase = (phase) => phase === 'think' || phase === 'thinking' || phase === 'thinking_summary'
// ANSWER_PHASES 从 tool-prompt.js 引入：原生工具调用累积器用同一集合判定客户端候选。

/**
 * 创建上游 delta 归一化器：将 thinking_summary 的 extra.summary_thought 增量转为 phase=think 的 content
 * summary 帧为增长数组，只 emit 新增段落，避免重复。
 *
 * 返回的函数带一个 `.interceptedToolNames` 属性（string[]）：每丢弃一帧
 * role:function 就记一个去重后的名字（上限 {@link INTERCEPTED_NAMES_CAP}，防止
 * 多帧注入无限增长）。这是平台拦截原生工具调用的现场证据，Anthropic/OpenAI 的
 * Agent 循环靠它决定 intercepted 重试。消费者只能**就地清空**
 * （`arr.length = 0`），绝不能重新赋值 —— 非流式循环的按轮重置正依赖同一个
 * 数组引用。
 * @returns {(delta: object) => ({ phase: string, content: string }|null)}
 */
const INTERCEPTED_NAMES_CAP = 20

/**
 * 客户端工具名谓词。归一化器的拦截证据与原生累积器的结果帧认领（anthropic.js
 * closeByName）共用这一条，两处永远不会对"这是不是客户端的工具"得出不同答案。
 * 未传集合 → 一律为真（签名向后兼容）；传了集合 → 带真实名字且名字在集合里。
 * @param {Iterable<string>|Set<string>|null|undefined} clientToolNames
 * @returns {(name: unknown) => boolean}
 */
const createClientToolNamePredicate = (clientToolNames) => {
    const names = normalizeAllowedToolNames(clientToolNames)
    return (name) => names
        ? typeof name === 'string' && name.length > 0 && names.has(name)
        : true
}

const createUpstreamDeltaNormalizer = (options = {}) => {
    // clientToolNames：客户端本次请求声明的工具名集合。传入后，只有**带真实名字**
    // 且名字在集合里的 role:function 丢弃帧才计入 interceptedToolNames —— 平台自己
    // 的内部工具（web_search / web_extractor）和无名帧会在纯散文回合上出现，把它们
    // 当拦截证据会烧掉共享的协议恢复名额、触发假 intercepted 重试（实测 2026-08-31）。
    // 无名帧永远不算证据：'unknown' 只是日志占位符，若客户端恰好声明了一个叫
    // "unknown" 的工具，占位符不能替无名帧冒充它。不传则照旧全记：签名向后兼容。
    // 日志不过滤 —— 每一次丢弃都要留痕。
    // normalizeAllowedToolNames（tool-prompt.js）做同一件事；两处保持同一语义。
    const isClientToolName = createClientToolNamePredicate(options.clientToolNames)
    let summaryThoughtCount = 0
    const normalize = (delta) => {
        if (!delta) return null

        // Defect A: Drop Qwen's own tool-registry results (role="function").
        // These are upstream injections, never the assistant's answer.
        // Defect A protects OUR stream; the model's context still saw the platform's
        // injection. The dropped names are the live evidence of that interception,
        // so surface them for retry decisions instead of only logging.
        if (delta.role === 'function') {
            const droppedName = typeof delta.name === 'string' && delta.name.length > 0
                ? delta.name
                : null
            const countsAsEvidence = isClientToolName(droppedName)
            const interceptedName = droppedName || 'unknown'
            if (countsAsEvidence &&
                normalize.interceptedToolNames.length < INTERCEPTED_NAMES_CAP &&
                !normalize.interceptedToolNames.includes(interceptedName)) {
                normalize.interceptedToolNames.push(interceptedName)
            }
            logger.warn(
                `Dropped upstream role:function delta with phase "${delta.phase}" and name "${interceptedName}"`,
                'UPSTREAM_NORMALIZER'
            )
            return null
        }

        const rawPhase = delta.phase
        const hasReasoningContent = typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0
        const hasContent = typeof delta.content === 'string' && delta.content.length > 0
        const useReasoningContent = hasReasoningContent && !ANSWER_PHASES.has(rawPhase)

        // 部分模型或上游版本不会返回 phase。此时普通 content 按 answer 处理，
        // reasoning_content 按 think 处理，避免把完整正文静默丢弃。
        if (!isThinkPhase(rawPhase) && !ANSWER_PHASES.has(rawPhase) && !hasReasoningContent && !hasContent) {
            return null
        }

        let content = useReasoningContent
            ? delta.reasoning_content
            : (hasContent ? delta.content : '')
        if (rawPhase === 'thinking_summary') {
            const thoughts = delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content
            if (Array.isArray(thoughts) && thoughts.length > summaryThoughtCount) {
                content = thoughts.slice(summaryThoughtCount).filter(Boolean).join('\n')
                summaryThoughtCount = thoughts.length
            } else {
                content = ''
            }
        }

        if (!content) return null
        return {
            phase: (isThinkPhase(rawPhase) || useReasoningContent) ? 'think' : 'answer',
            content
        }
    }
    // 附着在归一化函数上的拦截信号（见上方 JSDoc）。调用签名不变——
    // 不读这个属性的消费者完全不受影响。
    normalize.interceptedToolNames = []
    return normalize
}

module.exports = {
    isChatType,
    isThinkingEnabled,
    parserModel,
    parserMessages,
    formatHistoryMessages,
    isThinkPhase,
    createClientToolNamePredicate,
    createUpstreamDeltaNormalizer
}
