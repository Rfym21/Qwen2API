'use strict'

/**
 * La puerta del turno agéntico: qué intento del upstream se acepta y cuál se reintenta.
 *
 * Por ahora este módulo sólo tiene el presupuesto de intentos — el primer trozo de la
 * decisión que estaba escrito tres veces con tres significados distintos. La puerta en sí
 * (entra un snapshot de un intento, sale un veredicto) llega en el ticket siguiente y vive
 * acá, junto a los dos presupuestos y al vocabulario de razones.
 *
 * Es una hoja: no importa configuración, red ni logger.
 */

/** Piso del presupuesto: 1 = una sola generación, sin reintentos. */
const MIN_ATTEMPT_BUDGET = 1

/** Techo del presupuesto: el mismo tope que ya aplicaba el runtime OpenAI. */
const MAX_ATTEMPT_BUDGET = 6

/**
 * Un solo significado de "max attempts": total de generaciones del upstream para una
 * petición de cliente, **contando la primera**. El runtime OpenAI aplicaba un piso de 2 y
 * convertía en 2 el 1 que le pidieran, mientras las superficies Anthropic aplicaban piso 1:
 * la misma cifra significaba dos cosas según quién la leyera.
 *
 * Alcance exacto de lo que esto arregla, para que nadie lo lea de más: el piso de 1 es
 * alcanzable **sólo por el valor por petición**. La configuración sigue clampeada a [2, 6]
 * en config/index.js — a propósito, y por eso `AGENT_TURN_MAX_ATTEMPTS=1` sigue dando 2.
 * Hoy el único llamador que trae un valor por petición son los tests; cuando exista uno de
 * producción, el piso de acá ya lo cubre.
 * @param {number|string|null} [requested] - valor por petición; null, ausente, no finito o
 *   ≤ 0 cuentan como "no hay" y cae al de configuración. Ojo: un negativo antes se aplanaba
 *   a 2 y un `Infinity` a 6 — entradas que ningún llamador real produce, pero que cambian
 *   de resultado, así que van declaradas y no escondidas.
 * @param {number|string} [fallback] - valor de configuración para cuando no lo trae
 * @returns {number} intentos totales, entre MIN_ATTEMPT_BUDGET y MAX_ATTEMPT_BUDGET
 */
const resolveAttemptBudget = (requested, fallback) => {
  const wanted = Number(requested)
  const base = Number.isFinite(wanted) && wanted > 0 ? wanted : Number(fallback)
  if (!Number.isFinite(base) || base <= 0) return MIN_ATTEMPT_BUDGET
  return Math.min(MAX_ATTEMPT_BUDGET, Math.max(MIN_ATTEMPT_BUDGET, base))
}

module.exports = {
  resolveAttemptBudget,
  MIN_ATTEMPT_BUDGET,
  MAX_ATTEMPT_BUDGET
}
