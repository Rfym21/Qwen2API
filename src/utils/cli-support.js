const DEFAULT_CLI_QUOTA_LIMIT = 2000

function getAccountCliState(account, rotatorRecord = {}, now = Date.now()) {
  const WARN_WINDOW_MS = 15 * 60 * 1000
  const TOKEN_EXPIRING_MS = 6 * 60 * 60 * 1000

  const cooldownEndsAt = rotatorRecord.cooldownEndsAt || null
  const lastErrorAt = rotatorRecord.lastErrorAt || null
  const lastErrorCode = rotatorRecord.lastErrorCode || null
  const cliUnavailableReason = account.cli_unavailable_reason || null

  let kind = 'active'
  if (cliUnavailableReason === 'unsupported') {
    kind = 'cli_unsupported'
  } else if (!account.cli_info && !cliUnavailableReason) {
    kind = 'cli_pending'
  } else if (cooldownEndsAt && now < cooldownEndsAt) {
    kind = 'cooldown'
  } else if (lastErrorAt && (now - lastErrorAt) < WARN_WINDOW_MS) {
    kind = 'warn'
  } else if (account.expires && (account.expires * 1000 - now) < TOKEN_EXPIRING_MS) {
    kind = 'token_expiring'
  }

  return {
    stats: account.stats || { chat: { input: 0, output: 0 }, cli: { calls: 0, input: 0, output: 0 } },
    cliRequestNumber: account.cli_info?.request_number || 0,
    cliQuotaLimit: kind === 'cli_unsupported' ? 0 : DEFAULT_CLI_QUOTA_LIMIT,
    status: {
      kind,
      cooldownEndsAt,
      lastErrorAt,
      lastErrorCode,
      cliUnavailableReason
    }
  }
}

module.exports = {
  DEFAULT_CLI_QUOTA_LIMIT,
  getAccountCliState
}
