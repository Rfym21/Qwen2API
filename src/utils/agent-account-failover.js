const { isRateLimitError, isWafChallengeError, noteRateLimitedAccount } = require('./upstream-error')

function recordFailedAccount(error, account) {
  // Errors are logged; never attach the account object containing its token/password.
  error.failedAccountEmail = account?.email || null
  if (isRateLimitError(error)) {
    error.accountFailureRecorded = noteRateLimitedAccount(error, account)
  } else if (isWafChallengeError(error) && account?.email) {
    require('./account').recordAccountChallenge(account.email)
    error.accountFailureRecorded = true
  }
}

function createAccountReplayBody(requestBody) {
  if (!requestBody || !Array.isArray(requestBody.messages) || requestBody.messages.length === 0) return null
  const hasAttachments = message =>
    (Array.isArray(message?.files) && message.files.length > 0) ||
    (Array.isArray(message?.media) && message.media.length > 0) ||
    (Array.isArray(message?.content) && message.content.some(part => part?.type !== 'text'))
  // Use the original full text, never a shortened prompt whose attachment was
  // created on another account. User-uploaded media cannot safely be recreated here.
  if (hasAttachments(requestBody) || requestBody.messages.some(hasAttachments)) return null

  const replayBody = JSON.parse(JSON.stringify(requestBody))
  for (const message of [replayBody, ...replayBody.messages]) {
    for (const key of ['chatId', 'chat_id', 'parentId', 'parent_id', 'responseId', 'response_id']) {
      delete message[key]
    }
  }
  return replayBody
}

module.exports = { recordFailedAccount, createAccountReplayBody }
