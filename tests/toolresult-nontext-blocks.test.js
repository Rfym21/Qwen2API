const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { flattenAnthropicMessages } = require('../src/controllers/anthropic.js');
const { foldToolMessages } = require('../src/utils/tool-prompt.js');
const { buildToolHistoryLedger } = require('../src/utils/agent-turn.js');
const { logger } = require('../src/utils/logger');

// Measured over the 1,564 real Claude Code session files in ~/.claude/projects that ran
// through this proxy: 61,108 tool_result blocks, whose inner block types were
// {text: 1461, tool_reference: 462, image: 37}. Of the results whose content array carried
// NO text block, 37 were image-only (the shape the media note fixed) and 326 were
// `tool_reference`-only — 8.8x more frequent, and still folding to `(empty)`.
//
// `(empty)` under a ledger caption that tells the model its results are already above is
// the strongest possible push toward re-issuing the call, and duplicate calls are the
// defect this whole branch exists to fix. The tool_result branch used to whitelist two
// block types and silently drop the rest; it is now symmetric with the top-level `image`
// branch a few lines below it, which already announced what it could not forward.
const searchTurn = (resultContent) => ([
  { role: 'user', content: [{ type: 'text', text: 'search for qwen' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call_097caa3518ab4d85923cfed2', name: 'WebSearch', input: { query: 'qwen' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_097caa3518ab4d85923cfed2', content: resultContent }] }
]);
const toolMsg = (messages) => flattenAnthropicMessages(messages).find(m => m.role === 'tool');
const foldedResult = (messages) => {
  const flat = flattenAnthropicMessages(messages);
  return foldToolMessages(flat).find(m => typeof m.content === 'string' && m.content.startsWith('[TOOL RESULT')).content;
};

describe('tool_result blocks that are neither text nor image', () => {
  // The verbatim shape found in the user's own sessions, kept literal on purpose: it is
  // the cheapest regression guard there is.
  const CORPUS_SHAPE = [{ type: 'tool_reference', tool_name: 'WebSearch' }];

  it('does not tell the model a tool_reference result returned nothing', () => {
    const content = toolMsg(searchTurn(CORPUS_SHAPE)).content;
    assert.notEqual(content, '');
    assert.match(content, /tool_reference/);
    assert.equal(foldedResult(searchTurn(CORPUS_SHAPE)),
      '[TOOL RESULT #1: WebSearch]\n[unsupported content block: tool_reference — not forwarded]\n[END TOOL RESULT]');
  });

  it('and the ledger digest does not say (empty) for it either', () => {
    const ledger = buildToolHistoryLedger(flattenAnthropicMessages(searchTurn(CORPUS_SHAPE)));
    assert.match(ledger, /#1 WebSearch \{"query":"qwen"\} -> /);
    assert.doesNotMatch(ledger, /-> \(empty\)/);
  });

  // The general rule, so the NEXT unhandled block type fails a test instead of shipping.
  it('no non-empty tool_result content array folds to (empty)', () => {
    const blocks = [
      { type: 'tool_reference', tool_name: 'WebSearch' },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } },
      { type: 'search_result', title: 'x' },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
      { type: 'web_search_tool_result', content: [] },
      { type: 'image', source: { type: 'file', file_id: 'file_123' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
      { thisHasNoType: true }
    ];
    for (const block of blocks) {
      const folded = foldedResult(searchTurn([block]));
      assert.doesNotMatch(folded, /\(empty\)/, `${JSON.stringify(block)} folded to (empty):\n${folded}`);
    }
  });

  it('an image the media bypass cannot convert is announced, not dropped in silence', () => {
    // Symmetric with the top-level image branch, which was hardened against exactly this
    // (source:{type:'file'} is a documented Anthropic shape we do not support). Inside a
    // tool_result the same failure fell through `.filter(Boolean)` and vanished.
    const message = toolMsg(searchTurn([{ type: 'image', source: { type: 'file', file_id: 'file_123' } }]));
    assert.equal(message.content, '[unsupported content block: image — not forwarded]');
    assert.equal(message.media, undefined, 'nothing convertible, so no media bypass');
  });

  it('logs the dropped types once per call instead of losing them silently', () => {
    const warned = [];
    const real = logger.warn;
    logger.warn = (message, ...rest) => { warned.push(String(message)); return real.call(logger, message, ...rest); };
    try {
      flattenAnthropicMessages(searchTurn([
        { type: 'tool_reference', tool_name: 'WebSearch' },
        { type: 'image', source: { type: 'file', file_id: 'file_1' } }
      ]));
    } finally {
      logger.warn = real;
    }
    const line = warned.find(w => w.includes('not forwarded'));
    assert.ok(line, `no dropped-block warning was emitted; saw ${JSON.stringify(warned)}`);
    assert.match(line, /tool_reference/);
    assert.match(line, /image\(file\)/);
  });

  it('keeps a text+unsupported mix readable, in order', () => {
    const message = toolMsg(searchTurn([
      { type: 'text', text: 'first line' },
      { type: 'tool_reference', tool_name: 'WebSearch' },
      { type: 'text', text: 'last line' }
    ]));
    assert.equal(message.content,
      'first line\n[unsupported content block: tool_reference — not forwarded]\nlast line');
  });

  it('leaves text-only and string results byte-identical', () => {
    assert.equal(toolMsg(searchTurn('plain string')).content, 'plain string');
    assert.equal(toolMsg(searchTurn([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).content, 'a\nb');
    // The old code used `b.text || ''`, not a typeof check. A non-string `text` rendered
    // through that coercion and must keep doing so — this is a byte-identity pin, not an
    // endorsement of the shape.
    assert.equal(toolMsg(searchTurn([{ type: 'text', text: 7 }])).content, '7');
    // A genuinely empty array is genuinely empty: (empty) is the truth there.
    assert.equal(toolMsg(searchTurn([])).content, '');
  });
});
