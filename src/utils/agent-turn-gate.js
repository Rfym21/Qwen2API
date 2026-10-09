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
 * petición de cliente, **contando la primera**. Un llamador que pide 1 recibe un intento —
 * el runtime OpenAI aplicaba un piso de 2 y convertía ese 1 en 2 en silencio, mientras las
 * superficies Anthropic aplicaban piso 1: la misma configuración significaba dos cosas.
 * @param {number|string} [requested] - valor por petición, si el llamador trae uno
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
