// Go/no-go for prefix-file reuse (plan A): is a parsed Qwen file_id reusable in NEW chats?
// Run inside the qwen-next container:
//   ssh root@VPS 'docker exec -i -w /app lohari-qwen2api-next node -' < tools/dev-probes/probe-prefix-file-reuse.js
// Cost: 1 upload+parse, 3-4 new chats. Prints the failure shape for a bogus file_id too.
const accountManager = require('./src/utils/account.js')
const { buildInternalRequest } = require('./src/controllers/anthropic.js')
const { sendChatRequest } = require('./src/utils/request.js')
const { consumeSSEStream } = require('./src/utils/sse.js')
const { uploadAgentContextFile } = require('./src/utils/upload.js')

const MODEL = process.env.PROBE_MODEL || 'qwen3.8-max-thinking'
const MARKER = 'ZEBRA-7741'
const mask = (e) => e ? `${String(e).slice(0, 3)}…@${String(e).split('@')[1] || '?'}` : 'null'

const historyText = () => {
  const lines = ['# Conversation history (JSONL)']
  for (let i = 1; i <= 30; i++) {
    const role = i % 2 ? 'user' : 'assistant'
    const content = i === 12
      ? `Apunta esto: mi palabra secreta es ${MARKER}. Guárdala.`
      : `Mensaje de relleno número ${i} sobre el proyecto de facturación.`
    lines.push(JSON.stringify({ role, content }))
  }
  return lines.join('\n') + '\n'
}

const ask = async (label, file, account) => {
  const { body } = await buildInternalRequest({
    model: MODEL, max_tokens: 200, stream: true,
    messages: [{ role: 'user', content: 'El documento adjunto es mi historial de conversación. ¿Cuál es mi palabra secreta según ese documento? Responde SOLO con la palabra.' }]
  })
  body.messages[0].files = [file]
  const sent = await sendChatRequest(body, { currentAccount: account })
  if (!sent.status) { console.log(`${label} SENDFAIL ${sent.message}`); return null }
  let text = '', n = 0, errs = [], first = ''
  await consumeSSEStream(sent.response, (frame) => {
    n += 1
    const d = frame.data
    if (n === 1) first = d.slice(0, 220)
    let j; try { j = JSON.parse(d) } catch { return }
    if (j.error) errs.push(JSON.stringify(j.error).slice(0, 200))
    if (j.success === false) errs.push(JSON.stringify(j.data || j).slice(0, 200))
    const delta = j?.choices?.[0]?.delta
    if (delta?.phase === 'answer' && delta.content) text += delta.content
  })
  console.log(`${label} acct=${mask(sent.currentAccount?.email)} chat=${sent.chatId} frames=${n} errs=${errs.length ? errs.join('|') : '-'} recall=${/ZEBRA|7741/i.test(text) ? 'YES' : 'NO'} text=${JSON.stringify(text.slice(0, 120))}${n <= 2 ? ` first=${JSON.stringify(first)}` : ''}`)
  return { text, errs, frames: n }
}

;(async () => {
  try { await accountManager.loadAccountTokens() } catch (e) {}
  const account = accountManager.getAccount()
  if (!account) { console.log('NO ACCOUNT'); process.exit(2) }
  console.log(`upload acct=${mask(account.email)}`)
  const t0 = Date.now()
  const file = await uploadAgentContextFile(historyText(), account.token, account, { filename: `QWEN2API_AGENT_CONTEXT_PROBE_${Date.now()}.txt` })
  console.log(`uploaded in ${Date.now() - t0}ms descriptorKeys=${Object.keys(file).join(',')} id=${file.id || file.file_id} status=${file.status} parse=${JSON.stringify(file.parse_meta || null)}`)

  await ask('R1(same-acct,new-chat)', file, account)
  await ask('R2(same-acct,new-chat)', file, account)

  const realId = String(file.id || file.file_id)
  const bogus = JSON.parse(JSON.stringify(file).split(realId).join('00000000-0000-4000-8000-000000000000'))
  await ask('R3(bogus-file_id)', bogus, account)

  let other = null
  for (let i = 0; i < 6 && !other; i++) {
    const a = accountManager.getAccount()
    if (a && a.email !== account.email) other = a
  }
  if (other) await ask('R4(other-acct,same-file)', file, other)
  else console.log('R4 skipped: no second account available')

  try { accountManager.destroy() } catch {}
  process.exit(0)
})().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1) })
