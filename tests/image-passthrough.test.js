const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const anthropic = require('../src/controllers/anthropic.js');
const { extractMediaToFiles } = require('../src/utils/chat-helpers.js');
const { processRequestBody } = require('../src/middlewares/chat-middleware.js');
const { externalizeOversizedAgentContext } = require('../src/utils/request.js');

const { flattenAnthropicMessages, buildInternalRequest } = anthropic;

// https:// URLs make every case network-free: normalizeMediaContentItem returns
// early for them, so no upload/account is needed to exercise the whole transform.
const IMG_URL = 'https://example.invalid/magenta.png';
const VIDEO_URL = 'https://example.invalid/clip.mp4';
const imageBlock = { type: 'image', source: { type: 'url', url: IMG_URL } };
const TOOLS = [{
  name: 'Read',
  description: 'Read a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
}];

const readTurn = (toolResultContent) => ([
  { role: 'user', content: [{ type: 'text', text: 'Read magenta.png and name the colour.' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01abc', name: 'Read', input: { path: 'magenta.png' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01abc', content: toolResultContent }] }
]);

const build = (messages, extra = {}) => buildInternalRequest({
  model: 'qwen3.8-max', max_tokens: 256, messages, tools: TOOLS, ...extra
});
const imageFiles = (body) => (body.messages[0].files || []).filter(f => f.type === 'image');

describe('image passthrough: tool_result blocks', () => {
  it('keeps a tool_result image alive through flattening instead of filtering it away', () => {
    const toolMessage = flattenAnthropicMessages(readTurn([imageBlock])).find(m => m.role === 'tool');
    assert.ok(toolMessage, 'tool_result must still become a role=tool message');
    // resultContent stays exactly as today: text blocks only, so an image-only
    // tool_result still yields an empty string here.
    assert.equal(toolMessage.content, '');
    assert.deepEqual(toolMessage.media, [{ type: 'image_url', image_url: { url: IMG_URL } }]);
  });

  it('keeps the result text in the block and still carries the image (mixed content)', () => {
    const toolMessage = flattenAnthropicMessages(readTurn([
      { type: 'text', text: 'Read 1 image: magenta.png' },
      imageBlock
    ])).find(m => m.role === 'tool');
    assert.equal(toolMessage.content, 'Read 1 image: magenta.png');
    assert.deepEqual(toolMessage.media, [{ type: 'image_url', image_url: { url: IMG_URL } }]);
  });

  it('leaves text-only tool_results untouched — no media key at all', () => {
    const stringTool = flattenAnthropicMessages(readTurn('plain string result')).find(m => m.role === 'tool');
    const blockTool = flattenAnthropicMessages(readTurn([{ type: 'text', text: 'block text result' }])).find(m => m.role === 'tool');
    assert.equal(stringTool.content, 'plain string result');
    assert.equal(blockTool.content, 'block text result');
    // byte-identical shape to before the fix: exactly these three keys, no `media`.
    assert.deepEqual(Object.keys(stringTool), ['role', 'tool_call_id', 'content']);
    assert.deepEqual(Object.keys(blockTool), ['role', 'tool_call_id', 'content']);
  });

  // Real Claude Code always sends base64, never {type:'url'}.
  it('converts a base64 image source into a data URI, defaulting media_type to image/png', () => {
    const withType = flattenAnthropicMessages(readTurn([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }
    ])).find(m => m.role === 'tool');
    assert.deepEqual(withType.media, [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }]);

    const withoutType = flattenAnthropicMessages(readTurn([
      { type: 'image', source: { type: 'base64', data: 'QUJD' } }
    ])).find(m => m.role === 'tool');
    assert.deepEqual(withoutType.media, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }]);
  });

  it('converts a base64 image in a plain user block too', () => {
    const flat = flattenAnthropicMessages([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'QUJD' } }] }
    ]);
    assert.deepEqual(flat[0].content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }]);
  });
});

