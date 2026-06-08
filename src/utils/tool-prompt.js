const { generateUUID } = require('./tools.js');
const { logger } = require('./logger');

/**
 * 工具调用 XML 起始标签
 * @type {string}
 */
const TOOL_CALL_OPEN = '<tool_call>';

/**
 * 工具调用 XML 结束标签
 * @type {string}
 */
const TOOL_CALL_CLOSE = '</tool_call>';

/**
 * 将 JSON Schema 类型压缩为简短 TypeScript 风格签名
 * @param {Object} schema - JSON Schema 节点
 * @returns {string} TS 风格类型表示
 */
const compressSchemaType = (schema) => {
  if (!schema || typeof schema !== 'object') {
    return 'any';
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  }

  const type = schema.type;

  if (type === 'array') {
    const itemType = compressSchemaType(schema.items);
    return `${itemType}[]`;
  }

  if (type === 'object') {
    if (!schema.properties || typeof schema.properties !== 'object') {
      return 'object';
    }
    const requiredKeys = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = Object.entries(schema.properties).map(([key, value]) => {
      const optional = requiredKeys.has(key) ? '' : '?';
      return `${key}${optional}: ${compressSchemaType(value)}`;
    });
    return `{ ${fields.join('; ')} }`;
  }

  if (Array.isArray(type)) {
    return type.map(t => compressSchemaType({ ...schema, type: t })).join(' | ');
  }

  return type || 'any';
};

const TOOL_PREFIX = 'My_';

/**
 * 将单个工具定义压缩为 TS 风格签名
 * @param {Object} tool - OpenAI 工具定义
 * @returns {string} 压缩后的工具描述
 */
const compressToolDefinition = (tool) => {
  const fn = tool?.function || tool;
  // 增加工具前缀，例如Write等工具会被千问保留，不让调用
  const name = fn.name ? TOOL_PREFIX + fn.name : 'unknown';
  const description = (fn?.description || '').trim();
  const params = fn?.parameters || { type: 'object', properties: {} };
  const signature = compressSchemaType(params);

  if (description) {
    return `- ${name}${signature}\n  ${description}`;
  }
  return `- ${name}${signature}`;
};

/**
 * 构建用于注入 system 消息的工具调用提示词
 * @param {Array<Object>} tools - OpenAI 风格工具定义列表
 * @param {Object} [options] - 可选参数
 * @param {string|Object} [options.tool_choice] - OpenAI tool_choice 参数
 * @returns {string} 完整的工具调用系统提示词
 */
const buildToolSystemPrompt = (tools, options = {}) => {
  if (!Array.isArray(tools) || tools.length === 0) {
    return '';
  }

  const compressed = tools
    .map(compressToolDefinition)
    .filter(Boolean)
    .join('\n');

  const lines = [
    '# Tools',
    '',
    'You have access to the following tools. When a tool call is needed, output a `<tool_call>` block exactly as shown below.',
    '',
    '## Available tools',
    compressed,
    '',
    '## Output format',
    'Emit each tool invocation as:',
    '',
    '<tool_call>',
    '{"name": "<tool_name>", "arguments": {<json_arguments>}}',
    '</tool_call>',
    '',
    'Tool results are delivered back to you as user messages wrapped like this:',
    '',
    '<tool_response tool_call_id="<id>" name="<tool_name>">',
    '<result text or JSON>',
    '</tool_response>',
    '',
    'Rules:',
    '- The JSON inside `<tool_call>` must be valid and on a single logical block.',
    '- Use the exact tool name listed above.',
    '- Provide all required arguments; omit unknown ones.',
    '- You may emit multiple `<tool_call>` blocks back-to-back when more than one tool is needed.',
    '- After tool results are returned (as user/tool messages), continue the reply normally.',
    '- Do not wrap `<tool_call>` blocks in code fences or extra commentary.'
  ];

  const choice = options.tool_choice;
  if (choice === 'required') {
    lines.push('- You MUST call at least one tool before answering.');
  } else if (choice && typeof choice === 'object' && choice.function?.name) {
    lines.push(`- You MUST call the tool \`${choice.function.name}\` first.`);
  } else if (choice === 'none') {
    lines.push('- Do NOT call any tool for this turn; respond as plain text.');
  }

  return lines.join('\n');
};

