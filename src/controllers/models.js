const { getLatestModels } = require('../models/models-map.js')
const config = require('../config/index.js')

/**
 * 构造对外暴露的模型信息
 * @param {object} model - 原始模型信息
 * @param {string} suffix - 变体后缀
 * @returns {object} 对外模型信息
 */
const buildPublicModelData = (model, suffix = '') => {
    const modelData = JSON.parse(JSON.stringify(model))
    const upstreamModelID = String(model?.id || '')
    const displayModelID = String(model?.name || model?.id || '')

    modelData.name = `${displayModelID}${suffix}`
    modelData.id = `${upstreamModelID}${suffix}`
    modelData.upstream_id = upstreamModelID
    modelData.display_name = displayModelID

    return modelData
}

const handleGetModels = async (req, res) => {
    const models = []

    const ModelsMap = await getLatestModels()

    for (const model of ModelsMap) {
        models.push(buildPublicModelData(model))

        if (config.simpleModelMap) {
            continue
        }

        const isThinking = model?.info?.meta?.abilities?.thinking
        const isSearch = model?.info?.meta?.chat_type?.includes('search')
        const isImage = model?.info?.meta?.chat_type?.includes('t2i')
        const isVideo = model?.info?.meta?.chat_type?.includes('t2v')
        const isImageEdit = model?.info?.meta?.chat_type?.includes('image_edit')
        const isDeepResearch = model?.info?.meta?.chat_type?.includes('deep_research')

        if (isThinking) {
            models.push(buildPublicModelData(model, '-thinking'))
        }

        if (isSearch) {
            models.push(buildPublicModelData(model, '-search'))
        }

        if (isThinking && isSearch) {
            models.push(buildPublicModelData(model, '-thinking-search'))
        }

        if (isImage) {
            models.push(buildPublicModelData(model, '-image'))
        }

        if (isVideo) {
            models.push(buildPublicModelData(model, '-video'))
        }

        if (isImageEdit) {
            models.push(buildPublicModelData(model, '-image-edit'))
        }

        // if (isDeepResearch) {
        //     models.push(buildPublicModelData(model, '-deep-research'))
        // }
    }
    res.json({
        "object": "list",
        "data": models
    })
}

module.exports = {
    handleGetModels
}
