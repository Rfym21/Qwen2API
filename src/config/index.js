const dotenv = require('dotenv')
dotenv.config()

/**
 * 解析API_KEY环境变量，支持逗号分隔的多个key
 * @returns {Object} 包含apiKeys数组和adminKey的对象
 */
const parseApiKeys = () => {
    const apiKeyEnv = process.env.API_KEY
    if (!apiKeyEnv) {
        return { apiKeys: [], adminKey: null }
    }

    const keys = apiKeyEnv.split(',').map(key => key.trim()).filter(key => key.length > 0)
    return {
        apiKeys: keys,
        adminKey: keys.length > 0 ? keys[0] : null
    }
}

const { apiKeys, adminKey } = parseApiKeys()

const config = {
    dataSaveMode: process.env.DATA_SAVE_MODE || "none",
    apiKeys: apiKeys,
    adminKey: adminKey,
    batchLoginConcurrency: Math.max(1, parseInt(process.env.BATCH_LOGIN_CONCURRENCY) || 5),
    simpleModelMap: process.env.SIMPLE_MODEL_MAP === 'true' ? true : false,
    // 模型列表缓存有效期（秒），过期后下次请求自动刷新；0 = 永不过期（旧版行为）
    modelsCacheTtl: process.env.MODELS_CACHE_TTL !== undefined ? Math.max(0, parseInt(process.env.MODELS_CACHE_TTL, 10) || 0) : 3600,
    listenAddress: process.env.LISTEN_ADDRESS || null,
    listenPort: process.env.SERVICE_PORT || 3000,
    searchInfoMode: process.env.SEARCH_INFO_MODE === 'table' ? "table" : "text",
    outThink: process.env.OUTPUT_THINK === 'true' ? true : false,
    // 推理输出格式：默认 false = 推理走 reasoning_content 字段；true = 旧版行为（<think> 并入 content）
    legacyReasoningInContent: process.env.LEGACY_REASONING_IN_CONTENT === 'true' ? true : false,
    redisURL: process.env.REDIS_URL || null,
    autoRefresh: true,
    autoRefreshInterval: 6 * 60 * 60,
    cacheMode: process.env.CACHE_MODE || "default",
    logLevel: process.env.LOG_LEVEL || "INFO",
    enableFileLog: process.env.ENABLE_FILE_LOG === 'true',
    logDir: process.env.LOG_DIR || "./logs",
    maxLogFileSize: parseInt(process.env.MAX_LOG_FILE_SIZE) || 10,
    maxLogFiles: parseInt(process.env.MAX_LOG_FILES) || 5,
    // 自定义反代URL配置
    qwenChatProxyUrl: process.env.QWEN_CHAT_PROXY_URL || "https://chat.qwen.ai",
    qwenCliProxyUrl: process.env.QWEN_CLI_PROXY_URL || "https://portal.qwen.ai",
    // 代理配置
    proxyUrl: process.env.PROXY_URL || null,
    // CLI 账户初始化开关（OAuth 设备授权流程需要人工确认，默认关闭避免初始化失败刷屏）
    cliEnabled: process.env.ENABLE_CLI === 'true',
    // chat 请求重试配置（运行时可被 web UI 覆盖，见 src/utils/data-persistence.js#loadSettings）
    chatRetryCount: Math.max(0, parseInt(process.env.CHAT_RETRY_COUNT, 10) || 1),
    chatRetryBackoffMs: Math.max(0, parseInt(process.env.CHAT_RETRY_BACKOFF_MS, 10) || 400),
    // Agent 回合协议纠正次数。这里是一次 HTTP 回合内的上游生成尝试总数，
    // 与传输错误重试分开；耗尽后必须显式失败，绝不能伪装成 finish_reason=stop。
    agentTurnMaxAttempts: Math.min(
        6,
        Math.max(2, parseInt(process.env.AGENT_TURN_MAX_ATTEMPTS, 10) || 3)
    ),
    // 面向 Anthropic 风格客户端的回合门禁放宽开关，默认关闭，严格模式行为不变。
    // Anthropic Messages API 允许同一条 assistant 消息同时携带 text 与 tool_use，
    // 所以一个完全合规的 Anthropic 客户端在严格模式下反而会被判为无效回合。
    agentTurnAllowProseWithTools: process.env.AGENT_TURN_ALLOW_PROSE_WITH_TOOLS === 'true',
    // 把没有 <agent_final> 包装但确有可见正文的回合视为正常结束，而不是 bare。
    agentTurnAcceptBareFinal: process.env.AGENT_TURN_ACCEPT_BARE_FINAL === 'true',
    // chat.qwen.ai 的 WAF 会在 JSON 请求体接近 128 KiB 时返回 captcha。
    // 提前把 Agent 全量历史外置成文本文档，给协议头和当前回合留出安全余量。
    agentContextFileThresholdBytes: Math.max(
        32 * 1024,
        parseInt(process.env.AGENT_CONTEXT_FILE_THRESHOLD_BYTES, 10) || 90 * 1024
    ),
    agentContextLivePromptBytes: Math.max(
        8 * 1024,
        parseInt(process.env.AGENT_CONTEXT_LIVE_PROMPT_BYTES, 10) || 48 * 1024
    )
}

module.exports = config
