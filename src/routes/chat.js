const express = require('express')
const rateLimit = require('express-rate-limit')
const router = express.Router()
const { apiKeyVerify } = require('../middlewares/authorization.js')
const { createUploadMiddleware } = require('../middlewares/upload.js')
const { processRequestBody } = require('../middlewares/chat-middleware.js')
const { handleChatCompletion } = require('../controllers/chat.js')
const {
    handleImageVideoCompletion,
    handleOpenAIImagesGeneration,
    handleOpenAIImagesEdit,
    handleOpenAIVideoGeneration
} = require('../controllers/chat.image.video.js')

const parseMediaUpload = createUploadMiddleware()

// Limita cada API key a un maximo de peticiones por minuto en los endpoints
// costosos (chat/imagenes/video) para evitar el agotamiento de recursos por
// clientes autenticados de alto volumen (CWE-770).
const heavyEndpointLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.apiKey || req.ip
})

const selectChatCompletion = (req, res, next) => {
    const ChatCompletionMap = {
        't2t': handleChatCompletion,
        'search': handleChatCompletion,
        't2i': handleImageVideoCompletion,
        't2v': handleImageVideoCompletion,
        'image_edit': handleImageVideoCompletion,
        //   'deep_research': handleDeepResearchCompletion
    }

    const chatType = req.body.chat_type
    const chatCompletion = ChatCompletionMap[chatType]
    if (chatCompletion) {
        chatCompletion(req, res, next)
    } else {
        handleImageVideoCompletion(req, res, next)
    }
}

router.post('/v1/chat/completions',
    apiKeyVerify,
    heavyEndpointLimiter,
    processRequestBody,
    selectChatCompletion
)

router.post('/v1/images/generations',
    apiKeyVerify,
    heavyEndpointLimiter,
    handleOpenAIImagesGeneration
)

router.post('/v1/images/edits',
    apiKeyVerify,
    heavyEndpointLimiter,
    parseMediaUpload,
    handleOpenAIImagesEdit
)

router.post('/v1/videos',
    apiKeyVerify,
    heavyEndpointLimiter,
    parseMediaUpload,
    handleOpenAIVideoGeneration
)


module.exports = router
