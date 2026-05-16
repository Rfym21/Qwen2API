const { isJson, generateUUID } = require('../utils/tools.js');
const { createUsageObject } = require('../utils/precise-tokenizer.js');
const { sendChatRequest } = require('../utils/request.js');
const accountManager = require('../utils/account.js');
const { isChatType, isThinkingEnabled, parserModel, parserMessages } = require('../utils/chat-helpers.js');
const {
  buildToolSystemPrompt,
  foldToolMessages,
  parseToolCallsFromText,
  createToolCallStreamParser
} = require('../utils/tool-prompt.js');
const { logger } = require('../utils/logger');

/**
 * 安全累计 chat stats（与 chat.js attributeChatUsage 共享语义）
 * 静默吞掉异常——stats 累计失败不应中断响应
 * 同 epic notes: tool-retry 全归属主账户（精度损失可接受）
 * @param {Object} account - 主请求账户对象
 * @param {number} promptTokens - 输入 tokens
 * @param {number} completionTokens - 输出 tokens
 */
const attributeChatUsage = (account, promptTokens, completionTokens) => {
  if (!account || !account.email) return;
  try {
    accountManager.accumulateStats(account.email, 'chat', {
      input: Number(promptTokens) || 0,
      output: Number(completionTokens) || 0
    });
  } catch (e) {
    // 静默
  }
};

/**
 * Anthropic stop_reason 枚举
 * @typedef {('end_turn'|'tool_use'|'max_tokens'|'stop_sequence')} AnthropicStopReason
 */

/**
 * 将 Anthropic system 字段规范为字符串
 * @param {string|Array<Object>} system - Anthropic system
 * @returns {string} 合并后的 system 文本
 */
const normalizeAnthropicSystem = (system) => {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter(b => b && b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }
  return '';
};

/**
 * 将 Anthropic tools 列表转为 OpenAI 风格供 buildToolSystemPrompt 使用
 * @param {Array<Object>} tools - Anthropic 工具定义
 * @returns {Array<Object>} OpenAI 风格工具定义
 */
const normalizeAnthropicTools = (tools) => {
  if (!Array.isArray(tools)) return [];
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || { type: 'object', properties: {} }
    }
  }));
};

/**
 * 将 Anthropic tool_choice 转为内部统一形式
 * @param {Object} toolChoice - Anthropic tool_choice
 * @returns {string|Object|undefined} OpenAI 风格 tool_choice
 */
const normalizeAnthropicToolChoice = (toolChoice) => {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  if (toolChoice.type === 'none') return 'none';
  return undefined;
};

/**
 * 把 Anthropic 风格的消息（含 content blocks 与 tool_use/tool_result）展开为
 * OpenAI 风格消息列表。tool_use 转为 assistant.tool_calls；tool_result 转为
 * role=tool 消息（保留 tool_call_id），后续由 foldToolMessages 折叠。
 * @param {Array<Object>} messages - Anthropic messages
 * @returns {Array<Object>} OpenAI 风格 messages
 */
