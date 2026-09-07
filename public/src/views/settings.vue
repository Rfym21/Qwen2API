<template>
    <div class="w-full min-h-screen p-4">
        <div class="container mx-auto">
            <div class="flex flex-col md:flex-row justify-between items-center mb-6 px-4 space-y-4 md:space-y-0 pt-5">
                <h1 class="text-3xl font-bold">{{ t('settings.title') }}</h1>
                <div class="flex items-center space-x-3">
                    <router-link to="/"
                        class="action-button font-bold border border-blue-200 bg-blue-50 text-blue-900 px-4 py-2 rounded-xl shadow-sm hover:bg-blue-100 hover:border-blue-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center">
                        {{ t('settings.backToDash') }}
                    </router-link>
                    <LangSwitcher />
                </div>
            </div>
            <div class="grid grid-cols-1 gap-6 p-4">
                <!-- 模型映射 -->
                <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                    <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl"></div>
                    <div class="relative flex flex-col gap-4">
                        <div class="flex flex-col gap-1">
                            <label class="text-gray-700 font-semibold text-lg">{{ t('settings.modelMapTitle') }}</label>
                            <span class="text-xs text-gray-500">{{ t('settings.modelMapHint') }}</span>
                            <span class="text-xs text-gray-500">{{ t('settings.modelMapRulesHint') }}</span>
                            <span class="text-xs text-gray-500">{{ t('settings.modelMapClusterHint') }}</span>
                            <span v-if="settings.dataSaveMode === 'none'" class="text-xs text-orange-600">{{ t('settings.modelMapNoneModeHint') }}</span>
                        </div>

                        <!-- 映射行：入站名 -> Qwen 模型 -->
                        <div class="space-y-2">
                            <div class="flex items-center justify-between">
                                <span class="text-gray-700 font-semibold">{{ t('settings.modelMapAlias') }} → {{ t('settings.modelMapTarget') }}</span>
                                <button @click="addModelMapRow()"
                                    class="bg-green-500 text-white px-3 py-1 rounded-lg text-sm hover:bg-green-600 transition-all">
                                    {{ t('settings.modelMapAdd') }}
                                </button>
                            </div>

                            <div v-if="modelMap.entries.length === 0" class="text-gray-500 text-center py-4">
                                {{ t('settings.modelMapNoRows') }}
                            </div>

                            <div v-for="(row, index) in modelMap.entries" :key="row.key"
                                class="flex flex-col md:flex-row md:items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg p-3">
                                <input v-model="row.alias" type="text" :placeholder="t('settings.modelMapAlias')"
                                    :aria-label="t('settings.modelMapAlias')" @input="modelMapDirty = true"
                                    class="flex-1 rounded-lg border-gray-300 bg-white shadow-sm h-9 text-sm px-3">
                                <span class="hidden md:inline text-gray-400">→</span>
                                <select v-model="row.target" :aria-label="t('settings.modelMapTarget')" @change="modelMapDirty = true"
                                    class="flex-1 rounded-lg border-gray-300 bg-white shadow-sm h-9 text-sm px-3">
                                    <option value="">{{ t('settings.modelMapPickTarget') }}</option>
                                    <option v-for="option in targetOptions(row.target)" :key="option.value" :value="option.value">
                                        {{ option.label }}
                                    </option>
                                </select>
                                <span class="text-xs px-2 py-1 rounded whitespace-nowrap"
                                    :class="originClass(originOf(row.alias, row.target))">
                                    {{ t('settings.modelMapOrigin' + originOf(row.alias, row.target)) }}
                                </span>
                                <button @click="removeModelMapRow(index)"
                                    class="bg-red-500 text-white px-3 py-1 rounded-lg text-sm hover:bg-red-600 transition-all">
                                    {{ t('settings.modelMapRemove') }}
                                </button>
                            </div>
                        </div>

                        <!-- 其余名字（回退） -->
                        <div class="flex flex-col md:flex-row md:items-center gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                            <span class="flex-1 text-yellow-800 font-semibold">{{ t('settings.modelMapFallback') }}</span>
                            <span class="hidden md:inline text-gray-400">→</span>
                            <select v-model="modelMap.fallback" :aria-label="t('settings.modelMapFallback')" @change="modelMapDirty = true"
                                class="flex-1 rounded-lg border-gray-300 bg-white shadow-sm h-9 text-sm px-3">
                                <option value="">{{ t('settings.modelMapFallbackNone') }}</option>
                                <option v-for="option in targetOptions(modelMap.fallback)" :key="option.value" :value="option.value">
                                    {{ option.label }}
                                </option>
                            </select>
                            <span v-if="modelMap.fallback" class="text-xs px-2 py-1 rounded whitespace-nowrap"
                                :class="originClass(fallbackOrigin())">
                                {{ t('settings.modelMapOrigin' + fallbackOrigin()) }}
                            </span>
                        </div>

                        <!-- 已出现但未分配：点击预填一行 -->
                        <div v-if="unassignedChips.length > 0" class="flex flex-col gap-1">
                            <span class="text-gray-700 font-semibold">{{ t('settings.modelMapUnassigned') }}</span>
                            <span class="text-xs text-gray-500">{{ t('settings.modelMapUnassignedHint') }}</span>
                            <div class="flex flex-wrap gap-2 mt-1">
                                <button v-for="name in unassignedChips" :key="name" @click="addModelMapRow(name)"
                                    class="text-xs bg-blue-50 border border-blue-200 text-blue-900 px-2 py-1 rounded-full hover:bg-blue-100 transition-all">
                                    + {{ name }}
                                </button>
                            </div>
                        </div>

                        <div v-if="modelMapError" class="text-sm text-red-600">{{ modelMapError }}</div>

                        <div class="flex flex-col md:flex-row gap-2 mt-2">
                            <button @click="saveModelMap" :disabled="modelMapSaving"
                                class="flex-1 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300 disabled:opacity-50">{{ t('settings.save') }}</button>
                            <button @click="resetModelMap" :disabled="modelMapSaving"
                                class="flex-1 bg-white text-gray-700 rounded-lg py-2 border border-gray-400 hover:bg-gray-100 transition-all duration-300 disabled:opacity-50">{{ t('settings.modelMapRestoreEnv') }}</button>
                        </div>
                    </div>
                </div>

                <!-- API Key 管理 -->
                <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                    <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl"></div>
                    <div class="relative flex flex-col gap-4">
                        <label class="text-gray-700 font-semibold text-lg">{{ t('settings.apiKeyTitle') }}</label>

                        <!-- 管理员密钥 -->
                        <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                            <div class="flex items-center gap-2 mb-2">
                                <span class="text-yellow-600 font-semibold">{{ t('settings.adminKey') }}</span>
                                <span class="text-xs bg-yellow-200 text-yellow-800 px-2 py-1 rounded">{{ t('settings.adminReadonly') }}</span>
                            </div>
                            <input :value="settings.adminKey" type="text" readonly
                                class="w-full rounded-lg border-gray-300 bg-gray-100 shadow-sm h-10 text-sm px-3 cursor-not-allowed">
                        </div>

                        <!-- 普通密钥列表 -->
                        <div class="space-y-2">
                            <div class="flex items-center justify-between">
                                <span class="text-gray-700 font-semibold">{{ t('settings.regularKeys') }}</span>
                                <button @click="showAddKeyModal = true"
                                    class="bg-green-500 text-white px-3 py-1 rounded-lg text-sm hover:bg-green-600 transition-all">
                                    {{ t('settings.addKey') }}
                                </button>
                            </div>

                            <div v-if="settings.regularKeys.length === 0" class="text-gray-500 text-center py-4">
                                {{ t('settings.noKeys') }}
                            </div>

                            <div v-for="(key, index) in settings.regularKeys" :key="index"
                                class="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg p-3">
                                <input :value="key" type="text" readonly
                                    class="flex-1 rounded-lg border-gray-300 bg-white shadow-sm h-8 text-sm px-3">
                                <button @click="deleteRegularKey(index)"
                                    class="bg-red-500 text-white px-3 py-1 rounded-lg text-sm hover:bg-red-600 transition-all">
                                    {{ t('settings.delete') }}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 其他设置项 -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <!-- 自动刷新 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.autoRefresh') }}</label>
                            <div class="flex items-center gap-2">
                                <input v-model="settings.autoRefresh" type="checkbox"
                                    class="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500">
                                <span>{{ t('settings.enableAutoRefresh') }}</span>
                            </div>
                            <label class="text-gray-700">{{ t('settings.refreshInterval') }}</label>
                            <input v-model.number="settings.autoRefreshInterval" type="number"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                            <button @click="saveAutoRefresh"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                    <!-- 批量登录并发数 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.batchConcurrency') }}</label>
                            <label class="text-gray-700">{{ t('settings.batchConcurrencyDesc') }}</label>
                            <input v-model.number="settings.batchLoginConcurrency" type="number" min="1" max="20"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                            <span class="text-xs text-gray-500">{{ t('settings.batchConcurrencyHint') }}</span>
                            <button @click="saveBatchLoginConcurrency"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                    <!-- 思考输出 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.thinkOutput') }}</label>
                            <div class="flex items-center gap-2">
                                <input v-model="settings.outThink" type="checkbox"
                                    class="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500">
                                <span>{{ t('settings.enableThinkOutput') }}</span>
                            </div>
                            <button @click="saveOutThink"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                    <!-- 推理输出格式 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.reasoningFormat') }}</label>
                            <div class="flex items-center gap-2">
                                <input v-model="settings.legacyReasoningInContent" type="checkbox"
                                    class="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500">
                                <span>{{ t('settings.enableLegacyReasoning') }}</span>
                            </div>
                            <span class="text-xs text-gray-500">{{ t('settings.legacyReasoningHint') }}</span>
                            <button @click="saveLegacyReasoning"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                    <!-- 搜索信息模式 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.searchMode') }}</label>
                            <select v-model="settings.searchInfoMode"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                                <option value="table">{{ t('settings.searchTable') }}</option>
                                <option value="text">{{ t('settings.searchText') }}</option>
                            </select>
                            <button @click="saveSearchInfoMode"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                    <!-- 简化模型映射 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.simpleModelMap') }}</label>
                            <div class="flex items-center gap-2">
                                <input v-model="settings.simpleModelMap" type="checkbox"
                                    class="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500">
                                <span>{{ t('settings.simpleModelMapDesc') }}</span>
                            </div>
                            <button @click="saveSimpleModelMap"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                    <!-- 聊天请求 retry 配置 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.retryTitle') }}</label>
                            <label class="text-gray-700">{{ t('settings.retryCountLabel') }}</label>
                            <input v-model.number="settings.chatRetryCount" type="number" min="0" max="10"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                            <label class="text-gray-700">{{ t('settings.retryBackoffLabel') }}</label>
                            <input v-model.number="settings.chatRetryBackoffMs" type="number" min="0" max="60000"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                            <span class="text-xs text-gray-500">{{ t('settings.retryHint') }}</span>
                            <button @click="saveRetryConfig"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 添加API Key模态框 -->
            <div v-if="showAddKeyModal"
                class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                <div class="bg-white rounded-lg p-6 w-96 max-w-90vw">
                    <h3 class="text-lg font-semibold mb-4">{{ t('settings.addKeyTitle') }}</h3>
                    <input v-model="newApiKey" type="text" :placeholder="t('settings.addKeyPlaceholder')"
                        class="w-full rounded-lg border-gray-300 shadow-sm h-10 text-sm px-3 mb-4">
                    <div class="flex gap-2 justify-end">
                        <button @click="showAddKeyModal = false"
                            class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-all">
                            {{ t('settings.cancel') }}
                        </button>
                        <button @click="addRegularKey"
                            class="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-all">
                            {{ t('settings.add') }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import axios from 'axios'
import LangSwitcher from '../components/LangSwitcher.vue'

const { t } = useI18n()

const settings = ref({
    apiKey: localStorage.getItem('apiKey'),
    adminKey: '',
    regularKeys: [],
    defaultHeaders: '',
    defaultCookie: '',
    autoRefresh: false,
    autoRefreshInterval: 21600,
    batchLoginConcurrency: 5,
    outThink: false,
    legacyReasoningInContent: false,
    searchInfoMode: 'table',
    simpleModelMap: false,
    chatRetryCount: 1,
    chatRetryBackoffMs: 400,
    dataSaveMode: ''
})

const showAddKeyModal = ref(false)
const newApiKey = ref('')

// --- 模型映射 ---
// 与后端 parseModelMap 同一规则：逗号分项，第一个 '=' 分隔，alias 去尾部 [..] 并小写，target 原样 trim。
// 服务端保存时再用 buildModelMap 规范化并校验；这里负责展示和提交前的粗检。
const stripBracketSuffix = (name) => String(name || '').trim().replace(/(\s*\[[^\]]*\])+$/, '').trim()
const normalizeAlias = (name) => stripBracketSuffix(name).toLowerCase()
const RESERVED_ALIAS_CHARS = /[,=*]/
const parseModelMap = (raw) => {
    const map = Object.create(null)
    for (const entry of String(raw || '').split(',')) {
        const eq = entry.indexOf('=')
        if (eq < 0) continue
        const alias = normalizeAlias(entry.slice(0, eq))
        const target = entry.slice(eq + 1).trim()
        if (!alias || !target) continue
        map[alias] = target
    }
    return map
}

