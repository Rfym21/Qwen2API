const test = require('node:test');
const assert = require('node:assert/strict');

const compatibility = require('../src/controllers/anthropic.compatibility.js');

test('analyzeAnthropicCompatibility classifies supported partial ignored and future-risk fields', () => {
  assert.equal(typeof compatibility.analyzeAnthropicCompatibility, 'function');

  const result = compatibility.analyzeAnthropicCompatibility({
    model: 'qwen3-coder-plus',
    messages: [{ role: 'user', content: 'hello' }],
    system: 'You are helpful',
    tools: [{ name: 'foo', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'any' },
    thinking: { type: 'enabled', budget_tokens: 1024 },
    stream: true,
    max_tokens: 256,
    metadata: { source: 'test' },
    output_config: { effort: 'high' },
    context_management: { edits: [] }
  });

  assert.deepEqual(result.supportedFields, ['model', 'messages', 'stream']);
  assert.deepEqual(result.partialFields, ['system', 'tools', 'tool_choice', 'thinking']);
  assert.deepEqual(result.ignoredFields, ['max_tokens', 'metadata', 'output_config']);
  assert.deepEqual(result.futureRiskFields, ['context_management']);
  assert.match(result.summary, /partial/i);
  assert.match(result.summary, /ignored/i);
});

test('buildAnthropicCompatibilityHeaders returns compact warning headers only when needed', () => {
  assert.equal(typeof compatibility.buildAnthropicCompatibilityHeaders, 'function');

  const headers = compatibility.buildAnthropicCompatibilityHeaders({
    partialFields: ['system', 'thinking'],
    ignoredFields: ['max_tokens', 'metadata'],
    futureRiskFields: ['context_management']
  });

  assert.deepEqual(headers, {
    'X-Qwen2API-Anthropic-Compatibility': 'partial=system,thinking;future_risk=context_management',
    'X-Qwen2API-Anthropic-Warnings': 'ignored=max_tokens,metadata'
  });
});

test('buildAnthropicCompatibilityHeaders omits headers when there are no warnings', () => {
  const headers = compatibility.buildAnthropicCompatibilityHeaders({
    partialFields: [],
    ignoredFields: [],
    futureRiskFields: []
  });

  assert.deepEqual(headers, {});
});