const flattenAnthropicMessages = (messages) => {
  if (!Array.isArray(messages)) return [];
  const out = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;

    if (typeof msg.content === 'string') {
      out.push({ role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    if (role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (block?.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `toolu_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {})
            }
          });
        }
      }
      const out_msg = { role: 'assistant', content: textParts.join('') };
      if (toolCalls.length > 0) out_msg.tool_calls = toolCalls;
      out.push(out_msg);
      continue;
    }

    // user 角色：tool_result 拆为独立 role=tool 消息，普通文本/图片合并保留
    const collectedTextParts = [];
    for (const block of msg.content) {
      if (block?.type === 'tool_result') {
        const resultContent = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n')
            : JSON.stringify(block.content ?? '');
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          content: resultContent
        });
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        collectedTextParts.push(block.text);
      } else if (block?.type === 'image') {
        // 透传 image 块给现有 parserMessages 处理（OpenAI image_url 形态）
        const src = block.source || {};
        const url = src.type === 'base64' && src.data
          ? `data:${src.media_type || 'image/png'};base64,${src.data}`
          : (src.url || '');
        if (url) {
          if (collectedTextParts.length > 0) {
            out.push({
              role: 'user',
              content: [
                { type: 'text', text: collectedTextParts.join('') },
                { type: 'image_url', image_url: { url } }
              ]
            });
            collectedTextParts.length = 0;
          } else {
            out.push({ role: 'user', content: [{ type: 'image_url', image_url: { url } }] });
          }
        }
      }
    }
    if (collectedTextParts.length > 0) {
      out.push({ role: 'user', content: collectedTextParts.join('') });
    }
  }

  return out;
};

/**
 * 构造内部 Qwen 上游请求体
 * @param {Object} anthropicReq - Anthropic 风格请求体
 * @returns {Promise<{body: Object, hasTools: boolean, toolChoice: any, enable_thinking: boolean, model: string}>} 转换结果
 */
const buildInternalRequest = async (anthropicReq) => {
  const { model, messages, system, tools, tool_choice, stream, thinking } = anthropicReq;

  const normalizedTools = normalizeAnthropicTools(tools);
  const internalToolChoice = normalizeAnthropicToolChoice(tool_choice);

  // 1. 展开 Anthropic 消息（tool_use/tool_result 折叠由 foldToolMessages 完成）
  let flat = flattenAnthropicMessages(messages);
  const systemText = normalizeAnthropicSystem(system);

  // 2. system 文本拼到首条用户消息内容前缀（不要作为独立 system 消息，
  //    否则会被 parserMessages 折叠为 "system:..." 文字前缀污染模型理解）
  const hasTools = normalizedTools.length > 0;
  const toolPrompt = hasTools ? buildToolSystemPrompt(normalizedTools, { tool_choice: internalToolChoice }) : '';

  if (hasTools) {
    flat = foldToolMessages(flat);
  }

  // 3. 走现有 parserMessages 复用图片上传与 thinking 配置
  const enable_thinking = !!(thinking && thinking.type === 'enabled');
  const thinkingCfg = isThinkingEnabled(model, enable_thinking, thinking?.budget_tokens);
  const chatType = isChatType(model);
  const parsedMessages = await parserMessages(flat, thinkingCfg, chatType);
  const parsedModel = await parserModel(model);

  // 4. 合并 system 文本与工具提示词到最终用户消息开头
  const prefixParts = [systemText, toolPrompt].filter(Boolean);
  if (prefixParts.length > 0 && Array.isArray(parsedMessages) && parsedMessages.length > 0) {
    const prefix = prefixParts.join('\n\n');
    const last = parsedMessages[parsedMessages.length - 1];
    if (typeof last.content === 'string') {
      last.content = `${prefix}\n\n${last.content}`;
    } else if (Array.isArray(last.content)) {
      const textIdx = last.content.findIndex(c => c && c.type === 'text');
      if (textIdx >= 0) {
        last.content[textIdx].text = `${prefix}\n\n${last.content[textIdx].text || ''}`;
      } else {
        last.content.unshift({
          type: 'text',
          text: prefix,
          chat_type: 't2t',
          feature_config: { output_schema: 'phase', thinking_enabled: false }
        });
      }
    }
  }

  const body = {
    stream: !!stream,
    incremental_output: true,
    chat_type: chatType,
    sub_chat_type: chatType,
    chat_mode: 'normal',
    model: parsedModel,
    messages: parsedMessages,
    session_id: generateUUID(),
    id: generateUUID()
  };

  return {
    body,
    hasTools,
    toolChoice: internalToolChoice,
    enable_thinking: thinkingCfg.thinking_enabled,
    model: parsedModel
  };
};

/**
 * 在请求体中追加用于 required 重试的强制提示
 * @param {Object} body - 内部请求体
 * @param {string} hint - 重试提示词
 * @returns {Object} 新请求体
 */
const appendRetryHint = (body, hint) => ({
  ...body,
  messages: [
    ...(Array.isArray(body.messages) ? body.messages : []),
    { role: 'system', content: hint }
  ]
});

/**
 * 判断 tool_choice 是否需要强制调用
 * @param {string|Object} toolChoice - 内部 tool_choice
 * @returns {boolean} 是否要求至少一次工具调用
 */
const requiresToolCall = (toolChoice) => {
  if (toolChoice === 'required') return true;
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) return true;
  return false;
};

/**
 * 构建 required 重试提示
 * @param {string|Object} toolChoice - 内部 tool_choice
 * @returns {string} 提示文本
 */
const buildRetryHint = (toolChoice) => {
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
    return `You did not call any tool. You MUST now call \`${toolChoice.function.name}\` using the <tool_call>...</tool_call> format.`;
  }
  return 'You did not call any tool. You MUST now call exactly one tool using the <tool_call>...</tool_call> format.';
};

/**
 * 异步迭代上游 axios 流，按 SSE 段切分回调内部 delta JSON
 * @param {object} upstream - axios stream 响应
 * @param {(json: Object) => Promise<void>|void} onDelta - 单个 delta 回调
 * @returns {Promise<void>} 完成 Promise
 */
const consumeUpstream = (upstream, onDelta) => new Promise((resolve, reject) => {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  upstream.on('data', async (chunk) => {
    buffer += decoder.decode(chunk, { stream: true });
    const segments = [];
    let startIndex = 0;
    while (true) {
      const dataStart = buffer.indexOf('data: ', startIndex);
      if (dataStart === -1) break;
      const dataEnd = buffer.indexOf('\n\n', dataStart);
      if (dataEnd === -1) break;
      segments.push(buffer.substring(dataStart, dataEnd).trim());
      startIndex = dataEnd + 2;
    }
    if (startIndex > 0) buffer = buffer.substring(startIndex);

    for (const seg of segments) {
      const payload = seg.replace('data: ', '');
      if (!isJson(payload)) continue;
      try {
        await onDelta(JSON.parse(payload));
      } catch (e) {
        logger.error('Anthropic 上游处理错误', 'ANTHROPIC', '', e);
      }
    }
  });
  upstream.on('end', () => resolve());
  upstream.on('error', err => reject(err));
});

/**
 * 把工具调用的 arguments JSON 字符串切成 input_json_delta 切片
 * @param {string} argsJson - 完整 JSON 字符串
 * @param {number} chunkSize - 单片大小
 * @returns {Array<string>} 切片列表
 */
const sliceArgsJson = (argsJson, chunkSize = 32) => {
  const out = [];
  for (let i = 0; i < argsJson.length; i += chunkSize) {
    out.push(argsJson.slice(i, i + chunkSize));
  }
  return out;
};

/**
 * 写入一个 Anthropic SSE 事件
 * @param {object} res - Express 响应
 * @param {string} event - 事件名
 * @param {Object} data - 事件 payload
 */
const writeAnthropicEvent = (res, event, data) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

/**
 * 处理流式 Anthropic 响应
 * @param {object} res - Express 响应
 * @param {Object} ctx - 处理上下文
 * @param {object} upstream - 上游 axios 响应
 * @param {string} ctx.message_id - 消息 ID
 * @param {string} ctx.model - 模型名
 * @param {boolean} ctx.hasTools - 是否启用工具
 * @param {string|Object} ctx.toolChoice - 内部 tool_choice
 * @param {Object} ctx.requestBody - 内部请求体（用于重试）
 * @returns {Promise<void>} 完成 Promise
 */
const handleAnthropicStream = async (res, ctx, upstream) => {
  const { message_id, model, hasTools, toolChoice, requestBody } = ctx;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // message_start
  writeAnthropicEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: message_id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  let blockIndex = -1;
  let textBlockOpen = false;
  let promptTokens = 0;
  let completionTokens = 0;

  const parser = hasTools ? createToolCallStreamParser() : null;

  /**
   * 关闭当前打开的文本块
   */
  const closeTextBlockIfOpen = () => {
    if (textBlockOpen) {
      writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
      textBlockOpen = false;
    }
  };

  /**
   * 输出一段文本增量；按需打开新文本块
   * @param {string} text - 文本增量
   */
  const emitTextDelta = (text) => {
    if (!text) return;
    if (!textBlockOpen) {
      blockIndex += 1;
      writeAnthropicEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' }
      });
      textBlockOpen = true;
    }
    writeAnthropicEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text }
    });
  };

  /**
   * 输出一个完整的 tool_use 块（按 input_json_delta 切片）
   * @param {Object} call - 工具调用
   */
  const emitToolUse = (call) => {
    closeTextBlockIfOpen();
    blockIndex += 1;
    writeAnthropicEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'tool_use', id: call.id, name: call.function.name, input: {} }
    });
    const args = call.function.arguments || '{}';
    for (const piece of sliceArgsJson(args)) {
      writeAnthropicEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: piece }
      });
    }
    writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
  };

  let completionContent = '';
  let webSearchInfo = null;
  let thinkingStarted = false;
  let thinkingEnded = false;

  /**
   * 处理一个上游 delta JSON
   * @param {Object} json - 上游 SSE delta
   */
  const onUpstreamDelta = async (json) => {
    if (!json.choices || json.choices.length === 0) return;
    if (json.usage) {
      promptTokens = json.usage.prompt_tokens || promptTokens;
      completionTokens = json.usage.completion_tokens || completionTokens;
    }
    const delta = json.choices[0].delta;
    if (delta && delta.name === 'web_search') {
      webSearchInfo = delta.extra?.web_search_info;
    }
    if (!delta || !delta.content || (delta.phase !== 'think' && delta.phase !== 'answer')) return;

    let content = delta.content;
    completionContent += content;

    if (delta.phase === 'think' && !thinkingStarted) {
      thinkingStarted = true;
      content = `<think>\n\n${content}`;
    }
    if (delta.phase === 'answer' && !thinkingEnded && thinkingStarted) {
      thinkingEnded = true;
      content = `\n\n</think>\n${content}`;
    }

    if (parser && delta.phase === 'answer') {
      const parsed = parser.push(content);
      if (parsed.textDelta) emitTextDelta(parsed.textDelta);
      for (const call of parsed.completedCalls) emitToolUse(call);
    } else {
      emitTextDelta(content);
    }
  };

  await consumeUpstream(upstream, onUpstreamDelta);

  // required 重试
  if (parser && !parser.hasEmittedAnyCall() && requiresToolCall(toolChoice)) {
    const retryBody = appendRetryHint(requestBody, buildRetryHint(toolChoice));
    logger.warning?.('Anthropic 流式: tool_choice=required 首次未触发，重试一次', 'ANTHROPIC');
    try {
      const retryResp = await sendChatRequest(retryBody);
      if (retryResp.status && retryResp.response) {
        await consumeUpstream(retryResp.response, onUpstreamDelta);
      }
    } catch (e) {
      logger.error('Anthropic 流式重试失败', 'ANTHROPIC', '', e);
    }
  }

  if (parser) {
    const tail = parser.flush();
    if (tail.textDelta) emitTextDelta(tail.textDelta);
    for (const call of tail.completedCalls) emitToolUse(call);
  }

  closeTextBlockIfOpen();

  const stopReason = (parser && parser.hasEmittedAnyCall()) ? 'tool_use' : 'end_turn';

  if (promptTokens === 0 && completionTokens === 0) {
    const usage = createUsageObject(requestBody?.messages || '', completionContent, null);
    promptTokens = usage.prompt_tokens || 0;
    completionTokens = usage.completion_tokens || 0;
  }

  // Daily stats 累计——一次性归属主账户（见模块顶部 attributeChatUsage 注释）
  attributeChatUsage(ctx.currentAccount, promptTokens, completionTokens);

  writeAnthropicEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: promptTokens, output_tokens: completionTokens }
  });
  writeAnthropicEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
};