let modelMapRowSeq = 0
const newModelMapRow = (alias = '', target = '') => ({ key: ++modelMapRowSeq, alias, target })

const modelMap = ref({
    entries: [],                 // [{ key, alias, target }]，不含 '*'
    fallback: '',                // '*' 的目标，'' 表示未设置
    active: Object.create(null), // 服务端当前生效的 map：判定「已保存」
    env: Object.create(null),    // MODEL_MAP env 解析结果：判定「env」
    targets: [],                 // 可选目标（服务端从上游列表算好的聊天模型 id）
    unmapped: []                 // getUnmappedModels()：落到回退的入站名
})
const modelMapDirty = ref(false)  // 有未保存的编辑：loadSettings 不能覆盖行
const modelMapSaving = ref(false) // 保存/恢复进行中：忽略重复点击
const modelMapError = ref('')     // 卡片里的可见错误行

const applyModelMapFromServer = (data) => {
    const targets = Array.isArray(data.modelMapTargets) ? data.modelMapTargets : []
    const unmapped = Array.isArray(data.unmappedModels) ? data.unmappedModels : []
    modelMapError.value = targets.length === 0 ? t('settings.modelMapNoTargets') : ''
    if (modelMapDirty.value) {
        // 有未保存的编辑（比如刚在别的卡片增删了 API Key 触发的重载）：只刷新下拉和芯片，行保持不动
        modelMap.value.targets = targets
        modelMap.value.unmapped = unmapped
        return
    }
    const active = parseModelMap(data.modelMap)
    const env = parseModelMap(data.modelMapEnv)
    modelMap.value = {
        entries: Object.entries(active)
            .filter(([alias]) => alias !== '*')
            .map(([alias, target]) => newModelMapRow(alias, target)),
        fallback: active['*'] || '',
        active,
        env,
        targets,
        unmapped
    }
}

