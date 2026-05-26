const test = require('node:test');
const assert = require('node:assert/strict');

const cliManager = require('../src/utils/cli.manager.js');
const cliSupport = require('../src/utils/cli-support.js');

test('pollForToken stops after 3 unsuccessful attempts', async () => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;

  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 504,
      statusText: 'Gateway Time-out',
      headers: new Map([['content-type', 'text/html']]),
      text: async () => '<html>504 Gateway Time-out</html>'
    };
  };
  global.setTimeout = (fn) => {
    fn();
    return 0;
  };

  try {
    const result = await cliManager.pollForToken('device-code', 'code-verifier');
    assert.equal(attempts, 3);
    assert.deepEqual(result, {
      status: false,
      access_token: null,
      refresh_token: null,
      expiry_date: null
    });
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
});

test('getAccountCliState marks unsupported CLI accounts with zero quota', () => {
  const state = cliSupport.getAccountCliState({
    cli_info: null,
    cli_unavailable_reason: 'unsupported',
    expires: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    stats: { chat: { input: 0, output: 0 }, cli: { calls: 0, input: 0, output: 0 } }
  }, {}, Date.now());

  assert.equal(state.status.kind, 'cli_unsupported');
  assert.equal(state.cliQuotaLimit, 0);
  assert.equal(state.cliRequestNumber, 0);
});

test('getAccountCliState keeps normal accounts on default CLI quota', () => {
  const state = cliSupport.getAccountCliState({
    cli_info: { request_number: 12 },
    expires: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    stats: { chat: { input: 0, output: 0 }, cli: { calls: 2, input: 10, output: 20 } }
  }, {}, Date.now());

  assert.equal(state.status.kind, 'active');
  assert.equal(state.cliQuotaLimit, 2000);
  assert.equal(state.cliRequestNumber, 12);
});
