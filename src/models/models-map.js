const axios = require('axios')
const accountManager = require('../utils/account.js')
const { getSsxmodItna, getSsxmodItna2 } = require('../utils/ssxmod-manager')
const { getProxyAgent, getChatBaseUrl, applyProxyToAxiosConfig } = require('../utils/proxy-helper')
const { generateUUID } = require('../utils/tools.js')
const { logger } = require('../utils/logger')

let cachedModels = null
let fetchPromise = null

const getLatestModels = async (force = false) => {
    // 如果有缓存且不强制刷新，直接返回
    if (cachedModels && !force) {
        return cachedModels
    }

    // 如果正在获取，返回当前的 Promise
    if (fetchPromise) {
        return fetchPromise
    }

    const chatBaseUrl = getChatBaseUrl()
    // 一次取出账户对象，token 与 proxy 走同一个账号，避免 round-robin 错位
    const account = accountManager.getAccount()
    const proxyAgent = getProxyAgent(account)

    const requestConfig = {
        headers: {
            'sec-ch-ua-platform': '"Windows"',
            'authorization': `Bearer ${account ? account.token : ''}`,
            'referer': `${chatBaseUrl}/`,
            'accept-language': 'zh-CN,zh;q=0.9',
            'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
            'content-type': 'application/json',
            'bx-v': '2.5.36',
            'accept': '*/*',
            'accept-encoding': 'gzip, deflate, br, zstd',
            // WAF 客户端标识头
            'source': 'web',
            'version': '0.2.63',
            'timezone': new Date().toString().replace(/GMT\+0800/, 'GMT+0800'),
            'x-request-id': generateUUID(),
            'connection': 'keep-alive',
            ...(account?.token && {
                'cookie': `token=${account.token};ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`
            }),
            'origin': chatBaseUrl,
            'host': chatBaseUrl.replace('https://', ''),
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
        }
    }

    // 添加代理配置
    if (proxyAgent) {
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
    }

    fetchPromise = axios.get(`${chatBaseUrl}/api/models`, requestConfig).then(response => {
        cachedModels = response.data.data
        fetchPromise = null
        return cachedModels
    }).catch(error => {
        logger.error(`获取模型列表失败: ${error.message}`, 'MODEL')
        fetchPromise = null
        return []
    })

    return fetchPromise
}

/**
 * 根据聊天类型获取默认模型
 * @param {string} chatType - 聊天类型
 * @returns {Promise<string|null>} 默认模型 ID
 */
const getDefaultModelByChatType = async (chatType) => {
    const models = await getLatestModels()

    const matchedModel = models.find(model => model?.info?.meta?.chat_type?.includes(chatType))
    return matchedModel?.id || null
}

module.exports = {
    getLatestModels,
    getDefaultModelByChatType
}
