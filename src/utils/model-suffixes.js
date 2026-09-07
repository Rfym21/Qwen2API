// 模型名后缀表（最长的在前，splitModelSuffix 按顺序取第一个命中）。
// chat-helpers.js 与 model-map.js 共用；本模块不 require 任何东西，
// 这样 model-map.js 加载时不会牵出 account.js。
const MODEL_SUFFIXES = [
    '-thinking-search',
    '-image-edit',
    '-deep-research',
    '-thinking',
    '-search',
    '-video',
    '-image'
]

module.exports = { MODEL_SUFFIXES }
