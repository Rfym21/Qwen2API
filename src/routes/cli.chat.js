const express = require('express')
const router = express.Router()
const { apiKeyVerify } = require('../middlewares/authorization.js')
const { handleCliChatCompletion } = require('../controllers/cli.chat.js')
const accountManager = require('../utils/account.js')
const { DEFAULT_CLI_QUOTA_LIMIT } = require('../utils/cli-support.js')

router.post('/cli/v1/chat/completions',
    apiKeyVerify,
    async (req, res, next) => {
        // 异步初始化新账号（不阻塞当前请求）
        const noCliAccount = accountManager.accountTokens.filter(account => !account.cli_info && account.cli_unavailable_reason !== 'unsupported')
        if (noCliAccount.length > 0) {
            const randomNewAccount = noCliAccount[Math.floor(Math.random() * noCliAccount.length)]
            // 异步初始化，不等待结果
            accountManager.initializeCliForAccount(randomNewAccount).catch(error => {
                console.error(`异步初始化CLI账户失败 (${randomNewAccount.email}):`, error)
            })
        }

        // 获取当前可用的CLI账户用于本次请求
        const availableAccounts = accountManager.accountTokens.filter(account =>
            account.cli_info && account.cli_info.request_number < DEFAULT_CLI_QUOTA_LIMIT
        )

        if (availableAccounts.length === 0) {
            return res.status(503).json({
                error: '没有可用的CLI账户，请稍后重试'
            })
        }

        // 随机选择一个可用账户用于本次请求
        const randomAccount = availableAccounts[Math.floor(Math.random() * availableAccounts.length)]
        req.account = randomAccount
        next()
    },
    handleCliChatCompletion
)

module.exports = router