// 下拉选项 = 服务端给的目标；当前值不在列表里（大小写不敏感）时也保留一项，env 里的过期目标不能被静默清掉
const targetOptions = (current) => {
    const options = modelMap.value.targets.map(id => ({ value: id, label: id }))
    const wanted = String(current || '').toLowerCase()
    if (wanted && !modelMap.value.targets.some(id => id.toLowerCase() === wanted)) {
        options.unshift({ value: current, label: `${current} ${t('settings.modelMapNotUpstream')}` })
    }
    return options
}

// 来源：Env = 这对 alias=target 同时在 env 和当前生效 map 里；Saved = 只在当前生效 map 里；其余 Unsaved
const originOfKey = (key, target) => {
    if (!key || !target) return 'Unsaved'
    const inActive = modelMap.value.active[key] === target
    if (inActive && modelMap.value.env[key] === target) return 'Env'
    return inActive ? 'Saved' : 'Unsaved'
}
const originOf = (alias, target) => {
    const key = normalizeAlias(alias)
    return (!key || key === '*') ? 'Unsaved' : originOfKey(key, target)
}
const fallbackOrigin = () => originOfKey('*', modelMap.value.fallback)
const originClass = (origin) => ({
    Env: 'bg-yellow-200 text-yellow-800',
    Saved: 'bg-green-100 text-green-800',
    Unsaved: 'bg-gray-200 text-gray-600'
}[origin])

