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
 * Clave de sesion. null sin user id: dos sesiones con el mismo arranque (mismo system,
 * mismas tools, mismo primer mensaje) compartirian clave y una veria el historial de la
 * otra. Claude Code manda su session id dentro de metadata.user_id.
 */
const buildContextPrefixKey = ({ userId, model, system, tools, firstMessage }) => {
    if (!userId) return null
    return hashText(JSON.stringify([
        String(userId),
        String(model || ''),
        hashText(JSON.stringify(system ?? '')),
        hashText(JSON.stringify(tools ?? [])),
        hashText(JSON.stringify(firstMessage ?? ''))
    ]))
}

/**
 * entry = { accountEmail, file, prefixHash, prefixChars, prefixBytes, prefixLines,
 *           createdAt, lastUsedAt }
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

/** true cuando `history` empieza por el prefijo cacheado y el corte cae en un salto de linea. */
const prefixMatches = (history, entry) => {
    const text = String(history || '')
    const chars = Number(entry?.prefixChars) || 0
    if (chars <= 0 || text.length < chars) return false
    if (text.length !== chars && text[chars] !== '\n') return false
    return hashText(text.slice(0, chars)) === entry.prefixHash
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
    prefixMatches
}