/**
 * 处理非流式 Anthropic 响应
 * @param {object} res - Express 响应
 * @param {Object} ctx - 处理上下文
 * @param {object} upstream - 上游 axios 响应
 * @returns {Promise<void>} 完成 Promise
 */
const handleAnthropicNonStream = async (res, ctx, upstream) => {
  const { message_id, model, hasTools, toolChoice, requestBody } = ctx;

  let fullContent = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let thinkingStarted = false;
  let thinkingEnded = false;

  /**
   * 处理一个上游 delta JSON 并累积 fullContent
   * @param {Object} json - 上游 SSE delta
   */
  const onUpstreamDelta = async (json) => {
    if (!json.choices || json.choices.length === 0) return;
    if (json.usage) {
      promptTokens = json.usage.prompt_tokens || promptTokens;
      completionTokens = json.usage.completion_tokens || completionTokens;
    }
    const delta = json.choices[0].delta;
    if (!delta || !delta.content || (delta.phase !== 'think' && delta.phase !== 'answer')) return;
    let content = delta.content;
    if (delta.phase === 'think' && !thinkingStarted) {
      thinkingStarted = true;
      content = `<think>\n\n${content}`;
    }
    if (delta.phase === 'answer' && !thinkingEnded && thinkingStarted) {
      thinkingEnded = true;
      content = `\n\n</think>\n${content}`;
    }
    fullContent += content;
  };

  await consumeUpstream(upstream, onUpstreamDelta);

  let { cleanedText, toolCalls } = hasTools
    ? parseToolCallsFromText(fullContent)
    : { cleanedText: fullContent, toolCalls: [] };

  // required 重试
  if (hasTools && toolCalls.length === 0 && requiresToolCall(toolChoice)) {
    logger.warning?.('Anthropic 非流式: tool_choice=required 首次未触发，重试一次', 'ANTHROPIC');
    try {
      const retryResp = await sendChatRequest(appendRetryHint(requestBody, buildRetryHint(toolChoice)));
      if (retryResp.status && retryResp.response) {
        const before = fullContent;
        await consumeUpstream(retryResp.response, onUpstreamDelta);
        const retried = fullContent.slice(before.length);
        const parsedRetry = parseToolCallsFromText(retried);
        if (parsedRetry.toolCalls.length > 0) {
          toolCalls = parsedRetry.toolCalls;
          cleanedText = parseToolCallsFromText(fullContent).cleanedText;
        }
      }
    } catch (e) {
      logger.error('Anthropic 非流式重试失败', 'ANTHROPIC', '', e);
    }
  }

  if (promptTokens === 0 && completionTokens === 0) {
    const usage = createUsageObject(requestBody?.messages || '', fullContent, null);
    promptTokens = usage.prompt_tokens || 0;
    completionTokens = usage.completion_tokens || 0;
  }

  const contentBlocks = [];
  if (cleanedText && cleanedText.trim()) {
    contentBlocks.push({ type: 'text', text: cleanedText });
  }
  for (const call of toolCalls) {
    let input = {};
    try { input = JSON.parse(call.function.arguments || '{}'); } catch (_) { input = {}; }
    contentBlocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input
    });
  }

  // Daily stats 累计——一次性归属主账户（同 stream 分支注释）
  attributeChatUsage(ctx.currentAccount, promptTokens, completionTokens);

  res.set({ 'Content-Type': 'application/json' });
  res.json({
    id: message_id,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks,
    stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: promptTokens, output_tokens: completionTokens }
  });
};