// 芯片 = 落到回退的名字 − 已有别名 − 永远存不成别名的名字（含 , = *）
const unassignedChips = computed(() => {
    const taken = new Set(modelMap.value.entries.map(row => normalizeAlias(row.alias)).filter(Boolean))
    return modelMap.value.unmapped.filter(name => !RESERVED_ALIAS_CHARS.test(name) && !taken.has(normalizeAlias(name)))
})

const addModelMapRow = (alias = '') => {
    modelMap.value.entries.push(newModelMapRow(alias, ''))
    modelMapDirty.value = true
}
const removeModelMapRow = (index) => {
    modelMap.value.entries.splice(index, 1)
    modelMapDirty.value = true
}

// 提交前的粗检：空别名/目标、保留字符、规范化后重复。服务端仍会完整校验一遍。
const validateModelMapRows = () => {
    const seen = new Set()
    const problems = []
    modelMap.value.entries.forEach((row, index) => {
        const alias = normalizeAlias(row.alias)
        const n = index + 1
        if (!alias) problems.push(t('settings.modelMapRowEmptyAlias', { n }))
        else if (RESERVED_ALIAS_CHARS.test(alias)) problems.push(t('settings.modelMapRowReservedAlias', { n }))
        else if (seen.has(alias)) problems.push(t('settings.modelMapRowDuplicateAlias', { n, alias }))
        if (alias) seen.add(alias)
        if (!String(row.target || '').trim()) problems.push(t('settings.modelMapRowEmptyTarget', { n }))
    })
    return problems
}

