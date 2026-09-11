// Cache en memoria del prefijo de historial ya subido a Qwen (plan A, 2026-09-10).
//
// Cada turno de /v1/messages vuelve a serializar TODA la conversacion; por encima del
// umbral, request.js#externalizeOversizedAgentContext la sube como documento y Qwen la
// parsea (POST /api/v2/files/parse). El WAF de Aliyun cuenta esos POST por IP y con la
// cadencia de Claude Code (~4 turnos/min) empieza a desafiar. La unidad de reutilizacion
// es el bloque `# Conversation history (JSONL)` renderizado: si el historial de este turno
// EMPIEZA por el texto que ya se subio (mismo hash, corte en salto de linea), se manda el
// mismo descriptor de archivo y solo la cola nueva va inline. Un parse cada 3-10 turnos en
// vez de uno por turno.
//
// Medido en vivo (tools/dev-probes/probe-prefix-file-reuse.js): un file_id parseado se
// reutiliza en chats NUEVOS y desde OTRAS cuentas; un file_id caducado o inexistente NO
// devuelve error — el modelo contesta sin el adjunto. Por eso la vida de una entrada es
// absoluta (desde su creacion, no desde el ultimo uso) y corta.
//
// Sin timers: el gate de tests (tools/test-gate.js) nota los intervalos que dejan vivo el
// proceso. La expiracion se evalua al leer.
const { createHash } = require('node:crypto')
const config = require('../config/index.js')

const hashText = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')

/**
 * Clave de sesion. Claude Code manda su session id dentro de metadata.user_id; sin user id
 * la clave sale solo del arranque (modelo, system, tools, primer mensaje). Dos sesiones asi
 * comparten clave, pero NO se ven el historial: prefixMatches verifica el hash de las
 * lineas enteras, asi que un historial ajeno nunca encaja; como mucho se pisan la entrada
 * y re-hornean, que es lo que pasaba siempre sin clave.
 */
const buildContextPrefixKey = ({ userId, model, system, tools, firstMessage }) => {
    return hashText(JSON.stringify([
        userId ? String(userId) : '',
        String(model || ''),
        hashText(JSON.stringify(system ?? '')),
        hashText(JSON.stringify(tools ?? [])),
        hashText(JSON.stringify(firstMessage ?? ''))
    ]))
}

/**
 * entry = { accountEmail, file, prefixHash, prefixBytes, prefixLines, createdAt, lastUsedAt }
 * prefixHash es el hash de la forma CANONICA de las prefixLines primeras lineas (ver
 * prefixMatches); el archivo subido lleva las lineas tal como estaban al hornear.
 * `now` inyectable para que los tests avancen el reloj sin dormir.
 */
const createContextPrefixCache = ({ ttlMs, maxEntries, now = Date.now } = {}) => {
    const map = new Map()
    const ttl = Math.max(0, Number(ttlMs) || 0)
    const cap = Math.max(1, Number(maxEntries) || 1)
    return {
        get(key) {
            const entry = map.get(key)
            if (!entry) return null
            if (ttl > 0 && now() - entry.createdAt > ttl) {
                map.delete(key)
                return null
            }
            entry.lastUsedAt = now()
            // Toque LRU: Map itera en orden de insercion; el mas viejo sale primero en set().
            map.delete(key)
            map.set(key, entry)
            return entry
        },
        set(key, entry) {
            map.delete(key)
            map.set(key, { ...entry, createdAt: now(), lastUsedAt: now() })
            while (map.size > cap) map.delete(map.keys().next().value)
        },
        delete(key) { return map.delete(key) },
        clear() { map.clear() },
        get size() { return map.size }
    }
}

const identity = (line) => line

/** Hash del prefijo: las lineas en su forma canonica, unidas por salto de linea. */
const canonicalHistoryHash = (lines, canonicalizeLine = identity) => (
    hashText(lines.map(canonicalizeLine).join('\n'))
)

/**
 * true cuando las `prefixLines` primeras lineas de `history` (bloque JSONL) tienen el mismo
 * hash canonico que la entrada. Se compara por lineas y en forma canonica
 * (`canonicalizeLine`, identidad por defecto) para que un adorno que el emisor añade o
 * quita a una linea vieja — el razonamiento retenido de controllers/anthropic.js, que sale
 * del presupuesto conforme crece el historial — no invalide el prefijo ya subido.
 */
const prefixMatches = (history, entry, canonicalizeLine = identity) => {
    const count = Number(entry?.prefixLines) || 0
    if (count <= 0 || !entry?.prefixHash) return false
    const lines = String(history || '').split('\n')
    if (lines.length < count) return false
    return canonicalHistoryHash(lines.slice(0, count), canonicalizeLine) === entry.prefixHash
}

const contextPrefixCache = createContextPrefixCache({
    ttlMs: (Number(config.agentContextPrefixTtlSeconds) || 0) * 1000,
    maxEntries: config.agentContextPrefixMaxEntries
})

module.exports = {
    hashText,
    buildContextPrefixKey,
    createContextPrefixCache,
    contextPrefixCache,
    canonicalHistoryHash,
    prefixMatches
}
