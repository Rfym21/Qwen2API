// Compact number formatting: 415575 → '415k', 1500 → '1.5k', 1500000 → '1.5M'.
// <1000 — no suffix. Utility stays vue-i18n-agnostic: units are passed in
// explicitly so this remains pure and testable. Callers supply
// t('dash.acct.unitK') / t('dash.acct.unitM').
export function formatCompact(n, units = {}) {
  const { unitK = 'k', unitM = 'M' } = units
  const num = Number(n) || 0
  if (num < 1000) return String(num)
  if (num < 1_000_000) {
    const k = num / 1000
    const formatted = k >= 100 ? Math.round(k) : (Math.round(k * 10) / 10)
    return `${formatted}${unitK}`
  }
  const m = num / 1_000_000
  return `${Math.round(m * 10) / 10}${unitM}`
}