const formatModelMapError = (item) => {
    const where = typeof item.index === 'number' ? `#${item.index + 1} ${item.field}` : item.field
    return `${where}: ${item.message}`
}

// persisted:false 有两种：none 模式（预期内，只在内存里）和持久化失败（要看日志）
const persistFailedText = (data) => (data?.dataSaveMode === 'none' ? t('smsg.modelMapSavedNotPersisted') : t('smsg.modelMapSavedPersistFailed'))

const saveModelMap = async () => {
    if (modelMapSaving.value) return
    const problems = validateModelMapRows()
    if (problems.length > 0) {
        alert(t('smsg.modelMapFailed') + '\n' + problems.join('\n'))
        return
    }
    modelMapSaving.value = true
    try {
        const res = await axios.post('/api/setModelMap', {
            entries: modelMap.value.entries.map(({ alias, target }) => ({ alias, target })),
            fallback: modelMap.value.fallback
        }, {
            headers: { 'Authorization': localStorage.getItem('apiKey') || '' }
        })
        modelMapDirty.value = false
        alert(res.data?.persisted === false ? persistFailedText(res.data) : t('smsg.modelMapSaved'))
        await loadSettings()
    } catch (error) {
        const data = error.response?.data
        const details = Array.isArray(data?.errors) && data.errors.length > 0
            ? data.errors.map(formatModelMapError).join('\n')
            : (data?.error || error.message)
        alert(t('smsg.modelMapFailed') + '\n' + details)
    } finally {
        modelMapSaving.value = false
    }
}

