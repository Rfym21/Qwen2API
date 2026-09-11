const multer = require('multer')

const DEFAULT_UPLOAD_LIMITS = {
    fileSize: 100 * 1024 * 1024,
    files: 10,
    fields: 32,
    parts: 42,
    fieldSize: 1024 * 1024,
    fieldNameSize: 100,
    fieldNestingDepth: 4,
    fieldArrayIndexLimit: 31
}

const createUploadMiddleware = (limits = {}) => {
    const parseUpload = multer({
        storage: multer.memoryStorage(),
        limits: { ...DEFAULT_UPLOAD_LIMITS, ...limits }
    }).any()

    return (request, response, next) => {
        const respondWithUploadError = (error) => {
            if (!error) return next()

            const isMulterError = error instanceof multer.MulterError
            const isLimitError = isMulterError && error.code.startsWith('LIMIT_') &&
                error.code !== 'LIMIT_UNEXPECTED_FILE'

            return response.status(isLimitError ? 413 : 400).json({
                error: {
                    message: isLimitError ? error.message : 'Invalid multipart/form-data request',
                    type: 'invalid_request_error',
                    code: isMulterError ? error.code : 'invalid_multipart'
                }
            })
        }

        // Multer skips invalid Content-Type headers; do not let malformed multipart
        // requests fall through to the media handlers as if they were JSON.
        const contentType = request.headers['content-type'] || ''
        if (/^multipart(?:\/|;|$)/i.test(contentType) && !request.is('multipart/form-data')) {
            return respondWithUploadError(new Error('Invalid multipart content type'))
        }

        parseUpload(request, response, respondWithUploadError)
    }
}

module.exports = { createUploadMiddleware }