/**
 * 将历史中的 assistant tool_calls / tool 角色消息折叠成纯文本，
 * 以便上游网页接口（仅识别 user/assistant/system）能正确接收上下文。
 * 折叠时保留原始 tool_call_id，并将后续 role=tool 消息按 id 精确回链。
 * @param {Array<Object>} messages - 原始 OpenAI 风格消息数组
 * @returns {Array<Object>} 折叠后的消息数组
 */
const foldToolMessages = (messages) => {
  if (!Array.isArray(messages)) return messages;

  const callIdToName = new Map();

  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;

    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const blocks = message.tool_calls.map((call) => {
        let args = call?.function?.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch (_) {
            // 保留原始字符串形式
          }
        }
        const name = call?.function?.name || 'unknown';
        const id = call?.id || `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`;
        callIdToName.set(id, name);
        const payload = { id, name, arguments: args ?? {} };
        return `${TOOL_CALL_OPEN}\n${JSON.stringify(payload)}\n${TOOL_CALL_CLOSE}`;
      });
      const original = typeof message.content === 'string' ? message.content : '';
      return {
        role: 'assistant',
        content: [original, blocks.join('\n')].filter(Boolean).join('\n')
      };
    }

    if (message.role === 'tool') {
      const callId = message.tool_call_id || '';
      const name = message.name || callIdToName.get(callId) || 'tool';
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? '');
      const idAttr = callId ? ` tool_call_id="${escapeAttr(callId)}"` : '';
      return {
        role: 'user',
        content: `<tool_response${idAttr} name="${escapeAttr(name)}">\n${content}\n</tool_response>`
      };
    }

    return message;
  });
};

/**
 * 转义 XML 属性中的特殊字符
 * @param {string} value - 原始字符串
 * @returns {string} 转义后的字符串
 */
const escapeAttr = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/**
 * 解析单段 `<tool_call>...</tool_call>` 内的 JSON 负载
 * @param {string} raw - 标签内的原始字符串
 * @returns {{ name: string, arguments: Object }|null} 解析结果
 */
const parseToolCallPayload = (raw) => {
  if (!raw) return null;

  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(text);

    if (!parsed || typeof parsed !== 'object') return null;
    let name = parsed.name || parsed.tool || parsed.function;
    const args = parsed.arguments ?? parsed.parameters ?? parsed.args ?? {};
    if (!name) return null;
    // 去掉工具前缀
    name = name.replace(TOOL_PREFIX, '');
    return { name, arguments: args };
  } catch (error) {
    logger.warning?.('解析 tool_call 负载失败', 'TOOL', text, error?.message);
    return null;
  }
};

/**
 * 从完整文本中提取所有工具调用块
 * @param {string} fullText - 模型完整输出
 * @returns {{ cleanedText: string, toolCalls: Array<Object> }} 抽取结果
 */
const parseToolCallsFromText = (fullText) => {
  if (typeof fullText !== 'string' || !fullText.includes(TOOL_CALL_OPEN)) {
    return { cleanedText: fullText || '', toolCalls: [] };
  }

  const toolCalls = [];
  const pattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const cleanedText = fullText.replace(pattern, (_, inner) => {
    const payload = parseToolCallPayload(inner);
    if (payload) {
      toolCalls.push({
        id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: payload.name,
          arguments: JSON.stringify(payload.arguments ?? {})
        }
      });
    }
    return '';
  });

  return { cleanedText: cleanedText.trim(), toolCalls };
};