// 恢复 env：清掉 dashboard 保存的映射，MODEL_MAP 环境变量重新生效
const resetModelMap = async () => {
    if (modelMapSaving.value) return
    if (!confirm(t('smsg.modelMapConfirmReset'))) return
    modelMapSaving.value = true
    try {
        const res = await axios.post('/api/setModelMap', { reset: true }, {
            headers: { 'Authorization': localStorage.getItem('apiKey') || '' }
        })
        modelMapDirty.value = false
        alert(res.data?.persisted === false && res.data?.dataSaveMode !== 'none' ? persistFailedText(res.data) : t('smsg.modelMapReset'))
        await loadSettings()
    } catch (error) {
        alert(t('smsg.modelMapFailed') + '\n' + (error.response?.data?.error || error.message))
    } finally {
        modelMapSaving.value = false
    }
}

const loadSettings = async () => {
    try {
        const res = await axios.get('/api/settings', {
            headers: {
                'Authorization': localStorage.getItem('apiKey')
            }
        })
        settings.value.apiKey = res.data.apiKey
        settings.value.adminKey = res.data.adminKey || ''
        settings.value.regularKeys = res.data.regularKeys || []
        settings.value.defaultHeaders = JSON.stringify(res.data.defaultHeaders)
        settings.value.defaultCookie = res.data.defaultCookie
        settings.value.autoRefresh = res.data.autoRefresh
        settings.value.autoRefreshInterval = res.data.autoRefreshInterval
        settings.value.batchLoginConcurrency = res.data.batchLoginConcurrency
        settings.value.outThink = res.data.outThink
        settings.value.legacyReasoningInContent = res.data.legacyReasoningInContent
        settings.value.searchInfoMode = res.data.searchInfoMode
        settings.value.simpleModelMap = res.data.simpleModelMap
        if (res.data.chatRetryCount !== undefined) settings.value.chatRetryCount = res.data.chatRetryCount
        if (res.data.chatRetryBackoffMs !== undefined) settings.value.chatRetryBackoffMs = res.data.chatRetryBackoffMs
        settings.value.dataSaveMode = res.data.dataSaveMode || ''
        applyModelMapFromServer(res.data)
    } catch (error) {
        console.error('loadSettings error:', error)
        modelMapError.value = t('settings.modelMapLoadFailed')
    }
}

