/**
 * SSXMOD Cookie 管理器
 * 负责生成和定时刷新 ssxmod_itna 和 ssxmod_itna2 Cookie
 */

const { generateCookies } = require('./cookie-generator');
const { logger } = require('./logger');

// 全局 Cookie 存储
let currentCookies = {
    ssxmod_itna: '',
    ssxmod_itna2: '',
    timestamp: 0
};

// 刷新间隔 (15分钟)
const REFRESH_INTERVAL = 15 * 60 * 1000;

// 定时器引用
let refreshTimer = null;

/**
 * 刷新 SSXMOD Cookie
 */
function refreshCookies() {
    try {
        const result = generateCookies();
        currentCookies = {
            ssxmod_itna: result.ssxmod_itna,
            ssxmod_itna2: result.ssxmod_itna2,
            timestamp: result.timestamp
        };
        logger.info(`SSXMOD Cookie refreshed`, 'SSXMOD');
    } catch (error) {
        logger.error('SSXMOD Cookie refresh failed', 'SSXMOD', '', error.message);
    }
}

/**
 * 初始化 SSXMOD 管理器
 * 启动时生成一次 Cookie，并设置定时刷新
 */
function initSsxmodManager() {
    // 立即生成一次
    refreshCookies();

    // 设置定时刷新 (每15分钟)
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }
    refreshTimer = setInterval(refreshCookies, REFRESH_INTERVAL);

    logger.info(`SSXMOD manager started, refresh interval: ${REFRESH_INTERVAL / 1000 / 60} minutes`, 'SSXMOD');
}

/**
 * 获取当前 ssxmod_itna
 * @returns {string} ssxmod_itna 值
 */
function getSsxmodItna() {
    return currentCookies.ssxmod_itna;
}

/**
 * 获取当前 ssxmod_itna2
 * @returns {string} ssxmod_itna2 值
 */
function getSsxmodItna2() {
    return currentCookies.ssxmod_itna2;
}

/**
 * 获取完整的 Cookie 对象
 * @returns {Object} 包含 ssxmod_itna 和 ssxmod_itna2 的对象
 */
function getCookies() {
    return { ...currentCookies };
}

/**
 * 停止定时刷新
 */
function stopRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
        logger.info('SSXMOD periodic refresh stopped', 'SSXMOD');
    }
}

module.exports = {
    initSsxmodManager,
    getSsxmodItna,
    getSsxmodItna2,
    getCookies,
    refreshCookies,
    stopRefresh
};
