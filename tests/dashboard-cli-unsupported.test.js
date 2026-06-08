const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const dashboard = fs.readFileSync(require.resolve('../public/src/views/dashboard.vue'), 'utf8');

test('dashboard renders unsupported CLI state as hover-only gray hint', () => {
  assert.match(dashboard, /v-if="getStatusKind\(token\.email\) === 'cli_unsupported'"/);
  assert.match(dashboard, /\:title="getStatusTooltip\(token\.email\)"/);
  assert.match(dashboard, /cliUnavailableShort/);
  assert.match(dashboard, /text-gray-400/);
  assert.match(dashboard, /v-if="cliExpanded && getStatusKind\(token\.email\) !== 'cli_unsupported' && getStatusKind\(token\.email\) !== 'cli_pending'"/);
});

test('dashboard renders pending CLI state as blue hint', () => {
  assert.match(dashboard, /v-else-if="getStatusKind\(token\.email\) === 'cli_pending'"/);
  assert.match(dashboard, /cliPendingShort/);
  assert.match(dashboard, /text-blue-400/);
});