const saveApiKey = async () => {
    try {
        await axios.post('/api/setApiKey', { apiKey: settings.value.apiKey }, {
            headers: { 'Authorization': localStorage.getItem('apiKey') || '' }
        })
        alert(t('smsg.apiKeySaved'))
    } catch (error) {
        alert(t('smsg.apiKeyFailed') + error.message)
    }
}
const saveAutoRefresh = async () => {
    try {
        await axios.post('/api/setAutoRefresh', {
            autoRefresh: settings.value.autoRefresh,
            autoRefreshInterval: settings.value.autoRefreshInterval
        }, {
            headers: { 'Authorization': localStorage.getItem('apiKey') || '' }
        })
        alert(t('smsg.autoRefreshSaved'))
    } catch (error) {
        alert(t('smsg.autoRefreshFailed') + error.message)
    }
}
const saveBatchLoginConcurrency = async () => {
    try {
        await axios.post('/api/setBatchLoginConcurrency', {
            batchLoginConcurrency: settings.value.batchLoginConcurrency
        }, {
            headers: { 'Authorization': localStorage.getItem('apiKey') || '' }
        })
        alert(t('smsg.batchSaved'))
    } catch (error) {
        alert(t('smsg.batchFailed') + error.message)
    }
}
const saveOutThink = async () => {
    try {
        await axios.post('/api/setOutThink', { outThink: settings.value.outThink }, {
            headers: { 'Authorization': localStorage.getItem('apiKey') || '' }
        })
        alert(t('smsg.thinkSaved'))
    } catch (error) {
        alert(t('smsg.thinkFailed') + error.message)
    }
}
const saveLegacyReasoning = async () => {
    try {
        await axios.post('/api/setLegacyReasoning', { legacyReasoningInContent: settings.value.legacyReasoningInContent }, {
            headers: { 'Authorization': localStorage.getItem('apiKey') || '' }
        })
        alert(t('smsg.legacyReasoningSaved'))
    } catch (error) {
        alert(t('smsg.legacyReasoningFailed') + error.message)
    }
}
const saveSearchInfoMode = async () => {
    try {
        await axios.post('/api/search-info-mode', { searchInfoMode: settings.value.searchInfoMode }, {
            headers: { 'Authorization': localStorage.getItem('apiKey') || '' }
        })
        alert(t('smsg.searchModeSaved'))
    } catch (error) {
        alert(t('smsg.searchModeFailed') + error.message)
    }
}
const saveSimpleModelMap = async () => {
    try {
        await axios.post('/api/simple-model-map', { simpleModelMap: settings.value.simpleModelMap }, {
            headers: { 'Authorization': localStorage.getItem('apiKey') || '' }
        })
        alert(t('smsg.simpleMapSaved'))
    } catch (error) {
        alert(t('smsg.simpleMapFailed') + error.message)
    }
}
const saveRetryConfig = async () => {
    try {
        await axios.post('/api/setRetryConfig', {
            chatRetryCount: settings.value.chatRetryCount,
            chatRetryBackoffMs: settings.value.chatRetryBackoffMs
        }, {
            headers: { 'Authorization': localStorage.getItem('apiKey') || '' }
        })
        alert(t('smsg.retrySaved'))
    } catch (error) {
        alert(t('smsg.retryFailed') + (error.response?.data?.error || error.message))
    }
}

// API Key 管理相关函数
const addRegularKey = async () => {
    if (!newApiKey.value.trim()) {
        alert(t('smsg.enterKey'))
        return
    }

    try {
        await axios.post('/api/addRegularKey', { apiKey: newApiKey.value.trim() }, {
            headers: { 'Authorization': localStorage.getItem('apiKey') || '' }
        })
        alert(t('smsg.keyAdded'))
        newApiKey.value = ''
        showAddKeyModal.value = false
        await loadSettings()
    } catch (error) {
        alert(t('smsg.keyAddFailed') + error.message)
    }
}

const deleteRegularKey = async (index) => {
    if (!confirm(t('smsg.confirmDeleteKey'))) return

    const keyToDelete = settings.value.regularKeys[index]
    try {
        await axios.post('/api/deleteRegularKey', { apiKey: keyToDelete }, {
            headers: { 'Authorization': localStorage.getItem('apiKey') || '' }
        })
        alert(t('smsg.keyDeleted'))
        await loadSettings()
    } catch (error) {
        alert(t('smsg.keyDeleteFailed') + error.message)
    }
}

onMounted(() => {
    loadSettings()
})
</script>

<style lang="css" scoped>
.setting-card {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.3));
    box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.10);
    transition: box-shadow 0.3s, transform 0.3s;
    position: relative;
}

.setting-card:hover {
    box-shadow: 0 12px 36px 0 rgba(31, 38, 135, 0.18);
    transform: translateY(-2px) scale(1.01);
}

.action-button {
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
}
</style>
