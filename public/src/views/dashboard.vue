<template>
  <div class="dashboard-scroll w-100vw h-100vh p-4 overflow-y-auto">
    <div class="container mx-auto">
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 px-4 space-y-4 md:space-y-0 pt-5">
        <h1 class="text-4xl font-bold">{{ t('dash.title') }} <span class="text-gray-500 text-sm">by 兜豆子</span></h1>
        <div class="flex flex-col md:flex-row md:items-center w-full md:w-auto gap-3">
          <!-- 6 buttons in 2 rows on desktop (3+3), 2 columns on mobile -->
          <div class="flex gap-2">
          <button @click="showAddModal = true"
                  class="action-button font-bold border border-green-200 bg-green-50 text-green-900 px-4 py-2 rounded-xl shadow-sm hover:bg-green-100 hover:border-green-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center">
            {{ t('dash.addAccount') }}
          </button>
          <button @click="refreshAllAccounts"
                  :disabled="isRefreshingAll"
                  :class="[
                    'action-button font-bold px-4 py-2 rounded-xl shadow-sm transition-all duration-300 transform active:translate-y-0',
                    isRefreshingAll
                      ? 'bg-purple-400 text-white border-purple-400 refreshing-button-purple cursor-not-allowed transform-none'
                      : 'macaron-purple-button text-purple-800 hover:-translate-y-1'
                  ]">
            <span v-if="isRefreshingAll" class="flex items-center space-x-2">
              <svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span>{{ t('dash.refreshing') }}</span>
            </span>
            <span v-else>{{ t('dash.refreshAll') }}</span>
          </button>
          <button @click="forceRefreshAllAccounts"
                  :disabled="isForceRefreshingAll"
                  :class="[
                    'action-button font-bold px-4 py-2 rounded-xl shadow-sm transition-all duration-300 transform active:translate-y-0',
                    isForceRefreshingAll
                      ? 'bg-pink-400 text-white border-pink-400 refreshing-button-pink cursor-not-allowed transform-none'
                      : 'macaron-pink-button text-pink-800 hover:-translate-y-1'
                  ]">
            <span v-if="isForceRefreshingAll" class="flex items-center space-x-2">
              <svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span>{{ t('dash.forceRefreshing') }}</span>
            </span>
            <span v-else>{{ t('dash.forceRefresh') }}</span>
          </button>
          <button @click="exportAccounts"
                  class="action-button font-bold border border-yellow-200 bg-yellow-50 text-yellow-900 px-4 py-2 rounded-xl shadow-sm hover:bg-yellow-100 hover:border-yellow-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center">
            {{ t('dash.export') }}
          </button>
          <router-link to="/statistics"
                       class="action-button font-bold border border-indigo-200 bg-indigo-50 text-indigo-900 px-4 py-2 rounded-xl shadow-sm hover:bg-indigo-100 hover:border-indigo-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center">
            {{ t('dash.statistics') }}
          </router-link>
          <router-link to="/settings"
                       class="action-button font-bold border border-blue-200 bg-blue-50 text-blue-900 px-4 py-2 rounded-xl shadow-sm hover:bg-blue-100 hover:border-blue-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center">
            {{ t('dash.settings') }}
          </router-link>
          <router-link to="/chat"
                       class="action-button font-bold border border-blue-200 bg-blue-50 text-blue-900 px-4 py-2 rounded-xl shadow-sm hover:bg-blue-100 hover:border-blue-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center">
            {{ t('dash.chat') }}
          </router-link>
          </div>
          <LangSwitcher class="self-center md:self-auto" />
        </div>
      </div>

      <!-- 分页控制区 -->
      <div class="flex justify-between items-center px-4 mb-4">
        <div class="flex items-center space-x-2">
          <span class="text-gray-700">{{ t('dash.perPage') }}</span>
          <select v-model="pageSize" @change="changePageSize" class="rounded-lg border-gray-300 bg-white/50 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300">
            <option :value="10">10</option>
            <option :value="20">20</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
            <option :value="200">200</option>
          </select>
        </div>
        <div class="flex space-x-2 items-center">
          <span class="text-gray-700">{{ t('dash.totalItems', { n: totalItems }) }}</span>
          <button
            @click="changePage(currentPage - 1)"
            :disabled="currentPage === 1"
            :class="[
              'px-3 py-1 rounded-lg transition-all duration-300',
              currentPage === 1 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
            ]"
          >
            {{ t('dash.prevPage') }}
          </button>
          <span class="text-gray-700">{{ currentPage }}/{{ totalPages }}</span>
          <button
            @click="changePage(currentPage + 1)"
            :disabled="currentPage === totalPages || totalPages === 0"
            :class="[
              'px-3 py-1 rounded-lg transition-all duration-300',
              currentPage === totalPages || totalPages === 0 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
            ]"
          >
            {{ t('dash.nextPage') }}
          </button>
        </div>
      </div>

      <!-- 多选操作区 -->
      <div class="flex justify-between items-center px-4 mb-4">
        <div class="flex items-center space-x-3">
          <label class="inline-flex items-center cursor-pointer group">
            <div class="relative">
              <input type="checkbox"
                    v-model="selectAll"
                    @change="toggleSelectAll"
                    class="sr-only peer">
              <div class="w-6 h-6 bg-white border-2 border-gray-300 rounded-lg peer-checked:bg-indigo-500 peer-checked:border-indigo-500 transition-all duration-300 flex items-center justify-center">
                <svg v-show="selectAll" class="w-4 h-4 text-white" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              </div>
            </div>
            <span class="ml-2 text-gray-700 group-hover:text-indigo-700 transition-colors duration-200">{{ t('dash.selectAll') }}</span>
          </label>
          <button
            @click="deleteSelected"
            :disabled="selectedTokens.length === 0"
            :class="[
              'px-4 py-1.5 rounded-lg transition-all duration-300 border flex items-center space-x-1',
              selectedTokens.length === 0 ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' : 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100'
            ]"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
            </svg>
            <span>{{ t('dash.deleteSelected', { n: selectedTokens.length }) }}</span>
          </button>
        </div>
        <button
          @click="showDeleteAllConfirm = true"
          class="px-4 py-1.5 rounded-lg border border-red-300 bg-red-50 text-red-700 hover:bg-red-100 transition-all duration-300 flex items-center space-x-1"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
          </svg>
          <span>{{ t('dash.deleteAll') }}</span>
        </button>
      </div>

      <!-- Token列表 -->
      <div class="max-h-[calc(75vh)] overflow-y-auto pr-2 scrollbar-hidden">
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-4">
          <div v-for="token in displayedTokens"
               :key="token.email"
               class="token-card group relative overflow-hidden rounded-2xl transition-all duration-300 hover:shadow-2xl pt-4"
               :class="[
                 { 'ring-2 ring-indigo-500 ring-opacity-75': isSelected(token.email) },
                 { 'opacity-60 grayscale': isOnCooldown(token.email) }
               ]">
            <div class="absolute top-3 left-3 z-10">
              <label class="custom-checkbox cursor-pointer">
                <input type="checkbox"
                       :checked="isSelected(token.email)"
                       @change="toggleSelect(token.email)"
                       class="sr-only peer">
                <div class="checkbox-icon w-6 h-6 bg-white/70 backdrop-blur-sm border-2 border-gray-300 rounded-lg peer-checked:bg-indigo-500 peer-checked:border-indigo-500 transition-all duration-300 flex items-center justify-center shadow-sm hover:shadow">
                  <svg v-show="isSelected(token.email)" class="w-4 h-4 text-white transform scale-0 peer-checked:scale-100 transition-transform duration-300" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
              </label>
            </div>
            <div class="absolute top-3 right-3 z-10 flex items-center gap-1 text-lg leading-none select-none"
                 :title="getStatusTooltip(token.email)">
              <span>{{ getStatusEmoji(token.email) }}</span>
              <span v-if="isOnCooldown(token.email)"
                    class="text-sm font-mono text-gray-700">{{ getCountdown(token.email) }}</span>
            </div>
            <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30"></div>
            <div class="relative p-6 flex flex-col gap-4">
              <div class="flex flex-col space-y-3">
                <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
                  <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
                    <span class="text-gray-700 min-w-[96px] text-left font-semibold">📧 Email:</span>
                    <span class="font-medium whitespace-nowrap text-left">{{ token.email }}</span>
                  </div>
                  <button @click="copyToClipboard(token.email)" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-2 py-1 text-base">📋</button>
                </div>
                <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
                  <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
                    <span class="text-gray-700 min-w-[96px] text-left font-semibold">🔑 Passwd:</span>
                    <span class="font-medium whitespace-nowrap text-left">{{ token.password }}</span>
                  </div>
                  <button @click="copyToClipboard(token.password)" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-2 py-1 text-base">📋</button>
                </div>
                <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
                  <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
                    <span class="text-gray-700 min-w-[96px] text-left font-semibold">🔐 Token:</span>
                    <span class="font-medium whitespace-nowrap text-left text-sm">{{ token.token }}</span>
                  </div>
                  <button @click="copyToClipboard(token.token)" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-2 py-1 text-base">📋</button>
                </div>
                <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
                  <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
                    <span class="text-gray-700 min-w-[96px] text-left font-semibold">⏰ Expire:</span>
                    <span class="font-medium whitespace-nowrap text-left">{{ new Date(token.expires * 1000).toLocaleString() }}</span>
                  </div>
                  <button @click="copyToClipboard(new Date(token.expires * 1000).toLocaleString())" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-2 py-1 text-base">📋</button>
                </div>
                <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
                  <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
                    <span class="text-gray-700 min-w-[96px] text-left font-semibold">🌐 Proxy:</span>
                    <span class="font-medium whitespace-nowrap text-left text-sm" :title="token.proxy || ''">{{ token.proxy || '—' }}</span>
                  </div>
                  <button v-if="token.proxy" @click="copyToClipboard(token.proxy)" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-2 py-1 text-base">📋</button>
                </div>
              </div>

              <div class="bg-white/40 backdrop-blur-sm border border-white/40 rounded-2xl px-4 py-3 text-sm space-y-1 transition-all">
                <div class="flex items-baseline justify-between gap-2">
                  <span class="text-gray-600">{{ t('dash.acct.chatToday') }}:</span>
                  <span class="font-medium text-gray-800 text-xs md:text-sm">
                    <span :title="String(getAccountStats(token.email).chat.input)">{{ formatCompact(getAccountStats(token.email).chat.input) }}</span>
                    in /
                    <span :title="String(getAccountStats(token.email).chat.output)">{{ formatCompact(getAccountStats(token.email).chat.output) }}</span>
                    out
                  </span>
                </div>
                <template v-if="getStatusKind(token.email) === 'cli_unsupported'">
                  <div class="flex items-baseline justify-between gap-2 w-full text-left">
                    <span class="text-gray-400 border-b border-dotted border-gray-300 transition-colors"
                          :title="getStatusTooltip(token.email)">
                      {{ t('dash.acct.cliToday') }}:
                    </span>
                    <span class="font-medium text-gray-400 text-xs md:text-sm"
                          :title="getStatusTooltip(token.email)">
                      {{ t('dash.acct.cliUnavailableShort') }}
                    </span>
                  </div>
                </template>
                <button v-else type="button"
                        @click="toggleCliExpanded"
                        class="flex items-baseline justify-between gap-2 w-full text-left focus:outline-none">
                  <span class="text-gray-600 border-b border-dotted border-gray-400 hover:text-gray-800 transition-colors">
                    {{ t('dash.acct.cliToday') }}:
                  </span>
                  <span class="font-medium text-gray-800 text-xs md:text-sm flex items-center gap-1">
                    <span>{{ getCliRequestNumber(token.email) }} / {{ getCliQuotaLimit(token.email) }} {{ t('dash.acct.calls') }}</span>
                    <span class="text-xs text-gray-400 transition-transform duration-200" :class="{ 'rotate-90': cliExpanded }">▸</span>
                  </span>
                </button>
                <transition name="fade">
                  <div v-if="cliExpanded && getStatusKind(token.email) !== 'cli_unsupported'" class="space-y-1 pt-1">
                    <div class="text-xs text-gray-500 text-right">
                      {{ t('dash.acct.cliSuccess') }}: {{ getAccountStats(token.email).cli.calls }}
                    </div>
                    <div class="h-2 bg-gray-200/60 rounded-full overflow-hidden">
                      <div :style="{ width: getCliProgressPct(token.email) + '%' }"
                           :class="getCliProgressColor(token.email)"
                           class="h-full transition-all duration-300"></div>
                    </div>
                    <div class="text-xs text-gray-500 text-right">
                      <span :title="String(getAccountStats(token.email).cli.input)">{{ formatCompact(getAccountStats(token.email).cli.input) }}</span>
                      in /
                      <span :title="String(getAccountStats(token.email).cli.output)">{{ formatCompact(getAccountStats(token.email).cli.output) }}</span>
                      out
                    </div>
                  </div>
                </transition>
              </div>

              <div class="pt-4 mt-auto border-t border-gray-200/50">
                <div class="flex flex-row gap-2">
                  <button @click="openEditProxy(token)"
                          class="flex-1 py-2 px-2 rounded-lg transition-all duration-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 text-xs md:text-sm">
                    {{ t('dash.editProxy') }}
                  </button>
                  <button @click="refreshToken(token.email)"
                          :disabled="refreshingTokens.includes(token.email)"
                          :class="[
                            'flex-1 py-2 px-2 rounded-lg transition-all duration-300 flex items-center justify-center gap-1 text-xs md:text-sm',
                            refreshingTokens.includes(token.email)
                              ? 'bg-green-400 text-white refreshing-button-green cursor-not-allowed'
                              : 'macaron-green-button text-green-600 hover:bg-green-100 border border-green-200'
                          ]">
                    <span v-if="refreshingTokens.includes(token.email)" class="flex items-center gap-1">
                      <svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <span>{{ t('dash.refreshing') }}</span>
                    </span>
                    <span v-else>{{ t('dash.refreshToken') }}</span>
                  </button>
                  <button @click="deleteToken(token.email)"
                          class="flex-1 py-2 px-2 rounded-lg border border-red-200 text-red-600 group-hover:bg-red-50 transition-all duration-300 hover:bg-red-100 text-xs md:text-sm">
                    {{ t('dash.deleteAccount') }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 删除全部确认对话框 -->
    <div v-if="showDeleteAllConfirm"
         class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
         @click.self="showDeleteAllConfirm = false">
      <div class="relative bg-white/90 backdrop-blur-lg rounded-2xl p-6 w-11/12 max-w-md transform transition-all duration-300 scale-100 opacity-100">
        <h2 class="text-2xl font-bold text-red-600 mb-4">{{ t('dash.dangerTitle') }}</h2>
        <p class="text-gray-700 mb-6">{{ t('dash.dangerText', { n: totalItems }) }}</p>
        <div class="flex justify-end space-x-4">
          <button @click="showDeleteAllConfirm = false"
                  class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 transition-all duration-300">
            {{ t('dash.cancel') }}
          </button>
          <button @click="deleteAllAccounts"
                  class="px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-700 transition-all duration-300">
            {{ t('dash.confirmDelete') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 添加账号模态框 -->
    <div v-if="showAddModal"
         class="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6 backdrop-blur-sm"
          @click.self="closeAddModal">
      <div :class="[
            'relative mx-auto flex max-h-[calc(100vh-3rem)] w-full flex-col overflow-hidden rounded-2xl bg-white/80 p-6 backdrop-blur-lg transform transition-all duration-300 scale-100 opacity-100',
            addMode === 'batch' ? 'max-w-3xl' : 'max-w-md'
          ]">
        <div class="mb-6 flex shrink-0 border-b border-gray-200">
          <button :class="['flex-1 py-2 font-bold transition-all rounded-t-xl duration-300', addMode==='single' ? 'text-gray-600 border-b-2 border-gray-500 bg-gray-50/60' : 'text-gray-500 bg-transparent', isBatchAdding ? 'opacity-50 cursor-not-allowed' : '']" @click="!isBatchAdding && (addMode='single')">{{ t('dash.singleAdd') }}</button>
          <button :class="['flex-1 py-2 font-bold transition-all rounded-t-xl duration-300', addMode==='batch' ? 'text-gray-600 border-b-2 border-gray-500 bg-gray-50/60' : 'text-gray-500 bg-transparent', isBatchAdding ? 'opacity-50 cursor-not-allowed' : '']" @click="!isBatchAdding && (addMode='batch')">{{ t('dash.batchAdd') }}</button>
        </div>
        <div class="modal-scroll min-h-0 flex-1 overflow-y-auto pr-2">
        <transition name="fade" mode="out-in">
          <div v-if="addMode==='single'" key="single" class="pr-1">
            <h2 class="text-xl font-bold mb-4">{{ t('dash.addTitle') }}</h2>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700">Email</label>
                <input v-model="newAccount.email" type="email"
                       class="mt-1 block w-full rounded-xl border-gray-300 bg-white/50 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700">Password</label>
                <input v-model="newAccount.password" type="password"
                       class="mt-1 block w-full rounded-xl border-gray-300 bg-white/50 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700">{{ t('dash.proxyLabel') }}</label>
                <input v-model="newAccount.proxy" type="text" :placeholder="t('dash.proxyPlaceholder')"
                       :class="[
                         'mt-1 block w-full rounded-xl bg-white/50 shadow-sm transition-all duration-300 h-12 text-base px-4',
                         newAccountProxyValid
                           ? 'border-gray-300 focus:border-indigo-500 focus:ring-indigo-500'
                           : 'border-red-400 focus:border-red-500 focus:ring-red-500'
                       ]">
                <p v-if="!newAccountProxyValid" class="mt-1 text-sm text-red-600">{{ t('msg.proxyInvalid') }}</p>
              </div>
              <div class="flex justify-end space-x-4 pt-4">
                <button @click="closeAddModal"
                        class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 transition-all duration-300">
                  {{ t('dash.cancel') }}
                </button>
                <button @click="addToken"
                        :disabled="!newAccountProxyValid"
                        class="px-4 py-2 rounded-xl bg-black text-white hover:bg-white hover:text-black transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed">
                  {{ t('dash.add') }}
                </button>
              </div>
            </div>
          </div>
          <div v-else key="batch" class="pr-1">
            <h2 class="text-xl font-bold mb-4 px-4">{{ t('dash.batchTitle') }}</h2>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 px-4 pb-2">{{ t('dash.batchLabel') }}</label>
                <textarea v-model="batchAccounts"
                          :disabled="isBatchAdding"
                          rows="6"
                          class="mt-1 block w-full rounded-xl border-gray-300 bg-white/50 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-36 text-base px-4 py-3 resize-none disabled:opacity-70"></textarea>
              </div>
              <div v-if="batchTask" class="mx-4 rounded-2xl border border-slate-200 bg-white/70 p-5 shadow-sm">
                <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div class="text-sm text-slate-500">{{ t('dash.taskStatus') }}</div>
                    <div class="mt-1 flex items-center gap-3">
                      <span :class="['inline-flex rounded-full px-3 py-1 text-xs font-semibold', batchTaskStatusClass]">
                        {{ batchTaskStatusText }}
                      </span>
                      <span class="text-sm text-slate-600">{{ batchTask.message }}</span>
                    </div>
                  </div>
                  <div class="text-sm text-slate-500">
                    {{ t('dash.taskId') }} <span class="font-mono text-slate-700">{{ batchTask.taskId }}</span>
                  </div>
                </div>

                <div class="mt-4">
                  <div class="mb-2 flex items-center justify-between text-sm text-slate-600">
                    <span>{{ t('dash.progress') }}</span>
                    <span>{{ batchTask.completed }}/{{ batchTask.total }} · {{ batchTask.progress.toFixed(0) }}%</span>
                  </div>
                  <div class="h-3 overflow-hidden rounded-full bg-slate-200">
                    <div class="h-full rounded-full bg-gradient-to-r from-sky-500 via-cyan-500 to-emerald-500 transition-all duration-500" :style="batchTaskProgressStyle"></div>
                  </div>
                </div>

                <div class="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
                  <div class="rounded-xl bg-slate-50 px-4 py-3">
                    <div class="text-xs text-slate-500">{{ t('dash.total') }}</div>
                    <div class="mt-1 text-lg font-semibold text-slate-800">{{ batchTask.total }}</div>
                  </div>
                  <div class="rounded-xl bg-emerald-50 px-4 py-3">
                    <div class="text-xs text-emerald-600">{{ t('dash.success') }}</div>
                    <div class="mt-1 text-lg font-semibold text-emerald-700">{{ batchTask.success }}</div>
                  </div>
                  <div class="rounded-xl bg-rose-50 px-4 py-3">
                    <div class="text-xs text-rose-600">{{ t('dash.failed') }}</div>
                    <div class="mt-1 text-lg font-semibold text-rose-700">{{ batchTask.failed }}</div>
                  </div>
                  <div class="rounded-xl bg-amber-50 px-4 py-3">
                    <div class="text-xs text-amber-600">{{ t('dash.skipped') }}</div>
                    <div class="mt-1 text-lg font-semibold text-amber-700">{{ batchTask.skipped }}</div>
                  </div>
                  <div class="rounded-xl bg-violet-50 px-4 py-3">
                    <div class="text-xs text-violet-600">{{ t('dash.invalid') }}</div>
                    <div class="mt-1 text-lg font-semibold text-violet-700">{{ batchTask.invalid }}</div>
                  </div>
                </div>

                <div v-if="batchTask.activeEmails?.length" class="mt-4 rounded-xl bg-sky-50 px-4 py-3">
                  <div class="text-sm font-medium text-sky-700">{{ t('dash.processing') }}</div>
                  <div class="mt-2 flex flex-wrap gap-2">
                    <span v-for="email in batchTask.activeEmails" :key="email" class="rounded-full bg-white px-3 py-1 text-xs text-sky-700 shadow-sm">
                      {{ email }}
                    </span>
                  </div>
                </div>

                <div v-if="batchTask.recentResults?.length" class="mt-4">
                  <div class="mb-2 text-sm font-medium text-slate-700">{{ t('dash.recentResults') }}</div>
                  <div class="max-h-52 space-y-2 overflow-y-auto pr-1">
                    <div v-for="item in batchTask.recentResults" :key="`${item.email}-${item.status}-${item.message}`" class="flex items-start justify-between rounded-xl border border-slate-200 bg-white px-4 py-3">
                      <div class="min-w-0 pr-4">
                        <div class="truncate text-sm font-medium text-slate-800">{{ item.email }}</div>
                        <div class="mt-1 text-xs text-slate-500">{{ item.message }}</div>
                      </div>
                      <span :class="['inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold', item.status === 'success' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700']">
                        {{ item.status === 'success' ? t('dash.success') : t('dash.failed') }}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div class="flex justify-end space-x-4 pt-4">
                <button @click="closeAddModal"
                        class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 transition-all duration-300 disabled:opacity-50">
                  {{ isBatchAdding ? t('dash.continueBackground') : t('dash.close') }}
                </button>
                <button @click="addBatchTokens"
                        :disabled="isBatchAdding"
                        class="px-4 py-2 rounded-xl bg-black text-white hover:bg-white hover:text-black transition-all duration-300 disabled:opacity-50">
                  {{ isBatchAdding ? t('dash.batchRunning') : t('dash.batchStart') }}
                </button>
              </div>
            </div>
          </div>
        </transition>
        </div>
      </div>
    </div>

    <!-- 修改代理模态框 -->
    <div v-if="showEditProxyModal"
         class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
         @click.self="closeEditProxyModal">
      <div class="relative bg-white/90 backdrop-blur-lg rounded-2xl p-6 w-11/12 max-w-md transform transition-all duration-300 scale-100 opacity-100">
        <h2 class="text-xl font-bold mb-2">{{ t('dash.editProxyTitle') }}</h2>
        <p class="text-sm text-gray-600 mb-4">{{ t('dash.editProxyHint') }}</p>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700">Email</label>
            <div class="mt-1 px-4 py-2 rounded-xl bg-gray-100 text-gray-700">{{ editProxy.email }}</div>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700">{{ t('dash.proxyLabel') }}</label>
            <input v-model="editProxy.proxy" type="text" :placeholder="t('dash.proxyPlaceholder')"
                   :disabled="isSavingProxy"
                   :class="[
                     'mt-1 block w-full rounded-xl bg-white/50 shadow-sm transition-all duration-300 h-12 text-base px-4 disabled:opacity-70',
                     editProxyValid
                       ? 'border-gray-300 focus:border-indigo-500 focus:ring-indigo-500'
                       : 'border-red-400 focus:border-red-500 focus:ring-red-500'
                   ]">
            <p v-if="!editProxyValid" class="mt-1 text-sm text-red-600">{{ t('msg.proxyInvalid') }}</p>
          </div>
          <div class="flex justify-end space-x-3 pt-2">
            <button @click="closeEditProxyModal"
                    :disabled="isSavingProxy"
                    class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 transition-all duration-300 disabled:opacity-50">
              {{ t('dash.cancel') }}
            </button>
            <button @click="clearProxy"
                    :disabled="isSavingProxy"
                    class="px-4 py-2 rounded-xl bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-all duration-300 disabled:opacity-50">
              {{ t('dash.clearProxy') }}
            </button>
            <button @click="saveProxy"
                    :disabled="isSavingProxy || !editProxyValid"
                    class="px-4 py-2 rounded-xl bg-black text-white hover:bg-white hover:text-black border border-black transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed">
              {{ t('dash.save') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Toast 通知 -->
    <div v-if="toast.show"
         :class="[
           'fixed top-4 right-4 z-50 px-6 py-4 rounded-xl shadow-lg transform transition-all duration-300 max-w-md',
           toast.type === 'success' ? 'bg-emerald-500 text-white' :
           toast.type === 'warning' ? 'bg-amber-500 text-white' : 'bg-red-500 text-white'
         ]">
      <div class="flex items-center space-x-2">
        <svg v-if="toast.type === 'success'" class="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
        </svg>
        <svg v-else-if="toast.type === 'warning'" class="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
        </svg>
        <svg v-else class="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
        </svg>
        <span class="whitespace-pre-line">{{ toast.message }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import axios from 'axios'
import LangSwitcher from '../components/LangSwitcher.vue'
import { formatCompact as _formatCompact } from '../utils/format.js'

const { t } = useI18n()

const tokens = ref([])
const showAddModal = ref(false)
const addMode = ref('single')
const newAccount = ref({
  email: '',
  password: '',
  proxy: ''
})
const showEditProxyModal = ref(false)
const editProxy = ref({ email: '', proxy: '' })
const isSavingProxy = ref(false)

// 与后端 src/utils/proxy-helper.js#PROXY_URL_REGEX 保持一致
const PROXY_URL_REGEX = /^(https?|socks5):\/\/[^\s]+$/i
const isValidProxy = (value) => {
  if (!value) return true
  const trimmed = String(value).trim()
  if (!trimmed) return true
  return PROXY_URL_REGEX.test(trimmed)
}
const newAccountProxyValid = computed(() => isValidProxy(newAccount.value.proxy))
const editProxyValid = computed(() => isValidProxy(editProxy.value.proxy))

const batchAccounts = ref('')
const isBatchAdding = ref(false)
const batchTask = ref(null)
const batchTaskPollTimer = ref(null)
const batchTaskNotified = ref(false)

// 分页相关
const displayedTokens = ref([])
const currentPage = ref(1)
const pageSize = ref(10)
const totalItems = ref(0)
const totalPages = computed(() => Math.max(1, Math.ceil(totalItems.value / pageSize.value)))
const isLoading = ref(false)

// 多选相关
const selectedTokens = ref([])
const selectAll = ref(false)
const showDeleteAllConfirm = ref(false)

// 刷新相关
const isRefreshingAll = ref(false)
const isForceRefreshingAll = ref(false)
const refreshingTokens = ref([])

// Per-account stats (Qwen2API-3wg.2)
const accountStats = ref({})
const statsInterval = ref(null)
const cliQuotaLimit = ref(2000)
const DEFAULT_STATS = Object.freeze({
  chat: { input: 0, output: 0 },
  cli: { calls: 0, input: 0, output: 0 }
})

const getAccountStats = (email) => accountStats.value[email]?.stats || DEFAULT_STATS
const getCliRequestNumber = (email) => accountStats.value[email]?.cliRequestNumber || 0
const getCliQuotaLimit = (email) => {
  const perAccountLimit = accountStats.value[email]?.cliQuotaLimit
  if (typeof perAccountLimit === 'number') return perAccountLimit
  return cliQuotaLimit.value
}
const getCliProgressPct = (email) => {
  const limit = getCliQuotaLimit(email)
  if (limit <= 0) return 0
  return Math.min(100, getCliRequestNumber(email) / limit * 100)
}
const getCliProgressColor = (email) => {
  const pct = getCliProgressPct(email)
  if (pct >= 80) return 'bg-red-500'
  if (pct >= 50) return 'bg-amber-500'
  return 'bg-emerald-500'
}

// Compact number formatting (Qwen2API-j7x): 415575 → '415к', 1500 → '1.5к', 1500000 → '1.5M'.
// Implementation moved to ../utils/format.js (shared with /statistics).
const formatCompact = (n) => _formatCompact(n, { unitK: t('dash.acct.unitK'), unitM: t('dash.acct.unitM') })

// CLI accordion (Qwen2API-ao2): свёрнут по умолчанию, состояние общее для всех карточек в localStorage.
const cliExpanded = ref(localStorage.getItem('cliExpanded') === '1')
const toggleCliExpanded = () => {
  cliExpanded.value = !cliExpanded.value
  localStorage.setItem('cliExpanded', cliExpanded.value ? '1' : '0')
}

// Per-account status indicator (Qwen2API-3wg.3)
const STATUS_EMOJI = Object.freeze({
  active: '🟢',
  warn: '🟡',
  cooldown: '🔴',
  token_expiring: '🪫',
  cli_unsupported: '⚪'
})
const nowTick = ref(Date.now())
let tickInterval = null
// Map<email, cooldownEndsAt> — refetch suppression per-account.
// Single global flag would block refetch for other accounts after first expiry.
const cooldownRefetched = new Map()

const getStatusKind = (email) => accountStats.value[email]?.status?.kind || 'active'
const getStatusEmoji = (email) => STATUS_EMOJI[getStatusKind(email)] || STATUS_EMOJI.active
const isOnCooldown = (email) => {
  const s = accountStats.value[email]?.status
  return s?.kind === 'cooldown' && typeof s?.cooldownEndsAt === 'number'
}

const formatAgo = (ms) => {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec} ${t('dash.acct.status.unitSec')}`
  return `${Math.floor(sec / 60)} ${t('dash.acct.status.unitMin')}`
}

const formatCountdown = (ms) => {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(sec / 60)).padStart(2, '0')
  const ss = String(sec % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

const getCountdown = (email) => {
  const s = accountStats.value[email]?.status
  if (s?.kind !== 'cooldown' || typeof s?.cooldownEndsAt !== 'number') return ''
  return formatCountdown(s.cooldownEndsAt - nowTick.value)
}

const getStatusTooltip = (email) => {
  const s = accountStats.value[email]?.status
  const kind = s?.kind || 'active'
  if (kind === 'cooldown' && typeof s?.cooldownEndsAt === 'number') {
    return t('dash.acct.status.cooldown', { until: formatCountdown(s.cooldownEndsAt - nowTick.value) })
  }
  if (kind === 'warn') {
    const ago = typeof s?.lastErrorAt === 'number' ? formatAgo(nowTick.value - s.lastErrorAt) : ''
    if (s?.lastErrorCode !== null && s?.lastErrorCode !== undefined && s?.lastErrorCode !== '') {
      return t('dash.acct.status.warn', { code: s.lastErrorCode, ago })
    }
    return t('dash.acct.status.warnNoCode', { ago })
  }
  if (kind === 'token_expiring') {
    return t('dash.acct.status.tokenExpiring')
  }
  if (kind === 'cli_unsupported') {
    return t('dash.acct.status.cliUnsupported')
  }
  return t('dash.acct.status.active')
}

const fetchAccountStats = async () => {
  try {
    const res = await axios.get('/api/accountStats', {
      headers: getAuthHeaders()
    })
    const map = {}
    for (const entry of res.data?.accounts || []) {
      if (entry?.email) map[entry.email] = entry
    }
    accountStats.value = map
    if (typeof res.data?.cliQuotaLimit === 'number') {
      cliQuotaLimit.value = res.data.cliQuotaLimit
    }
    // Drop suppression entries where account is no longer in cooldown OR
    // cooldownEndsAt changed (new cooldown cycle → must allow refetch again).
    for (const [email, cachedEndsAt] of cooldownRefetched) {
      const s = map[email]?.status
      if (s?.kind !== 'cooldown' || s?.cooldownEndsAt !== cachedEndsAt) {
        cooldownRefetched.delete(email)
      }
    }
  } catch (error) {
    console.error('fetchAccountStats error:', error)
  }
}

// Auto-refetch when any account's cooldown expires (per-account suppression via Map).
// Marks every expired-but-not-yet-refetched account in the suppression Map, then
// fires a single fetchAccountStats (one call refreshes status for all accounts).
watch([nowTick, accountStats], () => {
  const stats = accountStats.value
  let shouldRefetch = false
  for (const email of Object.keys(stats)) {
    const s = stats[email]?.status
    if (s?.kind !== 'cooldown' || typeof s?.cooldownEndsAt !== 'number') continue
    if (nowTick.value >= s.cooldownEndsAt && cooldownRefetched.get(email) !== s.cooldownEndsAt) {
      cooldownRefetched.set(email, s.cooldownEndsAt)
      shouldRefetch = true
    }
  }
  if (shouldRefetch) fetchAccountStats()
})

// Toast 通知
const toast = ref({
  show: false,
  message: '',
  type: 'success'
})
const batchTaskStatusText = computed(() => {
  const status = batchTask.value?.status
  if (status === 'completed') return t('dash.statusCompleted')
  if (status === 'failed') return t('dash.statusFailed')
  if (status === 'running') return t('dash.statusRunning')
  if (status === 'pending') return t('dash.statusPending')
  return t('dash.statusNotStarted')
})
const batchTaskStatusClass = computed(() => {
  const status = batchTask.value?.status
  if (status === 'completed') return 'bg-emerald-100 text-emerald-700'
  if (status === 'failed') return 'bg-rose-100 text-rose-700'
  if (status === 'running') return 'bg-sky-100 text-sky-700'
  if (status === 'pending') return 'bg-amber-100 text-amber-700'
  return 'bg-slate-100 text-slate-700'
})
const batchTaskProgressStyle = computed(() => ({
  width: `${Math.max(0, Math.min(100, Number(batchTask.value?.progress || 0)))}%`
}))

const getAuthHeaders = () => ({
  'Authorization': localStorage.getItem('apiKey') || ''
})

const clearBatchTaskPolling = () => {
  if (batchTaskPollTimer.value) {
    clearTimeout(batchTaskPollTimer.value)
    batchTaskPollTimer.value = null
  }
}

const resetBatchTaskState = (clearInput = false) => {
  clearBatchTaskPolling()
  batchTask.value = null
  batchTaskNotified.value = false
  isBatchAdding.value = false

  if (clearInput) {
    batchAccounts.value = ''
  }
}

const buildBatchTaskMessage = (task) => {
  let message = t('msg.batchComplete', { n: task.success })
  if (task.failed > 0) message += ', ' + t('msg.batchFailed', { n: task.failed })
  if (task.skipped > 0) message += ', ' + t('msg.batchSkipped', { n: task.skipped })
  if (task.invalid > 0) message += ', ' + t('msg.batchInvalid', { n: task.invalid })
  if (task.failedEmails?.length > 0) {
    message += '\n' + t('msg.failedAccounts') + ' ' + task.failedEmails.slice(0, 10).join(', ')
  }
  return message
}

const finalizeBatchTask = async (task) => {
  clearBatchTaskPolling()
  batchTask.value = task
  isBatchAdding.value = false

  if (task.success > 0) {
    await getTokens()
  }

  if (!batchTaskNotified.value) {
    batchTaskNotified.value = true
    showToast(
      buildBatchTaskMessage(task),
      task.failed > 0 || task.invalid > 0 ? 'warning' : 'success'
    )
  }
}

const pollBatchTask = async (taskId) => {
  clearBatchTaskPolling()

  try {
    const res = await axios.get(`/api/batchTasks/${taskId}`, {
      headers: getAuthHeaders()
    })

    batchTask.value = res.data

    if (res.data.status === 'completed' || res.data.status === 'failed') {
      await finalizeBatchTask(res.data)
      return
    }

    batchTaskPollTimer.value = setTimeout(() => {
      pollBatchTask(taskId)
    }, 800)
  } catch (error) {
    console.error('pollBatchTask error:', error)

    if (batchTask.value) {
      batchTask.value = {
        ...batchTask.value,
        message: t('msg.progressRetry')
      }
    }

    batchTaskPollTimer.value = setTimeout(() => {
      pollBatchTask(taskId)
    }, 1500)
  }
}

const closeAddModal = () => {
  showAddModal.value = false

  if (!isBatchAdding.value && addMode.value === 'batch' && batchTask.value?.status === 'completed') {
    resetBatchTaskState(batchTask.value.failed === 0 && batchTask.value.invalid === 0)
  }
}

const isSelected = (email) => {
  return selectedTokens.value.includes(email)
}

const toggleSelect = (email) => {
  const index = selectedTokens.value.indexOf(email)
  if (index === -1) {
    selectedTokens.value.push(email)
  } else {
    selectedTokens.value.splice(index, 1)
  }
  selectAll.value = selectedTokens.value.length === displayedTokens.value.length
}

const toggleSelectAll = () => {
  if (selectAll.value) {
    selectedTokens.value = displayedTokens.value.map(token => token.email)
  } else {
    selectedTokens.value = []
  }
}

const deleteSelected = async () => {
  if (selectedTokens.value.length === 0) return

  if (!confirm(t('msg.deleteConfirm', { n: selectedTokens.value.length }))) return

  try {
    const deletePromises = selectedTokens.value.map(email =>
      axios.delete('/api/deleteAccount', {
        data: { email },
        headers: getAuthHeaders()
      })
    )

    await Promise.all(deletePromises)
    await getTokens()
    selectedTokens.value = []
    selectAll.value = false
    showToast(t('msg.deleteSuccess'))
  } catch (error) {
    console.error('deleteSelected error:', error)
    showToast(t('msg.deleteFailed') + error.message, 'error')
  }
}

const deleteAllAccounts = async () => {
  try {
    const res = await axios.get('/api/getAllAccounts', {
      params: { page: 1, pageSize: 10000 },
      headers: getAuthHeaders()
    })
    const allAccounts = res.data.data

    const deletePromises = allAccounts.map(token =>
      axios.delete('/api/deleteAccount', {
        data: { email: token.email },
        headers: getAuthHeaders()
      })
    )

    await Promise.all(deletePromises)
    showDeleteAllConfirm.value = false
    currentPage.value = 1
    await getTokens()
    selectedTokens.value = []
    selectAll.value = false
    showToast(t('msg.allDeleted'))
  } catch (error) {
    console.error('deleteAllAccounts error:', error)
    showToast(t('msg.allDeleteFailed') + error.message, 'error')
  }
}

const changePage = async (page) => {
  if (page >= 1 && page <= totalPages.value) {
    currentPage.value = page
    selectedTokens.value = []
    selectAll.value = false
    await getTokens()
  }
}

const changePageSize = async () => {
  currentPage.value = 1
  selectedTokens.value = []
  selectAll.value = false
  await getTokens()
}

const showToast = (message, type = 'success') => {
  toast.value.message = message
  toast.value.type = type
  toast.value.show = true

  setTimeout(() => {
    toast.value.show = false
  }, 3000)
}

const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text)
    showToast(t('dash.copiedToClipboard'))
  } catch (err) {
    console.error('copyToClipboard error:', err)
    showToast(t('msg.copyFailed'), 'error')
  }
}

const getTokens = async () => {
  isLoading.value = true
  try {
    const res = await axios.get('/api/getAllAccounts', {
      params: {
        page: currentPage.value,
        pageSize: pageSize.value
      },
      headers: getAuthHeaders()
    })

    displayedTokens.value = res.data.data
    totalItems.value = res.data.total

    if (currentPage.value > totalPages.value && totalPages.value > 0) {
      currentPage.value = 1
      await getTokens()
      return
    }

    selectedTokens.value = []
    selectAll.value = false

  } catch (error) {
    console.error('getTokens error:', error)
    showToast(t('msg.fetchFailed') + error.message, 'error')
  } finally {
    isLoading.value = false
  }
}

const addToken = async () => {
  try {
    const payload = {
      email: newAccount.value.email,
      password: newAccount.value.password,
      proxy: newAccount.value.proxy?.trim() || null
    }
    await axios.post('/api/setAccount', payload, {
      headers: getAuthHeaders()
    })
    closeAddModal()
    newAccount.value = { email: '', password: '', proxy: '' }
    await getTokens()
    showToast(t('msg.addSuccess'))
  } catch (error) {
    console.error('addToken error:', error)
    showToast(t('msg.addFailed') + error.message, 'error')
  }
}

const openEditProxy = (token) => {
  editProxy.value = { email: token.email, proxy: token.proxy || '' }
  showEditProxyModal.value = true
}

const closeEditProxyModal = () => {
  if (isSavingProxy.value) return
  showEditProxyModal.value = false
}

const clearProxy = () => {
  editProxy.value.proxy = ''
}

const saveProxy = async () => {
  if (isSavingProxy.value) return
  isSavingProxy.value = true
  try {
    await axios.post('/api/updateAccountProxy', {
      email: editProxy.value.email,
      proxy: editProxy.value.proxy.trim() || null
    }, {
      headers: getAuthHeaders()
    })
    showEditProxyModal.value = false
    await getTokens()
    showToast(t('msg.proxyUpdateSuccess'))
  } catch (error) {
    console.error('saveProxy error:', error)
    showToast(t('msg.proxyUpdateFailed') + error.message, 'error')
  } finally {
    isSavingProxy.value = false
  }
}

const addBatchTokens = async () => {
  if (isBatchAdding.value) return
  if (!batchAccounts.value.trim()) {
    showToast(t('msg.enterAccounts'), 'error')
    return
  }

  batchTaskNotified.value = false
  clearBatchTaskPolling()
  isBatchAdding.value = true

  try {
    const res = await axios.post('/api/setAccounts', {
      accounts: batchAccounts.value,
      async: true
    }, {
      headers: getAuthHeaders()
    })

    batchTask.value = res.data
    addMode.value = 'batch'
    showAddModal.value = true

    if (res.data.status === 'completed' || res.data.status === 'failed') {
      await finalizeBatchTask(res.data)
      return
    }

    pollBatchTask(res.data.taskId)
  } catch (error) {
    console.error('addBatchTokens error:', error)
    showToast(t('msg.batchAddFailed') + error.message, 'error')
    isBatchAdding.value = false
  }
}

const refreshToken = async (email) => {
  if (refreshingTokens.value.includes(email)) return

  refreshingTokens.value.push(email)

  try {
    await axios.post('/api/refreshAccount', { email }, {
      headers: getAuthHeaders()
    })

    await getTokens()
    showToast(t('msg.refreshSuccess', { email }))
  } catch (error) {
    console.error('refreshToken error:', error)
    showToast(t('msg.refreshFailed') + error.message, 'error')
  } finally {
    const index = refreshingTokens.value.indexOf(email)
    if (index > -1) {
      refreshingTokens.value.splice(index, 1)
    }
  }
}

const refreshAllAccounts = async () => {
  if (isRefreshingAll.value) return

  if (!confirm(t('msg.refreshAllConfirm'))) return

  isRefreshingAll.value = true

  try {
    const response = await axios.post('/api/refreshAllAccounts', {
      thresholdHours: 24
    }, {
      headers: getAuthHeaders()
    })

    await getTokens()
    showToast(t('msg.refreshAllComplete', { n: response.data.refreshedCount }))
  } catch (error) {
    console.error('refreshAllAccounts error:', error)
    showToast(t('msg.refreshAllFailed') + error.message, 'error')
  } finally {
    isRefreshingAll.value = false
  }
}

const forceRefreshAllAccounts = async () => {
  if (isForceRefreshingAll.value) return

  if (!confirm(t('msg.forceRefreshAllConfirm'))) return

  isForceRefreshingAll.value = true

  try {
    const response = await axios.post('/api/forceRefreshAllAccounts', {}, {
      headers: getAuthHeaders()
    })

    await getTokens()
    showToast(t('msg.forceRefreshAllComplete', { n: response.data.refreshedCount }))
  } catch (error) {
    console.error('forceRefreshAllAccounts error:', error)
    showToast(t('msg.forceRefreshAllFailed') + error.message, 'error')
  } finally {
    isForceRefreshingAll.value = false
  }
}

const deleteToken = async (email) => {
  if (!confirm(t('msg.deleteAccountConfirm'))) return

  try {
    await axios.delete('/api/deleteAccount', {
      data: { email },
      headers: getAuthHeaders()
    })
    await getTokens()
    showToast(t('msg.deleteAccountSuccess'))
  } catch (error) {
    console.error('deleteToken error:', error)
    showToast(t('msg.deleteAccountFailed') + error.message, 'error')
  }
}

const exportAccounts = async () => {
  try {
    const res = await axios.get('/api/getAllAccounts', {
      params: { page: 1, pageSize: 10000 },
      headers: getAuthHeaders()
    })
    const allAccounts = res.data.data

    if (allAccounts.length === 0) {
      showToast(t('msg.exportEmpty'), 'error')
      return
    }

    const content = allAccounts.map(token => `${token.email}:${token.password}`).join('\n')

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'qwen_accounts.txt'
    document.body.appendChild(link)
    link.click()

    setTimeout(() => {
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    }, 100)

    showToast(t('msg.exportSuccess'))
  } catch (error) {
    console.error('exportAccounts error:', error)
    showToast(t('msg.exportFailed') + error.message, 'error')
  }
}

onMounted(() => {
  getTokens()
  fetchAccountStats()
  statsInterval.value = setInterval(fetchAccountStats, 30000)
  // 1s tick drives countdown rerender and cooldown-expiry watcher.
  tickInterval = setInterval(() => { nowTick.value = Date.now() }, 1000)
})

onBeforeUnmount(() => {
  clearBatchTaskPolling()
  if (statsInterval.value) {
    clearInterval(statsInterval.value)
    statsInterval.value = null
  }
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
  }
})
</script>

<style lang="css" scoped>
@media (max-width: 640px) {
  .container {
    padding: 0;
  }
}

.dashboard-scroll {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.38) rgba(255, 255, 255, 0.08);
}

.modal-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.32) rgba(255, 255, 255, 0.06);
}

.dashboard-scroll::-webkit-scrollbar {
  width: 8px;
}

.modal-scroll::-webkit-scrollbar {
  width: 6px;
}

.dashboard-scroll::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.06);
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

.modal-scroll::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 999px;
}

.dashboard-scroll::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.2));
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.24), 0 2px 10px rgba(15, 23, 42, 0.12);
  background-clip: padding-box;
}

.modal-scroll::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0.18));
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
}

.dashboard-scroll::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.56), rgba(255, 255, 255, 0.28));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28), 0 4px 14px rgba(15, 23, 42, 0.16);
}

.modal-scroll::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.46), rgba(255, 255, 255, 0.24));
}

.dashboard-scroll::-webkit-scrollbar-thumb:active {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0.34));
}

.dashboard-scroll::-webkit-scrollbar-corner {
  background: transparent;
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
.fade-enter-to, .fade-leave-from {
  opacity: 1;
  transform: translateY(0);
}

.token-card {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.3));
  box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.15);
  transform: translateY(0);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.token-card:hover {
  transform: translateY(-5px);
}

.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.scrollbar-hide::-webkit-scrollbar {
  display: none;
}

@keyframes slideIn {
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.token-card {
  animation: slideIn 0.5s ease-out;
  animation-fill-mode: both;
}

.token-card:nth-child(3n+1) { animation-delay: 0.1s; }
.token-card:nth-child(3n+2) { animation-delay: 0.2s; }
.token-card:nth-child(3n+3) { animation-delay: 0.3s; }

.overflow-x-auto {
  position: relative;
  cursor: pointer;
}

.overflow-x-auto::after {
  content: '';
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 24px;
  background: linear-gradient(to right, transparent, rgba(255, 255, 255, 0.8));
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s;
}

.overflow-x-auto:hover::after {
  opacity: 1;
}

/* 隐藏滚动条样式 */
.scrollbar-hidden {
  -ms-overflow-style: none;  /* IE and Edge */
  scrollbar-width: none;  /* Firefox */
}

.scrollbar-hidden::-webkit-scrollbar {
  display: none;  /* Chrome, Safari and Opera */
}

/* 自定义滚动条样式（备用） */
.max-h-\[calc\(100vh-200px\)\]::-webkit-scrollbar {
  width: 6px;
}

.max-h-\[calc\(100vh-200px\)\]::-webkit-scrollbar-track {
  background: rgba(0, 0, 0, 0.05);
  border-radius: 8px;
}

.max-h-\[calc\(100vh-200px\)\]::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 8px;
}

.max-h-\[calc\(100vh-200px\)\]::-webkit-scrollbar-thumb:hover {
  background-color: rgba(0, 0, 0, 0.2);
}

/* 自定义复选框样式 */
.custom-checkbox .checkbox-icon {
  position: relative;
  overflow: hidden;
}

.custom-checkbox .checkbox-icon:before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 100%;
  background: rgba(99, 102, 241, 0.1);
  transition: width 0.3s ease;
}

.custom-checkbox:hover .checkbox-icon:before {
  width: 100%;
}

.custom-checkbox input:checked + .checkbox-icon svg {
  animation: check-animation 0.5s cubic-bezier(0.17, 0.67, 0.83, 0.67);
  transform: scale(1);
}

@keyframes check-animation {
  0% {
    transform: scale(0);
  }
  50% {
    transform: scale(1.2);
  }
  100% {
    transform: scale(1);
  }
}

/* 给选中的卡片添加动画效果 */
.token-card.ring-2 {
  animation: selected-pulse 2s infinite;
}

@keyframes selected-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(99, 102, 241, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0);
  }
}

/* 马卡龙紫色刷新按钮动画 */
@keyframes refresh-pulse-purple {
  0% {
    box-shadow: 0 0 0 0 rgba(168, 85, 247, 0.4);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(168, 85, 247, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(168, 85, 247, 0);
  }
}

/* 马卡龙绿色刷新按钮动画 */
@keyframes refresh-pulse-green {
  0% {
    box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.4);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(74, 222, 128, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(74, 222, 128, 0);
  }
}

/* 马卡龙粉色刷新按钮动画 */
@keyframes refresh-pulse-pink {
  0% {
    box-shadow: 0 0 0 0 rgba(236, 72, 153, 0.4);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(236, 72, 153, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(236, 72, 153, 0);
  }
}

.action-button:hover {
  animation: refresh-pulse-purple 1.5s infinite;
}

/* 刷新中的按钮样式 - 马卡龙紫色 */
.refreshing-button-purple {
  background: linear-gradient(45deg, #c084fc, #a855f7);
  color: white;
  animation: refresh-pulse-purple 1.5s infinite;
  box-shadow: 0 4px 15px rgba(168, 85, 247, 0.3);
}

/* 刷新中的按钮样式 - 马卡龙绿色 */
.refreshing-button-green {
  background: linear-gradient(45deg, #86efac, #4ade80);
  color: white;
  animation: refresh-pulse-green 1.5s infinite;
  box-shadow: 0 4px 15px rgba(74, 222, 128, 0.3);
}

/* 刷新中的按钮样式 - 马卡龙粉色 */
.refreshing-button-pink {
  background: linear-gradient(45deg, #f472b6, #ec4899);
  color: white;
  animation: refresh-pulse-pink 1.5s infinite;
  box-shadow: 0 4px 15px rgba(236, 72, 153, 0.3);
}

/* 马卡龙色系按钮增强效果 */
.action-button {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  backdrop-filter: blur(10px);
}

.action-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}
</style>
