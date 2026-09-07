const test = require('node:test')
const assert = require('node:assert/strict')

const { describeToolErrors, buildToolErrorRetryHint } = require('../src/controllers/anthropic.js')

// Los tipos que produce createNativeToolCallAccumulator en modo snapshot. Antes de D1 el
// resumen los ignoraba y el log decia "unspecified" para una ronda entera de errores nativos.
test('describeToolErrors cuenta los tipos del acumulador nativo, no los colapsa en unspecified', () => {
  const summary = describeToolErrors([
    { type: 'unknown_tool', name: 'code_interpreter' },
    { type: 'invalid_arguments', name: 'Bash' },
    { type: 'invalid_arguments', name: 'Read' },
    { type: 'missing_tool_name', index: 0 },
    { type: 'truncated_native_call', name: 'Write' },
    { type: 'schema_mismatch', name: 'Edit', missing: ['file_path'] }
  ])
  assert.match(summary, /unknown_tool: code_interpreter/)
  assert.match(summary, /invalid_arguments ×2/)
  assert.match(summary, /missing_tool_name ×1/)
  assert.match(summary, /truncated_native_call ×1/)
  assert.match(summary, /schema_mismatch ×1/)
  assert.doesNotMatch(summary, /unspecified/)
  // Sin errores conocidos sigue diciendo unspecified (contrato previo).
  assert.equal(describeToolErrors([]), 'unspecified')
})

test('buildToolErrorRetryHint: rama de argumentos invalidos nombra la herramienta; la de unknown_tool no cambia', () => {
  const allowed = ['Bash', 'Read']

  // Contrato previo intacto: unknown_tool → nombres reales.
  const unknownOnly = buildToolErrorRetryHint([{ type: 'unknown_tool', name: 'Shell' }], allowed)
  assert.match(unknownOnly, /The tool name\(s\) Shell do not exist\./)
  assert.match(unknownOnly, /Use ONLY these exact tool names: Bash, Read\./)
  assert.doesNotMatch(unknownOnly, /were not a valid JSON object/)

  // Nueva rama: invalid_arguments / schema_mismatch → "tus argumentos para <tool>".
  const badArgs = buildToolErrorRetryHint([
    { type: 'invalid_arguments', name: 'Bash' },
    { type: 'schema_mismatch', name: 'Read', missing: ['file_path'] }
  ], allowed)
  assert.match(badArgs, /Your arguments for tool Bash, Read were not a valid JSON object or missed required keys/)
  assert.doesNotMatch(badArgs, /do not exist/)

  // Sin errores relevantes: solo la base.
  const base = buildToolErrorRetryHint([{ type: 'truncated_native_call', name: 'Bash' }], allowed)
  assert.match(base, /invalid, truncated, or unknown tool call/)
  assert.doesNotMatch(base, /do not exist|were not a valid JSON object/)
})