/**
 * 创建增量式工具调用流解析器
 * 接收 content delta，识别 `<tool_call>` 块边界，
 * 对外吐出文本增量与已完成的工具调用对象。
 * @returns {{
 *   push: (chunk: string) => { textDelta: string, completedCalls: Array<Object> },
 *   flush: () => { textDelta: string, completedCalls: Array<Object> },
 *   hasPendingCall: () => boolean,
 *   hasEmittedAnyCall: () => boolean
 * }} 解析器实例
 */
const createToolCallStreamParser = () => {
  let pendingText = '';
  let inToolCall = false;
  let toolCallBuffer = '';
  let emittedCallCount = 0;

  /**
   * 在等待标签出现时，安全地输出已确定不是标签前缀的部分
   * @param {string} text - 当前累积的文本
   * @returns {{ safe: string, remainder: string }} 切分结果
   */
  const splitSafeText = (text) => {
    const openIdx = text.indexOf(TOOL_CALL_OPEN);
    if (openIdx !== -1) {
      return { safe: text.slice(0, openIdx), remainder: text.slice(openIdx) };
    }
    const maxCheck = Math.min(text.length, TOOL_CALL_OPEN.length - 1);
    for (let len = maxCheck; len > 0; len--) {
      const tail = text.slice(text.length - len);
      if (TOOL_CALL_OPEN.startsWith(tail)) {
        return { safe: text.slice(0, text.length - len), remainder: tail };
      }
    }
    return { safe: text, remainder: '' };
  };

  const push = (chunk) => {
    const result = { textDelta: '', completedCalls: [] };
    if (typeof chunk !== 'string' || chunk.length === 0) return result;

    let buffer = chunk;

    while (buffer.length > 0) {
      if (inToolCall) {
        toolCallBuffer += buffer;
        buffer = '';
        const closeIdx = toolCallBuffer.indexOf(TOOL_CALL_CLOSE);
        if (closeIdx === -1) {
          break;
        }
        const inner = toolCallBuffer.slice(0, closeIdx);
        buffer = toolCallBuffer.slice(closeIdx + TOOL_CALL_CLOSE.length);
        toolCallBuffer = '';
        const payload = parseToolCallPayload(inner);
        if (payload) {
          result.completedCalls.push({
            index: emittedCallCount,
            id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'function',
            function: {
              name: payload.name,
              arguments: JSON.stringify(payload.arguments ?? {})
            }
          });
          emittedCallCount += 1;
        }
        inToolCall = false;
        continue;
      }

      pendingText += buffer;
      buffer = '';

      const openIdx = pendingText.indexOf(TOOL_CALL_OPEN);
      if (openIdx !== -1) {
        const before = pendingText.slice(0, openIdx);
        if (before) result.textDelta += before;
        const tail = pendingText.slice(openIdx + TOOL_CALL_OPEN.length);
        pendingText = '';
        inToolCall = true;
        buffer = tail;
        continue;
      }

      const { safe, remainder } = splitSafeText(pendingText);
      if (safe) result.textDelta += safe;
      pendingText = remainder;
    }

    return result;
  };

  const flush = () => {
    const result = { textDelta: '', completedCalls: [] };
    if (inToolCall && toolCallBuffer) {
      const payload = parseToolCallPayload(toolCallBuffer);
      if (payload) {
        result.completedCalls.push({
          index: emittedCallCount,
          id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function',
          function: {
            name: payload.name,
            arguments: JSON.stringify(payload.arguments ?? {})
          }
        });
        emittedCallCount += 1;
      }
      toolCallBuffer = '';
      inToolCall = false;
    }
    if (pendingText) {
      result.textDelta += pendingText;
      pendingText = '';
    }
    return result;
  };

  return {
    push,
    flush,
    hasPendingCall: () => inToolCall,
    hasEmittedAnyCall: () => emittedCallCount > 0
  };
};

module.exports = {
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE,
  buildToolSystemPrompt,
  foldToolMessages,
  parseToolCallsFromText,
  createToolCallStreamParser
};