describe('image passthrough: extractMediaToFiles', () => {
  it('moves an http image out and collapses content back to text', () => {
    const { content, files } = extractMediaToFiles([
      { type: 'text', text: 'hello', chat_type: 't2t' },
      { type: 'image', image: IMG_URL }
    ]);
    assert.equal(content, 'hello');
    assert.deepEqual(files, [{ type: 'image', url: IMG_URL }]);
  });

  it('never returns an empty content array when the content was all image', () => {
    const { content, files } = extractMediaToFiles([{ type: 'image', image: IMG_URL }]);
    // content: [] would ship an empty prompt upstream. '' is the image_edit shape.
    assert.equal(content, '');
    assert.deepEqual(files, [{ type: 'image', url: IMG_URL }]);
  });

  it('leaves a data: URI in content[] — files[] only carries uploaded https URLs', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'image', image: 'data:image/png;base64,QUJD' }
    ];
    const result = extractMediaToFiles(content);
    assert.equal(result.content, content, 'unuploaded data URI must not move to files[]');
    assert.deepEqual(result.files, []);
  });

  it('leaves video in content[] — files[] has no upstream-proven video shape', () => {
    const content = [{ type: 'text', text: 'hello' }, { type: 'video', video: VIDEO_URL }];
    const result = extractMediaToFiles(content);
    assert.equal(result.content, content);
    assert.deepEqual(result.files, []);
  });

  it('moves only the image when an image and a video share the content', () => {
    const { content, files } = extractMediaToFiles([
      { type: 'text', text: 'hello' },
      { type: 'image', image: IMG_URL },
      { type: 'video', video: VIDEO_URL }
    ]);
    assert.deepEqual(files, [{ type: 'image', url: IMG_URL }]);
    assert.deepEqual(content, [{ type: 'text', text: 'hello' }, { type: 'video', video: VIDEO_URL }]);
  });

  it('is a no-op without media', () => {
    const arrayContent = [{ type: 'text', text: 'hello' }];
    const asArray = extractMediaToFiles(arrayContent);
    assert.equal(asArray.content, arrayContent);
    assert.deepEqual(asArray.files, []);

    const asString = extractMediaToFiles('hello');
    assert.equal(asString.content, 'hello');
    assert.deepEqual(asString.files, []);
  });
});

describe('image passthrough: assembled Anthropic upstream body', () => {
  it('puts a tool_result image into files[] and keeps content as text', async () => {
    const { body } = await build(readTurn([imageBlock]));
    assert.deepEqual(imageFiles(body), [{ type: 'image', url: IMG_URL }]);
    assert.equal(typeof body.messages[0].content, 'string', 'content must stay text when media moves to files[]');
    assert.ok(!JSON.stringify(body.messages[0].content).includes(IMG_URL), 'image must not also ride in content[]');
  });

  it('puts a plain user image block into files[] too', async () => {
    const { body } = await build([
      { role: 'user', content: [{ type: 'text', text: 'ctx' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'What colour?' }, imageBlock] }
    ]);
    assert.deepEqual(imageFiles(body), [{ type: 'image', url: IMG_URL }]);
    assert.equal(typeof body.messages[0].content, 'string');
  });

  it('keeps both the result text and the image for a mixed tool_result', async () => {
    const { body } = await build(readTurn([{ type: 'text', text: 'Read 1 image: magenta.png' }, imageBlock]));
    assert.deepEqual(imageFiles(body), [{ type: 'image', url: IMG_URL }]);
    assert.ok(body.messages[0].content.includes('Read 1 image: magenta.png'));
  });

  it('still harvests the image when the turn ends with an assistant prefill', async () => {
    const { body } = await build([
      ...readTurn([imageBlock]),
      { role: 'assistant', content: [{ type: 'text', text: 'The colour is' }] }
    ]);
    assert.deepEqual(imageFiles(body), [{ type: 'image', url: IMG_URL }], 'a trailing prefill must not hide the current turn');
  });

  it('does not re-attach images from earlier turns', async () => {
    const { body } = await build([
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_old', name: 'Read', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: [imageBlock] }] },
      { role: 'assistant', content: [{ type: 'text', text: 'that was magenta' }] },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] }
    ]);
    assert.deepEqual(imageFiles(body), [], 'history images must not be re-attached');
  });

  it('never leaks the internal media key into the upstream body', async () => {
    // media carries full base64 data URIs; foldToolMessages only drops it when tools exist.
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_old', name: 'Read', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: [imageBlock] }] },
      { role: 'assistant', content: [{ type: 'text', text: 'that was magenta' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_new', content: [imageBlock] }] }
    ];
    for (const tools of [TOOLS, undefined]) {
      const { body } = await build(messages, { tools });
      assert.ok(!JSON.stringify(body).includes('"media"'), `media key leaked (tools=${!!tools})`);
    }
  });

  it('builds a media-free tool_result body identical to the documented envelope', async () => {
    const { body } = await build(readTurn([{ type: 'text', text: 'block text result' }]));
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const normalized = JSON.parse(
      JSON.stringify(body, (k, v) => (k === 'timestamp' ? 0 : v)).replace(UUID, '<uuid>')
    );
    const content = normalized.messages[0].content;
    normalized.messages[0].content = '<CONTENT>';

    // Full body-level identity: every key of the pre-fix envelope, nothing added.
    assert.deepEqual(normalized, {
      stream: false, version: '2.1', incremental_output: true,
      chat_id: null, chatId: null, chat_mode: 'normal', model: 'qwen3.8-max',
      parent_id: null, parentId: null,
      messages: [{
        id: null, fid: '<uuid>', parentId: null, parent_id: null,
        childrenIds: ['<uuid>'], role: 'user', content: '<CONTENT>',
        user_action: 'chat', files: [], timestamp: 0,
        models: ['qwen3.8-max'], model: '', chat_type: 't2t',
        feature_config: {
          output_schema: 'phase', thinking_enabled: false, research_mode: 'normal',
          auto_thinking: true, thinking_mode: 'Auto', thinking_format: 'summary', auto_search: true
        },
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t'
      }],
      timestamp: 0, chat_type: 't2t', sub_chat_type: 't2t',
      session_id: '<uuid>', id: '<uuid>', max_tokens: 256
    });
    assert.equal(typeof content, 'string');
    assert.ok(content.includes('block text result'));
  });
});

