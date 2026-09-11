const DEFAULT_CLI_QUOTA_LIMIT = 2000

/**
 * CLI 对该账户是否可用——与账户健康无关的独立维度
 * @param {Object} account - 账户对象
 * @returns {'disabled'|'unsupported'|'pending'|'available'}
 */
function getCliAvailability(account) {
  const reason = account.cli_unavailable_reason || null
  if (reason === 'unsupported') return 'unsupported'
  if (reason === 'disabled') return 'disabled'
  if (!account.cli_info) return 'pending'
  return 'available'
}

/**
 * 账户状态拆成两个互不遮挡的维度：
 * - status.kind —— 账户健康（面板角标）：cooldown > warn > token_expiring > active
 * - status.cli  —— CLI 可用性（卡片里的 CLI 行）：disabled / unsupported / pending / available
 *
 * 合成一个字段会互相遮挡：ENABLE_CLI=false 时每个账户都是 cli_disabled，
 * 冷却中或令牌将过期的账户与正常账户看起来完全一样。
 *
 * @param {Object} account - 账户对象
 * @param {Object} rotatorRecord - 轮询器里该账户的记录
 * @param {number} now - 当前时间戳
 */
function getAccountCliState(account, rotatorRecord = {}, now = Date.now()) {
  const WARN_WINDOW_MS = 15 * 60 * 1000
  const TOKEN_EXPIRING_MS = 6 * 60 * 60 * 1000

  // Un solo campo para el frontend, pero dos fuentes: el contador de fallos y el destierro
  // por cuota agotada (account-rotator#recordQuotaExhausted). Gana el que libere mas tarde
  // —es el que de verdad manda cuando la cuenta vuelve al sorteo—. Sin fundirlos, una
  // cuenta desterrada por cuota se pintaba `active` mientras la rotacion la ignoraba.
  const cooldownEndsAt = Math.max(
    Number(rotatorRecord.cooldownEndsAt) || 0,
    Number(rotatorRecord.quotaCooldownEndsAt) || 0
  ) || null
  const lastErrorAt = rotatorRecord.lastErrorAt || null
  const lastErrorCode = rotatorRecord.lastErrorCode || null
  const cliUnavailableReason = account.cli_unavailable_reason || null
  const cli = getCliAvailability(account)

  let kind = 'active'
  if (cooldownEndsAt && now < cooldownEndsAt) {
    kind = 'cooldown'
  } else if (lastErrorAt && (now - lastErrorAt) < WARN_WINDOW_MS) {
    kind = 'warn'
  } else if (account.expires && (account.expires * 1000 - now) < TOKEN_EXPIRING_MS) {
    kind = 'token_expiring'
  }

  return {
    stats: account.stats || { chat: { input: 0, output: 0 }, cli: { calls: 0, input: 0, output: 0 } },
    cliRequestNumber: account.cli_info?.request_number || 0,
    cliQuotaLimit: cli === 'available' ? DEFAULT_CLI_QUOTA_LIMIT : 0,
    status: {
      kind,
      cli,
      cooldownEndsAt,
      lastErrorAt,
      lastErrorCode,
      cliUnavailableReason
    }
  }
}

module.exports = {
  DEFAULT_CLI_QUOTA_LIMIT,
  getCliAvailability,
  getAccountCliState
}
