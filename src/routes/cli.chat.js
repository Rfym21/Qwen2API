const express = require('express')
const router = express.Router()
const { apiKeyVerify } = require('../middlewares/authorization.js')
const { handleCliChatCompletion } = require('../controllers/cli.chat.js')
const accountManager = require('../utils/account.js')
const { DEFAULT_CLI_QUOTA_LIMIT } = require('../utils/cli-support.js')

router.post('/cli/v1/chat/completions',
    apiKeyVerify,
    async (req, res, next) => {
        const availableAccounts = accountManager.accountTokens.filter(account =>
            account.cli_info && account.cli_info.request_number < DEFAULT_CLI_QUOTA_LIMIT
        )

        if (availableAccounts.length === 0) {
            return res.status(503).json({
                error: '没有可用的CLI账户，请稍后重试'
            })
        }

        const randomAccount = availableAccounts[Math.floor(Math.random() * availableAccounts.length)]
        req.account = randomAccount
        next()
    },
    handleCliChatCompletion
)

module.exports = router