describe('image passthrough: OpenAI /v1/chat/completions envelope', () => {
  const runMiddleware = async (body) => {
    const req = { body };
    const res = {
      statusCode: 200, headers: {},
      set(h) { Object.assign(this.headers, h); return this; },
      status(c) { this.statusCode = c; return this; },
      json(p) { this.body = p; return this; }
    };
    let err = null;
    await processRequestBody(req, res, (e) => { err = e || null; });
    assert.equal(err, null, err && err.message);
    return req.body;
  };

  it('splits an image_url request into text content plus files[]', async () => {
    const out = await runMiddleware({
      model: 'qwen3.8-max',
      messages: [
        { role: 'user', content: 'ctx' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: 'What colour?' }, { type: 'image_url', image_url: { url: IMG_URL } }] }
      ]
    });
    assert.deepEqual(out.messages[0].files, [{ type: 'image', url: IMG_URL }]);
    assert.equal(typeof out.messages[0].content, 'string');
    assert.ok(!JSON.stringify(out.messages[0].content).includes(IMG_URL));
  });

  it('leaves a media-free request with an empty files[]', async () => {
    const out = await runMiddleware({ model: 'qwen3.8-max', messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(out.messages[0].files, []);
    assert.equal(typeof out.messages[0].content, 'string');
  });

  // Regression pin: image-edit/t2i/t2v are handled by generateImageVideoResult, which
  // reads messages[0].content directly and needs the original array. Collapsing it to a
  // string sends image_edit down the t2i branch and silently drops the input image.
  it('leaves image_edit content as an array so the image controller still sees the image', async () => {
    const out = await runMiddleware({
      model: 'qwen3.8-max-image-edit',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'make it blue' }, { type: 'image_url', image_url: { url: IMG_URL } }]
      }]
    });
    assert.equal(out.chat_type, 'image_edit');
    assert.ok(Array.isArray(out.messages[0].content), 'image_edit content must stay an array');
    assert.ok(
      out.messages[0].content.some(item => item.type === 'image' && item.image === IMG_URL),
      'the input image must still be in content[] for generateImageVideoResult'
    );
    assert.deepEqual(out.messages[0].files, []);
  });

  it('leaves t2i content as an array too', async () => {
    const out = await runMiddleware({
      model: 'qwen3.8-max-image',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a cat' }, { type: 'image_url', image_url: { url: IMG_URL } }] }]
    });
    assert.equal(out.chat_type, 't2i');
    assert.ok(Array.isArray(out.messages[0].content));
  });
});

describe('image passthrough: externalized context keeps the image', () => {
  it('merges the uploaded context file with an image already in files[]', async () => {
    const original = [
      '# Tools', 'strict tool protocol',
      '# Conversation history (JSONL)', JSON.stringify({ role: 'tool', content: 'x'.repeat(12000) }),
      '# Current message', JSON.stringify({ role: 'user', content: 'name the colour' })
    ].join('\n');
    const result = await externalizeOversizedAgentContext(
      {
        messages: [{
          role: 'user',
          content: original,
          files: [{ type: 'image', url: IMG_URL }]
        }],
        model: 'qwen-test'
      },
      'token',
      { email: 'test@example.com' },
      {
        thresholdBytes: 1024,
        livePromptBytes: 4096,
        uploader: async () => ({ id: 'file_context', type: 'file', name: 'QWEN2API_AGENT_CONTEXT.txt' })
      }
    );

    assert.equal(result.externalized, true);
    const files = result.payload.messages[0].files;
    // Both channels must survive: dropping either is exactly the bug this spec fixes.
    assert.equal(files.length, 2, 'the image must not be dropped when context is externalized');
    assert.deepEqual(files[0], { type: 'image', url: IMG_URL });
    assert.equal(files[1].id, 'file_context');
  });
});