/**
 * Anthropic /v1/messages 主入口
 * @param {object} req - Express 请求
 * @param {object} res - Express 响应
 */
const handleAnthropicMessages = async (req, res) => {
  try {
    const built = await buildInternalRequest(req.body || {});
    const { body, hasTools, toolChoice, model } = built;

    const upstreamResp = await sendChatRequest(body);
    if (!upstreamResp.status || !upstreamResp.response) {
      return res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Request failed' }
      });
    }

    const message_id = `msg_${generateUUID().replace(/-/g, '').slice(0, 24)}`;
    const ctx = { message_id, model, hasTools, toolChoice, requestBody: body, currentAccount: upstreamResp.currentAccount };

    if (req.body?.stream) {
      await handleAnthropicStream(res, ctx, upstreamResp.response);
    } else {
      await handleAnthropicNonStream(res, ctx, upstreamResp.response);
    }
  } catch (error) {
    logger.error('Anthropic Messages 处理错误', 'ANTHROPIC', '', error);
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Service error' }
      });
    } else {
      try { res.end(); } catch (_) { /* ignore */ }
    }
  }
};

module.exports = {
  handleAnthropicMessages,
  // 暴露内部辅助以便测试
  flattenAnthropicMessages,
  normalizeAnthropicTools,
  normalizeAnthropicToolChoice,
  normalizeAnthropicSystem
};
