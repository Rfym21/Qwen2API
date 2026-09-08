const { isJson, generateUUID } = require('../utils/tools.js');
const { createUsageObject } = require('../utils/precise-tokenizer.js');
const { sendChatRequest } = require('../utils/request.js');
const accountManager = require('../utils/account.js');
const {
  isChatType, isThinkingEnabled, parserModel, parserMessages, isThinkPhase, extractMediaToFiles,
  createUpstreamDeltaNormalizer, createClientToolNamePredicate, willBeFolded
} = require('../utils/chat-helpers.js');
const {
  buildToolSystemPrompt,
  foldToolMessages,
  parseToolCallsFromText,
  createToolCallStreamParser,
  createNativeToolCallAccumulator,
  looksLikeUnexecutedToolAction,
  containsOrphanProtocolResidue,
  stripToolCallResidue,
  ANSWER_PHASES,
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE
} = require('../utils/tool-prompt.js');
const {
  createAgentTagStripper,
  stripAgentTags,
  buildAgentRetryHint,
  buildAgentTurnDirective,
  buildToolHistoryLedger,
  extractHistoryToolCalls,
  // Guarda de fuga del canal de texto: una sola implementacion para ambos caminos
  // (spec agent-turn-cutoff-openai-parity). El `tag` de logging es parametro.
  createToolCallLedger,
  resolveTextToolCallCap,
  createTextChannelRunawayGuard
} = require('../utils/agent-turn.js');
const { ensureAgentCurrentEnvelope } = require('../middlewares/chat-middleware.js');
const { mapIncomingModel } = require('../utils/model-map.js');
const { consumeSSEStream, createUpstreamResponseFilter } = require('../utils/sse.js');
const { logger } = require('../utils/logger');
const { assertNoUpstreamFailure } = require('../utils/upstream-error.js');
const {
  analyzeAnthropicCompatibility,
  buildAnthropicCompatibilityHeaders
} = require('./anthropic.compatibility.js');

const mapAnthropicStopReason = (upstreamReason, hasToolCalls, upstreamCompleted) => {
  // El truncamiento manda SOBRE tool_use. Un turno que el upstream corto a mitad de
  // emision puede llevar una llamada con los argumentos incompletos; `tool_use` le dice
  // al cliente "ya termine de pedirla, ejecutala" y la ejecuta igual. La API nativa
  // reporta `max_tokens` ahi: el turno no termino. Los bloques `tool_use` ya emitidos
  // siguen viajando —— esto es precedencia de stop_reason, no supresion de la llamada.
  if (upstreamReason === 'length' || upstreamReason === 'max_tokens') return 'max_tokens';
  if (hasToolCalls) return 'tool_use';
  if (upstreamReason === 'stop_sequence') return 'stop_sequence';
  if (upstreamReason === 'content_filter' || upstreamReason === 'refusal') return 'refusal';
  if (upstreamReason === 'stop' || upstreamReason === 'end_turn') return 'end_turn';
  if (!upstreamReason && upstreamCompleted) return 'end_turn';
  return null;
};

/**
 * Acuna un id de `tool_use` en el espacio de nombres nativo de Anthropic.
 * @returns {string} `toolu_` + 24 hex minusculas
 */
const newAnthropicToolUseId = () => `toolu_${generateUUID().replace(/-/g, '').slice(0, 24)}`;

const ANTHROPIC_TOOL_USE_ID = /^toolu_[0-9a-f]{24}$/;
// La forma que acuna el constructor compartido (tool-prompt.js createToolCallObject /
// buildEmitted): `call_` + los mismos 24 hex.
const SHARED_TOOL_CALL_ID = /^call_([0-9a-f]{24})$/;

/**
 * Reetiqueta al namespace nativo el id de una llamada en el BORDE DE EMISION de esta
 * ruta. La reescritura no puede vivir en el constructor compartido: /v1/chat/completions
 * emite `call_` y esa forma es parte de su contrato. Los dos sitios de emision de
 * /v1/messages (stream `emitToolUse` y el bucle no-stream que arma `content[]`) son
 * gemelos y llaman aqui los dos.
 *
 * El reetiquetado conserva los 24 hex, asi que dos llamadas distintas del mismo turno
 * (ids frescos por UUID) siguen siendo distintas. Un id de otra forma no se puede
 * reetiquetar sin arriesgar colisiones: se acuna uno nuevo.
 *
 * Ojo con la direccion de ENTRADA: `flattenAnthropicMessages` NO pasa por aqui. Ahi el
 * id lo pone el cliente (`toolu_01LhEfp5...`, base62, no 24 hex) y es la clave que
 * enlaza el `tool_use` con su `tool_result`; reescribirlo romperia la correlacion.
 *
 * @param {string} id - id de la llamada tal como lo acuno el constructor compartido
 * @returns {string} id en el namespace `toolu_`
 */
const toAnthropicToolUseId = (id) => {
  if (typeof id === 'string') {
    if (ANTHROPIC_TOOL_USE_ID.test(id)) return id;
    const shared = SHARED_TOOL_CALL_ID.exec(id);
    if (shared) return `toolu_${shared[1]}`;
  }
  return newAnthropicToolUseId();
};

const writeAnthropicError = (res, message, errorType = 'api_error') => {
  writeAnthropicEvent(res, 'error', {
    type: 'error',
    error: { type: errorType, message }
  });
  res.end();
};

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
 * 把一个 Anthropic `image` 块转成 parserMessages 认识的 OpenAI `image_url` 项。
 * base64 source 转 data URI（由 normalizeMediaContentItem 负责上传），url source 直接透传。
 * 单一实现：普通 image 块和 tool_result 里的 image 块共用它。
 * @param {Object} block - Anthropic image 块
 * @returns {{type: 'image_url', image_url: {url: string}}|null} 无法取到 url 时返回 null
 */
const anthropicImageBlockToItem = (block) => {
  const src = block?.source || {};
  const url = src.type === 'base64' && src.data
    ? `data:${src.media_type || 'image/png'};base64,${src.data}`
    : (src.url || '');
  return url ? { type: 'image_url', image_url: { url } } : null;
};

/**
 * 把 Anthropic 风格的消息（含 content blocks 与 tool_use/tool_result）展开为
 * OpenAI 风格消息列表。tool_use 转为 assistant.tool_calls；tool_result 转为
 * role=tool 消息（保留 tool_call_id），后续由 foldToolMessages 折叠。
 * @param {Array<Object>} messages - Anthropic messages
 * @returns {Array<Object>} OpenAI 风格 messages
 */
const UNSUPPORTED_BLOCK_NOTE = (type) => `[unsupported content block: ${type} — not forwarded]`;

const flattenAnthropicMessages = (messages) => {
  // 本次调用里被丢弃的块类型，用于收尾时一条 WARN（不是每块一条）。
  const droppedBlockTypes = new Set();
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
            id: block.id || newAnthropicToolUseId(),
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
    const outLenBeforeUserMsg = out.length;
    const collectedTextParts = [];
    const flushCollectedText = () => {
      if (collectedTextParts.length === 0) return;
      out.push({ role: 'user', content: collectedTextParts.join('') });
      collectedTextParts.length = 0;
    };
    for (const block of msg.content) {
      if (block?.type === 'tool_result') {
        flushCollectedText();
        const resultContent = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n')
            : JSON.stringify(block.content ?? '');
        const toolMessage = {
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          content: resultContent
        };
        // Claude Code 的 Read 把图片放在 tool_result.content 里。resultContent 依旧只取
        // text 块（保持逐字节不变），图片改走 media 旁路：role=tool 的 content 必须是
        // 字符串，foldToolMessages 会把非字符串 JSON.stringify 掉，图片项塞进去就废了。
        const toolResultMedia = Array.isArray(block.content)
          ? block.content.filter(b => b?.type === 'image').map(anthropicImageBlockToItem).filter(Boolean)
          : [];
        if (toolResultMedia.length > 0) toolMessage.media = toolResultMedia;
        out.push(toolMessage);
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        collectedTextParts.push(block.text);
      } else if (block?.type === 'image') {
        // 透传 image 块给现有 parserMessages 处理（OpenAI image_url 形态）
        const imageItem = anthropicImageBlockToItem(block);
        if (!imageItem) {
          // source:{type:'file', file_id} 是 Anthropic 有文档的形态，我们不支持。
          // 以前它在这里无声消失，模型对着「一张它从没收到的图」作答。
          droppedBlockTypes.add(`image(${block?.source?.type || 'unknown'})`);
          collectedTextParts.push(UNSUPPORTED_BLOCK_NOTE('image'));
        } else {
          if (collectedTextParts.length > 0) {
            out.push({
              role: 'user',
              content: [
                { type: 'text', text: collectedTextParts.join('') },
                imageItem
              ]
            });
            collectedTextParts.length = 0;
          } else {
            out.push({ role: 'user', content: [imageItem] });
          }
        }
      } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
        // 故意丢弃：无法回放给 Qwen，而且丢掉它不会改变用户的意图。
      } else {
        // 兜底分支。以前这里什么都没有：document（PDF）、search_result、server_tool_use…
        // 全部无声消失，模型只收到包围它们的那句话就去回答。
        droppedBlockTypes.add(block?.type || 'unknown');
        collectedTextParts.push(UNSUPPORTED_BLOCK_NOTE(block?.type || 'unknown'));
      }
    }
    flushCollectedText();
    // 整条用户消息一个块都没产出（例如 spec 合法的 content: []）时，绝不能让它凭空消失：
    // 消息一旦少一条，parserMessages 会把**上一条 assistant** 当成 "# Current message"，
    // 模型于是对着自己上一轮的回答作答；只有这一条时它直接抛错，被吞掉后上游收到的是
    // 字面量 '聊天历史处理有误…'。保留一个空位，语义不变而结构完整。
    if (out.length === outLenBeforeUserMsg) {
      out.push({ role: 'user', content: '' });
    }
  }

  if (droppedBlockTypes.size > 0) {
    logger.warn(
      `Anthropic content blocks not forwarded: ${Array.from(droppedBlockTypes).join(', ')}`,
      'ANTHROPIC'
    );
  }

  return out;
};

/**
 * 构造内部 Qwen 上游请求体
 * @param {Object} anthropicReq - Anthropic 风格请求体
 * @returns {Promise<{body: Object, hasTools: boolean, toolChoice: any, allowedToolNames: string[], enable_thinking: boolean, model: string}>} 转换结果
 */
const buildInternalRequest = async (anthropicReq) => {
  const { messages, system, tools, tool_choice, stream, thinking } = anthropicReq;
  // 先做 MODEL_MAP 映射，再判定 thinking / chat_type：目标 id 的 -thinking 后缀要照常生效
  const model = await mapIncomingModel(anthropicReq.model);

  const normalizedTools = normalizeAnthropicTools(tools);
  const internalToolChoice = normalizeAnthropicToolChoice(tool_choice);

  // 0. Detect afterToolResult from original messages before flattening
  const originalLast = Array.isArray(messages) ? messages[messages.length - 1] : null;
  const afterToolResult = originalLast?.role === 'user' && Array.isArray(originalLast?.content) && originalLast.content.some(b => b?.type === 'tool_result');

  // 1. 展开 Anthropic 消息（tool_use/tool_result 折叠由 foldToolMessages 完成）
  let flat = flattenAnthropicMessages(messages);
  // tool_result 里的图片走 media 旁路（见 flattenAnthropicMessages）。只收当前回合的：
  // 从尾部往回扫到上一条 assistant 为止，正好是「最后一次助手发言之后」的这一轮。
  // 更早的历史图片不重新附加——那是本 PR 明确排除的范围。
  const HARVEST_MEDIA_CAP = 4;
  const currentTurnMedia = [];
  let scanFrom = flat.length - 1;
  // assistant prefill（最后一条就是 assistant）属于当前回合，不是回合边界：
  // 跳过它再开始找边界，否则同一回合 tool_result 里的图片永远收不到。
  if (flat[scanFrom]?.role === 'assistant') scanFrom -= 1;
  const lastFlatIndex = flat.length - 1;
  // 同一张图会从两条路进来：用户消息的 content[]，以及 tool_result 的 media 旁路
  // （Claude Code 贴图后又让 Read 读了同一个文件）。按 URL 去重，否则 files[] 里
  // 会出现两条一模一样的记录 = 两次上传 + 提示词里两张一样的图。
  //
  // 种子**只**取最后一条 flat 消息的 content[]，绝不取它的 .media：正常的 Read 回合里
  // 最后一条就是携带图片的 tool 消息，拿它的 .media 播种会把唯一那份也毙掉，图片直接消失。
  const seenMediaUrls = new Set();
  const isFreshMedia = (item) => {
    const url = item?.image_url?.url;   // anthropicImageBlockToItem 产出的形状
    if (typeof url !== 'string' || url.length === 0) return true;
    if (seenMediaUrls.has(url)) return false;
    seenMediaUrls.add(url);
    return true;
  };
  if (Array.isArray(flat[lastFlatIndex]?.content)) {
    flat[lastFlatIndex].content.filter(item => item?.type === 'image_url').forEach(isFreshMedia);
  }
  for (let i = scanFrom; i >= 0; i--) {
    const candidate = flat[i];
    if (candidate?.role === 'assistant') {
      // 回合边界是**最终答复**，不是任意一条 assistant。工具循环里同一个用户回合会有
      // 好几条 assistant，每条都带 tool_calls，都是中间步骤。按「任意 assistant」断
      // （本函数的初版写法）意味着：用户贴的图在**第一次**工具调用就没了，tool_result
      // 里的图片从第二个 assistant 回合起就没了。
      //
      // 2026-09-08 对着真实上游实测（/v1/messages，qwen3.8-max，446 字节品红 PNG）：
      //   图片在最后一条、无工具        → uploads_delta=1，答 "magenta"
      //   图片 + 一次 tool round-trip   → uploads_delta=0，答 "no image was provided"
      //   图片 + 两次 tool round-trip   → uploads_delta=0，同上
      // 与 chat-helpers.js#harvestCurrentTurnMedia 是孪生体，两边必须一起改。
      // function_call 在本路径上是死分支（flattenAnthropicMessages 只产出 tool_calls），
      // 保留它纯粹是为了和孪生体逐字对齐。
      const midTurnCall = (Array.isArray(candidate.tool_calls) && candidate.tool_calls.length > 0) ||
        !!candidate.function_call?.name;
      if (midTurnCall) continue;
      break;
    }
    const fromCandidate = [];
    // media 旁路故意不加 lastFlatIndex 守卫：最后一条 tool 消息的 content 是字符串，
    // parserMessages 从它身上一个媒体项也拿不到，单步 Read 回合能通正是靠这个不对称。
    if (Array.isArray(candidate?.media)) fromCandidate.push(...candidate.media.filter(isFreshMedia));
    // content[] 里的图片同样只有挂在最后一条消息上才会被上传：parserMessages 的多条分支
    // 只对 lastMessage 调 normalizeMediaContentItem，更早那些被 extractTextFromContent
    // 整个抹掉，一行日志都没有。粘贴图片的 Claude Code 正好命中这里——它先发
    // [text, image]，再补一条只有文本的 meta 消息（`[Image: source: …png]`），
    // 于是图片永远不是最后一条。最后一条不碰：那条 parserMessages 自己会处理。
    if (i !== lastFlatIndex && Array.isArray(candidate?.content)) {
      const carried = candidate.content.filter(item => item?.type === 'image_url');
      if (carried.length > 0) {
        // 去重只影响**要不要重新挂上去**；摘除是无条件的。被去重毙掉的那份留在历史正文里
        // 既进不了上游（历史只保留 text），又白占体积。
        fromCandidate.push(...carried.filter(isFreshMedia));
        // 必须从原消息里摘掉：留着的话它既进不了上游（历史正文只保留 text），
        // 又会和重新挂到最后一条的那份重复。只剩一个文本项时收敛回字符串，
        // 正是 formatSingleMessage 期待的形状。
        const rest = candidate.content.filter(item => item?.type !== 'image_url');
        candidate.content = rest.length === 1 && rest[0]?.type === 'text' && typeof rest[0].text === 'string'
          ? rest[0].text
          : rest;
      }
    }
    if (fromCandidate.length > 0) currentTurnMedia.unshift(...fromCandidate);
    // 与孪生体同一个上限，按项算不按消息算（chat-helpers.js#HARVEST_MEDIA_CAP）。
    if (currentTurnMedia.length >= HARVEST_MEDIA_CAP) break;
  }
  // media 是内部旁路，绝不能进上游请求体。历史消息里的 media 携带完整 base64 data URI，
  // 目前只是碰巧被 foldToolMessages 丢掉，而它只在带工具时才跑——所以在这里全量清掉。
  for (const message of flat) {
    if (message && 'media' in message) delete message.media;
  }
  const systemText = normalizeAnthropicSystem(system);

  // 2. system 文本拼到首条用户消息内容前缀（不要作为独立 system 消息，
  //    否则会被 parserMessages 折叠为 "system:..." 文字前缀污染模型理解）
  // ponytail: gate on tool_choice !== 'none' to match OpenAI path (chat-middleware.js:7-12)
  const hasTools = normalizedTools.length > 0 && internalToolChoice !== 'none';
  const toolPrompt = hasTools ? buildToolSystemPrompt(normalizedTools, { tool_choice: internalToolChoice }) : '';
  // El ledger se arma sobre `flat` ANTES de foldToolMessages: despues del folding la
  // llamada ya es texto dentro de un string (`[TOOL CALL #1]`), sin tool_calls ni
  // tool_call_id que recorrer — el ledger saldria vacio y el bloque desapareceria sin
  // ruido. Gemelo de chat-middleware.js#processRequestBody, que lo arma sobre `messages`
  // antes de su propio fold; los dos caminos tienen que moverse juntos.
  const toolLedger = hasTools ? buildToolHistoryLedger(flat) : '';
  // Semilla del ledger de deduplicacion, del MISMO recorrido pre-fold y con los mismos
  // ordinales que ve el modelo. No suprime nada: marca la llamada como ya ejecutada para
  // poder registrarla (los tres createToolCallLedger eran por-intento y jamas miraron la
  // historia). Gemelo de chat-middleware.js#processRequestBody -> req.tool_history_calls.
  const historyToolCalls = hasTools ? extractHistoryToolCalls(flat) : [];

  // La historia se pliega segun lo que CONTIENE, no segun lo que esta peticion declara.
  // Con el fold detras de `hasTools`, una peticion sin `tools` (o con
  // `tool_choice: 'none'`) dejaba intacto al assistant que solo lleva `tool_use`: su
  // `content` es '' y formatSingleMessage (chat-helpers.js) descarta todo mensaje cuyo
  // texto queda vacio, asi que EL TURNO ENTERO desaparecia de la historia mientras su
  // `tool_result` sobrevivia como una linea JSONL con el rol inexistente "tool" — el
  // modelo veia un resultado sin la llamada que lo pidio. La compactacion y el resumen
  // de Claude Code tienen justo esa forma, y llegan sin `tools`.
  //
  // Esto es RENDERIZADO, no protocolo: el prompt de herramientas, el ledger y la
  // directiva de turno siguen atados a `hasTools` (arriba y en el paso 5). Una peticion
  // sin herramientas recupera su historia legible sin aprender a llamarlas.
  //
  // El criterio se importa de chat-helpers.js#willBeFolded en vez de reescribirlo: esa
  // funcion ya existe para el barrido de medios y su contrato es "¿foldToolMessages
  // reescribe este mensaje?", alineado literal con las dos ramas del fold.
  if (hasTools || flat.some(willBeFolded)) {
    flat = foldToolMessages(flat);
  }

  // 折叠之后再挂图片：parserMessages 只处理最后一条消息里的媒体，挂在这里的图片
  // 才会被上传，而工具结果正文仍然留在 "# Current message" 里（agent 回合语义不变）。
  if (currentTurnMedia.length > 0 && flat.length > 0) {
    const lastFlat = flat[flat.length - 1];
    if (typeof lastFlat.content === 'string') {
      lastFlat.content = [{ type: 'text', text: lastFlat.content }, ...currentTurnMedia];
    } else if (Array.isArray(lastFlat.content)) {
      lastFlat.content = [...lastFlat.content, ...currentTurnMedia];
    }
  }

  // 3. 走现有 parserMessages 复用图片上传与 thinking 配置
  const enable_thinking = !!(thinking && thinking.type === 'enabled');
  const thinkingCfg = await isThinkingEnabled(model, enable_thinking, thinking?.budget_tokens);
  const chatType = isChatType(model);
  const parsedMessages = await parserMessages(flat, thinkingCfg, chatType);
  const parsedModel = await parserModel(model);

  // 4. 合并 system 文本与工具提示词到最终用户消息开头
  // Orden fijo en ambos caminos: toolPrompt -> ledger -> envelope -> directive. El ledger
  // va pegado al protocolo porque es parte del contrato de herramientas (sin el protocolo
  // delante seria una lista de ordinales sueltos), y delante de la historia que documenta.
  // Vive en el prefijo, que parseAgentEnvelope (utils/request.js) nunca externaliza: si
  // cayera dentro del bloque de historia, el contrapeso desapareceria justo en las
  // conversaciones largas, que son las que repiten llamadas.
  const prefixParts = [systemText, toolPrompt, toolLedger].filter(Boolean);
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

  // 5. Agent-loop injections (match OpenAI path ordering: envelope → prefix → directive)
  if (hasTools && Array.isArray(parsedMessages) && parsedMessages.length > 0) {
    const last = parsedMessages[parsedMessages.length - 1];
    const role = last.role || 'user';
    // Wrap content with # Current message marker so upstream distinguishes turn from history
    last.content = ensureAgentCurrentEnvelope(last.content, role);
    // Append agent-turn directive after full content assembly
    const directive = buildAgentTurnDirective({ afterToolResult });
    if (typeof last.content === 'string') {
      last.content = `${last.content}\n\n${directive}`;
    } else if (Array.isArray(last.content)) {
      const textIdx = last.content.findIndex(c => c && c.type === 'text');
      if (textIdx >= 0) {
        last.content[textIdx].text = `${last.content[textIdx].text || ''}\n\n${directive}`;
      } else {
        last.content.push({ type: 'text', text: directive });
      }
    }
  }

  // Align with React UI envelope format (chat-middleware.js lines 63-100)
  // to avoid WAF/captcha rejection (FAIL_SYS_USER_VALIDATE).
  const now = Math.floor(Date.now() / 1000);
  const fid = generateUUID();
  const lastParsed = Array.isArray(parsedMessages) && parsedMessages.length > 0
    ? parsedMessages[parsedMessages.length - 1]
    : { role: 'user', content: '' };
  // 媒体从 content[] 换到 files[]：content[] 带图 + files[] 带外置上下文文档的组合
  // 会让上游 500（详见 extractMediaToFiles）。无媒体时原样返回，请求体逐字节不变。
  const { content: envelopeContent, files: envelopeFiles } = extractMediaToFiles(lastParsed.content || '');

  const envelopeMessage = {
    id: null,
    fid: fid,
    parentId: null,
    parent_id: null,
    childrenIds: [generateUUID()],
    role: lastParsed.role || 'user',
    content: envelopeContent,
    user_action: 'chat',
    files: envelopeFiles,
    timestamp: now,
    models: [parsedModel],
    model: '',
    chat_type: chatType,
    feature_config: {
      output_schema: 'phase',
      thinking_enabled: thinkingCfg.thinking_enabled,
      research_mode: 'normal',
      auto_thinking: true,
      thinking_mode: 'Auto',
      thinking_format: 'summary',
      auto_search: true
    },
    extra: { meta: { subChatType: chatType } },
    sub_chat_type: chatType
  };

  const body = {
    stream: !!stream,
    version: '2.1',
    incremental_output: true,
    chat_id: null,
    chatId: null,
    chat_mode: 'normal',
    model: parsedModel,
    parent_id: null,
    parentId: null,
    messages: [envelopeMessage],
    timestamp: now,
    chat_type: chatType,
    sub_chat_type: chatType,
    session_id: generateUUID(),
    id: generateUUID()
  };

  // Pass max_tokens to upstream if provided (guard against NaN/Infinity)
  if (anthropicReq.max_tokens != null) {
    const mt = Number(anthropicReq.max_tokens);
    if (Number.isFinite(mt) && mt > 0) {
      body.max_tokens = mt;
    }
  }

  // 抢救的 schema 闸门数据源：工具名 → input_schema（normalizeAnthropicTools 已把它
  // 放进 function.parameters）。Object.create(null)：工具名来自请求方，绝不能让
  // __proto__ 之类的名字碰原型链。重名 fail closed（review loop 1，条目 12）：
  // 同名声明两次的工具没有唯一 schema —— 有歧义就没有抢救，last-wins 会让先声明
  // 的 schema 静默失效。
  const toolSchemas = Object.create(null);
  const duplicatedToolNames = new Set();
  for (const tool of normalizedTools) {
    const name = tool.function?.name;
    if (!name) continue;
    if (duplicatedToolNames.has(name) || Object.prototype.hasOwnProperty.call(toolSchemas, name)) {
      duplicatedToolNames.add(name);
      delete toolSchemas[name];
      continue;
    }
    toolSchemas[name] = tool.function.parameters;
  }

  return {
    body,
    hasTools,
    historyToolCalls,
    toolChoice: internalToolChoice,
    allowedToolNames: normalizedTools.map(tool => tool.function.name).filter(Boolean),
    toolSchemas,
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
const appendRetryHint = (body, hint) => {
  const messages = Array.isArray(body.messages)
    ? body.messages.map(message => ({ ...message }))
    : [];
  if (messages.length === 0) {
    messages.push({ role: 'user', content: hint });
  } else {
    const last = messages[messages.length - 1];
    if (typeof last.content === 'string') {
      last.content = `${last.content}\n\n# Tool-call retry\n${hint}`;
    } else if (Array.isArray(last.content)) {
      const textPart = last.content.find(part => part?.type === 'text');
      if (textPart) {
        textPart.text = `${textPart.text || ''}\n\n# Tool-call retry\n${hint}`;
      } else {
        last.content = [{ type: 'text', text: hint }, ...last.content];
      }
    }
  }
  return { ...body, messages };
};

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
    return `You did not call any tool. You MUST now call \`${toolChoice.function.name}\` using the ${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE} format.`;
  }
  return `You did not call any tool. You MUST now call exactly one tool using the ${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE} format.`;
};

const buildEmptyOutputRetryHint = () => [
  'Your previous reply produced no visible final answer or executable tool call.',
  `Continue the Agent task now. If any action remains, emit the required \`${TOOL_CALL_OPEN}\` block immediately with no preamble.`,
  'Only give a normal final answer when the task is actually complete; do not repeat hidden reasoning.'
].join(' ');

const buildMissingToolRetryHint = () => [
  'Your previous reply described an action but did not execute any tool call.',
  `Perform that action now by emitting the real \`${TOOL_CALL_OPEN}\` block immediately with no preamble.`,
  'Do not describe the action again or claim completion without a tool result.'
].join(' ');

/**
 * 把解析器的错误列表压成一行可读的诊断串。
 * @param {Array<Object>} errors - parser/native accumulator 的 getErrors()
 * @returns {string} 形如 `unknown_tool: Bash, Read; invalid_json ×2`
 */
const describeToolErrors = (errors) => {
  const unknown = [...new Set(
    errors.filter(e => e?.type === 'unknown_tool').map(e => e.name).filter(Boolean)
  )];
  const parts = [];
  if (unknown.length) parts.push(`unknown_tool: ${unknown.join(', ')}`);
  // salvage_rejected 单列：抢救闸门的拒绝正是 salvage-3 瞄准的类，诊断时
  // 不能和真正的坏 JSON 混在一堆（review loop 1，条目 11）。后四种来自原生累积器
  // （createNativeToolCallAccumulator）——以前它们没被计入，日志只打 unspecified。
  for (const type of [
    'invalid_json', 'truncated_tool_call', 'salvage_rejected',
    'invalid_arguments', 'missing_tool_name', 'truncated_native_call', 'schema_mismatch'
  ]) {
    const count = errors.filter(e => e?.type === type).length;
    if (count) parts.push(`${type} ×${count}`);
  }
  return parts.join('; ') || 'unspecified';
};

/**
 * 工具错误的重试提示。基础文本复用 agent-turn.js 的通用提示；当错误是编造的工具名时，
 * 补上真实的名字 —— 那是让这类错误可恢复的唯一信息。原生调用的参数不合法
 * （invalid_arguments / schema_mismatch）时，点名该工具：模型要重发的是参数，不是名字。
 * @param {Array<Object>} errors - 本轮的工具错误
 * @param {Array<string>} allowedToolNames - 本次请求真正提供的工具名
 * @returns {string} 提示文本
 */
const buildToolErrorRetryHint = (errors, allowedToolNames) => {
  const base = buildAgentRetryHint('invalid_tool_call');
  const unknown = [...new Set(
    errors.filter(e => e?.type === 'unknown_tool').map(e => e.name).filter(Boolean)
  )];
  const badArguments = [...new Set(
    errors.filter(e => e?.type === 'invalid_arguments' || e?.type === 'schema_mismatch').map(e => e.name).filter(Boolean)
  )];
  const lines = [base];
  if (unknown.length && allowedToolNames?.length) {
    lines.push(
      `The tool name(s) ${unknown.join(', ')} do not exist.`,
      `Use ONLY these exact tool names: ${allowedToolNames.join(', ')}.`
    );
  }
  if (badArguments.length) {
    lines.push(`Your arguments for tool ${badArguments.join(', ')} were not a valid JSON object or missed required keys. Re-emit the call with a complete JSON object that matches the tool's input schema.`);
  }
  return lines.join('\n');
};

/**
 * 异步迭代上游 axios 流，按 SSE 段切分回调内部 delta JSON
 * @param {object} upstream - axios stream 响应
 * @param {(json: Object) => Promise<void>|void} onDelta - 单个 delta 回调
 * @param {{ shouldStop?: () => boolean }} [options] - 透传给 consumeSSEStream（提前终止谓词）
 * @returns {Promise<void>} 完成 Promise
 */
const consumeUpstream = async (upstream, onDelta, options) => consumeSSEStream(upstream, async (frame) => {
  const payload = frame.data;
  if (!payload || payload.trim() === '[DONE]') return;
  if (!isJson(payload)) return;
  const parsed = JSON.parse(payload);
  assertNoUpstreamFailure(parsed);
  await onDelta(parsed);
}, options);

/**
 * 原生 function_call 帧的喂入与关闭判定（流式 / 非流式共用）。完成证据读的是**原始**
 * delta：归一化器对 role:function 返回 null（Defect A，tests/agent-protocol.test.js:85-106
 * 钉住），不能从它那里拿。
 *
 * - 有 function_call：think phase 且无 function_id → 只记排放证据（onThinkEvidence），
 *   不喂累积器 —— 交给 thought_tool_call 重试，绝不晋升；其余 pushNativeSnapshot
 *   （分类在累积器里：无 function_id 且 answer phase 才是客户端候选）。
 * - role:function 且名字是客户端工具（与归一化器同一条谓词）→ closeByName：该调用的
 *   结果帧。无名帧与平台结果帧（code_interpreter 之类）惰性。
 * - answer 帧 status finished / 非空 finish_reason → 回合结束，打开中的按 round_end 关闭。
 * 每次可能关闭之后都排空一次 takeCompleted()（幂等），关闭即发射。
 * @param {Object} accumulator - createNativeToolCallAccumulator 实例
 * @param {Object} delta - 原始上游 delta
 * @param {*} reportedFinishReason - choice 上报的 finish_reason
 * @param {{ isClientToolName: (name: unknown) => boolean, onThinkEvidence: () => void, drain: () => void, phases: Map<string, string> }} hooks
 */
const feedNativeFrame = (accumulator, delta, reportedFinishReason, { isClientToolName, onThinkEvidence, drain, phases }) => {
  const rawPhase = delta.phase;
  if (Array.isArray(delta.tool_calls)) {
    accumulator.push(delta.tool_calls);
  } else if (delta.function_call) {
    if (!delta.function_id && isThinkPhase(rawPhase)) {
      onThinkEvidence();
    } else {
      if (typeof delta.function_call.name === 'string' && delta.function_call.name) {
        phases.set(delta.function_call.name, rawPhase);
      }
      accumulator.pushNativeSnapshot({
        name: delta.function_call.name,
        arguments: delta.function_call.arguments,
        phase: rawPhase,
        functionId: delta.function_id
      });
      drain();
    }
  } else if (delta.role === 'function' && isClientToolName(delta.name)) {
    if (accumulator.closeByName(delta.name)) drain();
  }
  const answerFinished = delta.role !== 'function' && ANSWER_PHASES.has(rawPhase) && delta.status === 'finished';
  if ((reportedFinishReason !== undefined && reportedFinishReason !== null) || answerFinished) {
    if (accumulator.closeOpen('round_end')) drain();
  }
};

/**
 * 正文恢复帧：归一化后是 answer、内容非空、原始 role ≠ function、原始 phase ∈ ANSWER_PHASES。
 * 它关闭打开中的调用，也是早停的触发帧（批次已齐时）。
 */
const isProseResume = (delta, normalized, rawPhase) =>
  !!normalized && normalized.phase === 'answer' && !!normalized.content &&
  delta.role !== 'function' && ANSWER_PHASES.has(rawPhase);

/**
 * 早停条件（D3）：本轮打开过的客户端调用全部被各自的具名结果帧关闭，且至少一个过闸。
 * 平台调用两侧都不计（batchState 只数客户端调用）。达不到就永不早停 —— 严格无回归，
 * 保护迟到的第三个并行调用。
 */
const nativeBatchComplete = (accumulator) => {
  const state = accumulator.batchState();
  return state.opened > 0 && state.opened === state.closedByResult && state.gated >= 1;
};

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

// SSE 保活间隔。上游长时间静默的两个来源：首轮 thinking，以及门禁拒绝后的补偿重试
// —— 后者要整段重新生成，客户端在此期间看不到任何内容。
// 延迟读取：本文件没有在模块作用域引入 config，顶层读取会在加载时抛错。
const pingIntervalMs = () => require('../config/index.js').anthropicPingIntervalMs;

/**
 * 在 work 执行期间按间隔发送 Anthropic `ping` 事件，避免客户端把流判为卡死。
 *
 * 必须用协议内的 `ping` 事件，不能用 SSE 注释（`: keepalive`）：注释的字节能重置
 * 反向代理的空闲计时器，但 SDK 会在读取行时直接丢弃以 `:` 开头的行，客户端因此
 * 什么都收不到。ccproxy 网桥当初正是靠改发真正的 ping 事件才消除同样的假死。
 *
 * 只能在 message_start 之后调用——此时响应头已提交，ping 是合法的流内事件。
 * @param {object} res - Express 响应
 * @param {Function} work - 被包裹的异步任务
 * @param {number} [intervalMs] - 发送间隔，缺省取 config.anthropicPingIntervalMs
 * @returns {Promise<*>} work 的返回值
 */
const runWithAnthropicPing = async (res, work, intervalMs) => {
  const everyMs = Math.max(1, Number(intervalMs) || pingIntervalMs());
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      writeAnthropicEvent(res, 'ping', { type: 'ping' });
      if (typeof res.flush === 'function') res.flush();
    } catch (_) {
      // 客户端断开由后续流消费/写入路径统一收敛。
    }
  }, everyMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
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
  const {
    message_id, model, hasTools, toolChoice, requestBody, allowedToolNames = [],
    toolSchemas = null, sendRequest = sendChatRequest, historyToolCalls = []
  } = ctx;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const createdAt = new Date().toISOString();

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
      created_at: createdAt,
      metadata: {},
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null
      }
    }
  });

  let blockIndex = -1;
  let textBlockOpen = false;
  let thinkingBlockOpen = false;
  let thinkingSignature = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let upstreamFinishReason = null;
  let upstreamCompleted;
  let upstreamEventCount;
  let visibleText = '';
  // 本轮 attempt 写到线上的正文。visibleText 是跨轮累计（它如实映照线上已发出的
  // 一切，供 empty 判定和"已见正文只许一次补偿"守卫使用）；但 malformed_protocol /
  // missing_tool 检查的是**这一轮**说了什么 —— 上一轮泄漏的残渣已经重试过了，
  // 拿累计文本判会把成功的重试轮再判一次死。
  let attemptVisibleText = '';
  // 本轮 attempt 的**原始**思考文本（不含注入的 searchTable）。think 内容照旧
  // verbatim 流给客户端（遏制是另案，见 deferred-work），但回合定案时要拿它过一遍
  // 共享解析器：实测 2026-08-31 ~14:08 模型把整个 [TOOL_CALL] 负载写进 think phase，
  // 然后在正文里叙述"已完成" —— 调用没执行、没进重试信号、没人看见。OpenAI 路径（A）
  // 早有这道防御（openai-agent-runtime.js:232-246）；这里把 B 拉到同一水位。
  let attemptThinkText = '';
  // 思维阶段的排放证据：think 文本过共享解析器后出现调用或解析错误，却没资格
  // 晋升（守卫见回合定案处）。decideRetryReason 据此点起一次性 thought_tool_call。
  let attemptThinkEvidence = false;

  // 每个 attempt 都必须拿到全新的解析器。旧代码只建一次，于是补偿重试会继承上一轮的
  // 错误列表（hasParseError 永远为真，即使重试本身成功），而一个被截断的 <tool_call>
  // 还会让 inToolCall 保持打开，把下一轮的正文灌进上一轮的缓冲区。
  // OpenAI 路径正是为此每轮新建（openai-agent-runtime.js 顶部注释）。
  let parser = null;
  let nativeToolAccumulator = null;
  // 本轮抢救回来的原文。按轮清空，且在回合定案之前绝不写到线上：
  // 提前写会让每一次重试都再吐一份同样的垃圾，而末尾的 error 事件又会把
  // 已经发出去的内容块全部作废。
  let recoveredBuffer = '';
  // salvage-3：tool_error-after-prose 的文本抑制重试。置位后 emitTextDelta /
  // emitThinkingDelta 只做检测记账（attemptVisibleText 照常累计 —— 它是
  // malformed_protocol 与 think 晋升守卫的输入），不写任何字节到线上；tool_use
  // 照常放行。由构造只可能在最后一轮为真：名额一次性，任何再拒绝都直接 break。
  let suppressAttemptOutput = false;
  // tool_use 之后的输出抑制：其后的文本/思考增量只做记账、不上线。两处置位 ——
  // 原生晋升（D2，drainPromotedNativeCalls：结果帧不到、早停 D3 点不起来时的保险带），
  // 以及文本通道的失控截断（cutTextChannelTurn：spec agent-turn-cutoff-text-channel 推翻了
  // "文本通道调用之后的正文照常交付"的老决定 —— 生产里那段正文就是失控的开头）。
  // 按轮复位（startAttempt），与 suppressAttemptOutput 互不干扰：那个由抑制重试跨轮持有
  // 到最后一轮。
  let suppressPostToolUseOutput = false;
  // 本轮跨通道去重登记簿；"已发射 tool_use"由 emitToolUse 自己置位，回合收尾不再重算。
  let admitToolCall = null;
  let hasEmittedToolCalls = false;
  // think phase 里的原生帧只是排放证据（thought_tool_call），永不晋升；早停谓词的状态；
  // 原生帧的 phase 按名字留档给晋升日志。三者按轮复位。
  let nativeThinkEvidence = false;
  let stopRequested = false;
  const nativePhases = new Map();
  const isClientToolName = createClientToolNamePredicate(allowedToolNames);
  // 文本通道失控守卫（规则与产生背景见 createTextChannelRunawayGuard）。按轮复位。
  let textRunaway = null;
  const maxToolCalls = resolveTextToolCallCap();
  // 抑制重试开跑前，attempt 侧的抢救缓冲先按登记位置剥掉残渣、存进银行：抑制
  // 只对**重试轮**的文本生效，attempt 侧原本要交付的 recovered 文本仍要交付
  // （无闭标记 span 的尾巴可能是真实回答，不能整桶倒掉 —— review loop 1，条目 10）。
  let bankedRecoveredText = '';
  // 剥离是否真的发生过（交付时的日志留痕用）。
  let recoveredResidueStripped = false;
  // 跨轮累计的被定罪原文（每轮 flush 后从解析器收取；条目为 {text, at, channel}）。
  // 空判据（hasToolProtocolError）跨轮消费 debris 类条目；recovered 通道的位置
  // 剥离只用**当轮**解析器的登记（坐标系跟着 recoveredBuffer 走）。
  const residueSpans = [];
  // 只剥 recovered 通道、并登记剥离是否发生。
  const stripRecoveredResidue = (buffer, spans) => {
    const out = stripToolCallResidue(buffer, spans, { channel: 'recovered' });
    if (out !== buffer) recoveredResidueStripped = true;
    return out;
  };
  let agentTagStripper = null;
  let normalizeDelta = null;
  let acceptUpstreamFrame = null;

  const startAttempt = () => {
    parser = hasTools ? createToolCallStreamParser({ allowedToolNames, toolSchemas }) : null;
    nativeToolAccumulator = hasTools
      ? createNativeToolCallAccumulator({ allowedToolNames, toolSchemas })
      : null;
    // buildToolSystemPrompt 让模型把最终答复包进 <agent_final>...</agent_final>，
    // 但本控制器没有 Agent 回合门禁去解包，标签会原样发给客户端。剥掉它们。
    agentTagStripper = createAgentTagStripper();
    recoveredBuffer = '';
    attemptVisibleText = '';
    attemptThinkText = '';
    attemptThinkEvidence = false;
    suppressPostToolUseOutput = false;
    // Sembrado con la historia: una llamada ya ejecutada se emite igual (releer tras un
    // edit es correcto) y solo deja un warn. La supresion sigue siendo por-attempt.
    admitToolCall = createToolCallLedger({ seed: historyToolCalls });
    hasEmittedToolCalls = false;
    nativeThinkEvidence = false;
    stopRequested = false;
    nativePhases.clear();
    textRunaway = parser
      ? createTextChannelRunawayGuard({ parser, maxToolCalls, label: 'Anthropic Agent', tag: 'ANTHROPIC' })
      : null;
    // clientToolNames：只有客户端声明过的工具名才算拦截证据（见 chat-helpers.js）——
    // 平台内部工具的丢弃帧不再触发假 intercepted 重试、不再烧协议恢复名额。
    normalizeDelta = createUpstreamDeltaNormalizer({ clientToolNames: allowedToolNames });
    acceptUpstreamFrame = createUpstreamResponseFilter();
    upstreamFinishReason = null;
  };

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
   * 关闭当前打开的思维块
   */
  const closeThinkingBlockIfOpen = () => {
    if (thinkingBlockOpen) {
      writeAnthropicEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'signature_delta', signature: thinkingSignature }
      });
      writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
      thinkingBlockOpen = false;
      thinkingSignature = null;
    }
  };

  /**
   * 输出一段思维增量；按需打开新思维块
   * @param {string} thinking - 思维增量
   */
  const emitThinkingDelta = (thinking) => {
    if (!thinking) return;
    // 文本抑制重试：思考增量一个字节都不上线（attemptThinkText 在 onUpstreamDelta
    // 已经记账，think 晋升与 thought_tool_call 证据不受影响）。tool_use 上线之后同理。
    if (suppressAttemptOutput || suppressPostToolUseOutput) return;
    if (!thinkingBlockOpen) {
      closeTextBlockIfOpen();
      blockIndex += 1;
      thinkingSignature = `qwen2api_${generateUUID().replace(/-/g, '')}`;
      writeAnthropicEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'thinking', thinking: '' }
      });
      thinkingBlockOpen = true;
    }
    writeAnthropicEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'thinking_delta', thinking }
    });
  };

  /**
   * 输出一段文本增量；按需打开新文本块
   * @param {string} text - 文本增量
   */
  const emitTextDelta = (text, { countsAsVisible = true } = {}) => {
    if (!text) return;
    // attemptVisibleText 是**检测输入**（malformed_protocol / missing_tool / think
    // 晋升守卫），被抑制的重试轮也要如实累计；visibleText 只映照真正写上线的字节。
    if (countsAsVisible) attemptVisibleText += text;
    if (suppressAttemptOutput || suppressPostToolUseOutput) return;
    if (countsAsVisible) visibleText += text;
    if (!textBlockOpen) {
      closeThinkingBlockIfOpen();
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
   * 输出一个完整的 tool_use 块（按 input_json_delta 切片）。跨通道副本在这里丢弃 ——
   * 这不是失控信号（失控的判定在文本通道循环里，见 createTextChannelRunawayGuard）；
   * 发射即置位 hasEmittedToolCalls。tool_use 之后的输出抑制不在这里：原生晋升
   * （drainPromotedNativeCalls）与文本通道截断（cutTextChannelTurn）各自置位。
   * @param {Object} call - 工具调用
   * @returns {boolean} 登记簿裁决：true = 已上线，false = 副本被丢弃
   */
  const emitToolUse = (call) => {
    if (!admitToolCall(call)) {
      logger.warn(
        `Anthropic Agent 本轮重复的工具调用（${call.function.name}，跨通道同名同参数），丢弃后到的副本`,
        'ANTHROPIC'
      );
      return false;
    }
    hasEmittedToolCalls = true;
    closeThinkingBlockIfOpen();
    closeTextBlockIfOpen();
    blockIndex += 1;
    writeAnthropicEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: toAnthropicToolUseId(call.id),
        name: call.function.name,
        input: {}
      }
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
    return true;
  };

  let completionContent = '';
  let webSearchInfo = null;
  let thinkingStarted = false;

  /**
   * 关闭即发射：排出累积器里已关闭、过闸、尚未发射的原生调用。幂等，每次可能关闭之后
   * 都调一次。每个晋升留一行来源日志（名字、phase、无 function_id —— 绝不打参数）。
   * 原生晋升之后本轮的文本/思考只记账不上线（平台"工具不存在"注入的回声）—— 在这里
   * 置位而不是 emitToolUse：文本通道的调用之后的正文照常交付。副本被登记簿丢弃时也
   * 置位：那份调用已经在线上（与非流式 promotedNativeCalls 的守卫一致）。
   */
  const drainPromotedNativeCalls = () => {
    for (const call of nativeToolAccumulator.takeCompleted()) {
      logger.warn(
        `Anthropic Agent 原生工具调用晋升为 tool_use：${call.function.name}（phase ${nativePhases.get(call.function.name) || 'answer'}，无 function_id）`,
        'ANTHROPIC'
      );
      // 早停的回合收不到上游尾部的 usage 帧，本地估算要吃到参数 JSON 才不至于 ~0。
      completionContent += call.function.arguments;
      suppressPostToolUseOutput = true;
      emitToolUse(call);
    }
  };

  /**
   * 文本通道的失控截断（原生早停的镜像）：终止上游、其后一切文本/思考只记账不上线，
   * 已放行的调用照常以 stop_reason=tool_use 收尾。告警由守卫留下（每次截断恰好一行）。
   * @param {string} rule - duplicate / rejected / prose / think / cap
   */
  const cutTextChannelTurn = (rule) => {
    stopRequested = true;
    suppressPostToolUseOutput = true;
    textRunaway.cut(rule);
  };

  /**
   * 处理一个上游 delta JSON
   * @param {Object} json - 上游 SSE delta
   */
  const onUpstreamDelta = async (json) => {
    // 丢弃其余候选回答的帧：上游多路并发会让内容重复
    if (!acceptUpstreamFrame(json)) return;
    if (json.usage) {
      promptTokens = json.usage.prompt_tokens || promptTokens;
      completionTokens = json.usage.completion_tokens || completionTokens;
    }
    if (!json.choices || json.choices.length === 0) return;
    const choice = json.choices[0];
    const reportedFinishReason = choice.finish_reason ?? choice.delta?.finish_reason;
    if (reportedFinishReason !== undefined && reportedFinishReason !== null) {
      upstreamFinishReason = reportedFinishReason;
    }
    const delta = choice.delta || {};
    const rawPhase = delta.phase;
    if (nativeToolAccumulator) {
      feedNativeFrame(nativeToolAccumulator, delta, reportedFinishReason, {
        isClientToolName,
        onThinkEvidence: () => { nativeThinkEvidence = true; },
        drain: drainPromotedNativeCalls,
        phases: nativePhases
      });
    }
    if (delta && delta.name === 'web_search') {
      webSearchInfo = delta.extra?.web_search_info;
    }
    const normalized = normalizeDelta(delta);
    if (!normalized) return;
    if (nativeToolAccumulator && isProseResume(delta, normalized, rawPhase)) {
      // 正文恢复关闭打开中的调用（过闸的随即发射）。
      if (nativeToolAccumulator.closeOpen('boundary')) drainPromotedNativeCalls();
    }
    // 批次已齐 —— 每个客户端调用都被自己的结果帧关闭且至少一个过闸 —— 之后模型产出的
    // 第一帧内容（思考**或**正文）就是"工具不存在"叙述的开头：提前终止上游，内容丢弃。
    // 不能只等正文：生产里（2026-09-01 18:05）模型被拦截后先又思考了 54s 才开口，
    // tool_use 早已在线上，等正文等于让客户端白等这 54s。批次不齐则永不早停，照旧
    // 消费到底（保护迟到的并行调用 —— 它以 function_call 帧到达，没有内容，不会触发这里）。
    if (nativeToolAccumulator && delta.role !== 'function' && normalized.content &&
        nativeBatchComplete(nativeToolAccumulator)) {
      stopRequested = true;
      logger.warn('Anthropic Agent 原生工具批次已晋升，提前终止上游（用量按本地估算）', 'ANTHROPIC');
      return;
    }
    delta.phase = normalized.phase;
    let content = normalized.content;
    completionContent += content;

    if (delta.phase === 'think') {
      // 文本通道调用之后的思考是失控的开头（规则 c）：截断，这一帧一个字节都不上线。
      const thinkRule = textRunaway?.inspectThink(content);
      if (thinkRule) {
        cutTextChannelTurn(thinkRule);
        return;
      }
      // 武装之后纯空白的思考也不上线（inspectThink 对空白不触发）：放行会在 tool_use
      // 块之后另开一个空的 thinking 块。
      if (textRunaway?.armed()) return;
      if (!thinkingStarted) {
        thinkingStarted = true;
        if (webSearchInfo) {
          const config = require('../config/index.js');
          try {
            const searchTable = await accountManager.generateMarkdownTable(webSearchInfo, config.searchInfoMode);
            emitThinkingDelta(searchTable + '\n\n');
          } catch (_) {}
        }
      }
      // 只累计模型自己的思考文本 —— 注入的 searchTable 不是模型输出，不能污染
      // 回合定案时的 think 解析。
      attemptThinkText += content;
      emitThinkingDelta(content);
    } else if (delta.phase === 'answer') {
      if (parser) {
        const parsed = parser.push(content);
        const text = agentTagStripper.push(parsed.textDelta);
        // 规则 (b)/(c)：被拒绝的调用 / 非空白正文。触发时这一 push 的正文与抢救文本都不
        // 上线；同一 push 里已登记完成的调用仍照常发射（下面的循环）。
        const pushRule = textRunaway.inspectPush(parsed, text);
        if (pushRule) {
          cutTextChannelTurn(pushRule);
        } else {
          if (text) emitTextDelta(text);
          recoveredBuffer += parsed.recoveredText;
        }
        // 规则 (a)/(d)：文本通道的重复调用 / 第 N 个调用。到 cap 的那个照常交付，之后立刻停手。
        for (const call of parsed.completedCalls) {
          const callRule = textRunaway.inspectCall(call, emitToolUse);
          if (!callRule) continue;
          cutTextChannelTurn(callRule);
          if (callRule === 'cap') break;
        }
        textRunaway.endPush();
      } else {
        emitTextDelta(agentTagStripper.push(content));
      }
    }
  };

  const terminalFinish = () =>
    ['length', 'max_tokens', 'content_filter', 'refusal'].includes(upstreamFinishReason);

  const currentToolErrors = () => [
    ...(parser?.getErrors() || []),
    ...(nativeToolAccumulator?.getErrors() || [])
  ];

  /**
   * 判断本轮是否需要重试；返回 null 表示接受本轮。
   * 只在 flush 之后调用：flush 会结算挂起的工具调用，此后 hasPendingCall() 恒为假。
   */
  const decideRetryReason = (emittedCalls) => {
    if (emittedCalls) return null;
    if (parser && requiresToolCall(toolChoice)) return 'required';
    // 以前任何一个工具错误都会让全部补偿失效并直接 502。可是被编造的工具名恰恰是
    // 最容易纠正的错误：把允许的名字摆在模型面前即可。终止性 finish 下**原生来源**
    // 的错误不点火：被 length 截断的快照是 truncated_native_call，不发射也不重试
    // （文本来源保持今天的行为）。
    const retryableToolErrors = terminalFinish() ? (parser?.getErrors() || []) : currentToolErrors();
    if (retryableToolErrors.length > 0) return 'tool_error';
    // 平台把模型的原生工具调用吃掉时，我们收到的只剩 role:function 丢弃帧和一段
    // 叙述失败的散文。丢弃帧就是拦截的现场证据：有丢弃、零工具调用、且本请求
    // 确实带工具 → 值得用规范标记提示模型重发一次。终止性 finish（length/
    // content_filter/refusal）与 missing_tool/empty 同一纪律：不重试。
    if (hasTools && normalizeDelta.interceptedToolNames.length > 0 && !terminalFinish()) {
      return 'intercepted';
    }
    // 同族防御：模型把方括号协议写坏，解析器的抢救闸门也没收下（未知名字 / 缺
    // 闭标记 / 非法 JSON），残渣按正文泄漏。只是重试信号。intercepted 在前——
    // 丢弃帧是更强的证据。判**本轮**文本，不判累计：上一轮的残渣已经重试过了。
    if (hasTools && containsOrphanProtocolResidue(attemptVisibleText) && !terminalFinish()) {
      return 'malformed_protocol';
    }
    // 同族第三形态：调用（或其残骸）泄漏在 think phase 里，晋升守卫没放行。
    // 排在 missing_tool 之前 —— think 里的排放证据比正文措辞的启发式更硬。
    // 泄漏的调用永远不从这里执行，这只是重试信号。
    if (hasTools && attemptThinkEvidence && !terminalFinish()) {
      return 'thought_tool_call';
    }
    if (hasTools && looksLikeUnexecutedToolAction(attemptVisibleText) && !terminalFinish()) {
      return 'missing_tool';
    }
    if (!visibleText.trim() && !terminalFinish()) return 'empty';
    return null;
  };

  const retryHintFor = (reason) => {
    let hint;
    if (reason === 'required') hint = buildRetryHint(toolChoice);
    else if (reason === 'missing_tool') hint = buildMissingToolRetryHint();
    else if (reason === 'empty') hint = buildEmptyOutputRetryHint();
    else if (reason === 'intercepted') hint = buildAgentRetryHint('intercepted');
    else if (reason === 'malformed_protocol') hint = buildAgentRetryHint('malformed_protocol');
    else if (reason === 'thought_tool_call') hint = buildAgentRetryHint('thought_tool_call');
    else hint = buildToolErrorRetryHint(currentToolErrors(), allowedToolNames);
    // required / missing_tool 优先级高于 intercepted，会把拦截藏在自己后面。
    // 不动优先级、不动上限——只让提示词把关键事实带上：调用没到客户端。
    if ((reason === 'required' || reason === 'missing_tool') &&
        normalizeDelta.interceptedToolNames.length > 0) {
      hint = `${hint}\n${buildAgentRetryHint('intercepted')}`;
    }
    // 同一个模式的 think 版本：required / tool_error 盖住 thought_tool_call 时，
    // 提示词仍要带上关键事实 —— 调用写在了模型自己够不到的隐藏推理里。
    // （missing_tool / empty 排在 thought_tool_call 之后，证据在时轮不到它们。）
    if ((reason === 'required' || reason === 'tool_error') && attemptThinkEvidence) {
      hint = `${hint}\n${buildAgentRetryHint('thought_tool_call')}`;
    }
    return hint;
  };

  const config = require('../config/index.js');
  const maxAttempts = Math.max(1, Number(config.agentTurnMaxAttempts) || 1);

  let currentUpstream = upstream;
  let attemptsMade = 0;
  let retriedAfterVisibleText = false;
  let protocolRecoveryRetried = false;

  for (;;) {
    attemptsMade += 1;
    startAttempt();

    try {
      const result = await runWithAnthropicPing(
        res,
        () => consumeUpstream(currentUpstream, onUpstreamDelta, { shouldStop: () => stopRequested })
      );
      upstreamCompleted = result.completed;
      upstreamEventCount = result.eventCount;
    } catch (e) {
      logger.error('Anthropic 流式心跳包装失败', 'ANTHROPIC', '', e);
      throw e;
    }

    // 本轮收尾。解析器的尾巴属于这一轮，必须在判定之前放出来。文本通道截断之后例外：
    // 根本不 flush —— 解析器里压着的只是失控那一 push 的残余（半个触发器 / 半截负载），
    // flush 会把它定罪成 truncated_tool_call，那是截断自己造成的假错误，不该进日志与
    // finalToolErrors；抢救文本与迟到的调用同样不交付。
    if (parser) {
      if (!textRunaway.cutRule()) {
        const tail = parser.flush();
        if (tail.textDelta) emitTextDelta(agentTagStripper.push(tail.textDelta));
        recoveredBuffer += tail.recoveredText;
        for (const call of tail.completedCalls) emitToolUse(call);
      }
      // 收取本轮被定罪的原文（flush 之后登记簿已完整），跨轮累计给交付层剥残渣。
      residueSpans.push(...parser.getResidueSpans());
    }
    // 缓冲区里可能压着一个最终没能凑成标签的前缀，它是正文，必须放出来。
    emitTextDelta(agentTagStripper.flush());

    if (nativeToolAccumulator) {
      // 回合结束（EOF / [DONE] / 早停）：打开中的原生调用按 round_end 关闭并排出（截断的
      // 记 truncated_native_call，不发射）；然后 finalize() 单发结算 OpenAI 形状的
      // tool_calls —— 原生的已经排空，不会再出来第二次。
      nativeToolAccumulator.closeOpen('round_end');
      drainPromotedNativeCalls();
      for (const call of nativeToolAccumulator.finalize()) emitToolUse(call);
    }

    // think phase 的回合定案：正文侧一无所获时，把本轮思考文本过一遍共享解析器。
    // 晋升守卫 = A 的守卫（openai-agent-runtime.js:232-243：正文零调用且正文文本为空
    // 才解析 think；think 有调用、think cleanedText 为空、think 零解析错误才晋升）
    // **外加两条这里更严的本地守卫** —— A 没有它们，B/C 刻意收紧：
    //   1) 必须有非空白名单（无白名单时共享解析器的名字闸门放行一切 —— fail closed，
    //      不晋升）；
    //   2) 正文侧零工具错误（A 靠 evaluate 先按 toolErrors 拒绝整轮达到同一效果，
    //      B 的晋升发生在 decideRetryReason 之前，必须自己带上这条）。
    // 终止性 finish（length/content_filter/refusal）既不晋升也不重试 —— 与
    // intercepted/missing_tool/empty 同一纪律。这不是新的安全边界：A 自兼容工作以来
    // 一直在做同一个晋升。守卫不满足但 think 里确实出现了调用（或其解析残骸）时，
    // 那是排放证据 —— 交给 thought_tool_call 重试。
    if (hasTools && !hasEmittedToolCalls) {
      // 刻意不传 toolSchemas：think 通道里抢救永远不点火（晋升守卫逐字节保持
      // 今天的行为；泄漏进 think 的坏调用照旧走 thought_tool_call 重试）。
      const thinkParsed = parseToolCallsFromText(attemptThinkText, { allowedToolNames });
      const promotable = allowedToolNames.length > 0 &&
        thinkParsed.toolCalls.length > 0 &&
        thinkParsed.errors.length === 0 &&
        !thinkParsed.cleanedText.trim() &&
        !attemptVisibleText.trim() &&
        currentToolErrors().length === 0 &&
        !terminalFinish();
      if (promotable) {
        for (const call of thinkParsed.toolCalls) emitToolUse(call);
      } else {
        // think phase 里的原生 function_call 帧（无 function_id）同样是排放证据。
        attemptThinkEvidence = nativeThinkEvidence || thinkParsed.toolCalls.length > 0 || thinkParsed.errors.length > 0;
      }
    }

    const retryReason = decideRetryReason(hasEmittedToolCalls);
    if (!retryReason) break;
    if (attemptsMade >= maxAttempts) {
      // 以前这里静默 break：生产环境分不清"回合被接受"和"次数用尽"。措辞保持中立：
      // 接下来可能按原样交付，也可能收敛成 invalid_tool_call_error / api_error（
      // required 未兑现、纯工具错误无正文），这里不预判结局。
      logger.warn(
        `Anthropic Agent 尝试次数用尽（${attemptsMade}/${maxAttempts}），最后一轮仍被拒绝 (${retryReason})`,
        'ANTHROPIC'
      );
      break;
    }

    // 协议恢复重试（intercepted / malformed_protocol / thought_tool_call 共享同一个
    // 名额）整个请求只允许一次：第二次说明提示没被采纳，继续循环只会把更多叙述
    // 散文拼进客户端的流。原样交付比死循环好。三个理由绝不能叠成多次额外重试。
    // 注意这个上限独立于下面的已见正文守卫 —— 无叙述的拦截（零可见正文）也必须
    // 停在一次。放弃时必须留日志：生产环境要能区分"提示被采纳、回合恢复"和
    // "第二次、原样交付"。
    const isProtocolRecovery = retryReason === 'intercepted' ||
      retryReason === 'malformed_protocol' ||
      retryReason === 'thought_tool_call';
    if (isProtocolRecovery && protocolRecoveryRetried) {
      const giveUpDrops = normalizeDelta.interceptedToolNames.length > 0
        ? ` (dropped: ${normalizeDelta.interceptedToolNames.join(', ')})`
        : '';
      logger.warn(
        `Anthropic Agent 协议恢复重试已用完，第二次 ${retryReason} 按原样交付${giveUpDrops}`,
        'ANTHROPIC'
      );
      break;
    }

    // 本控制器是边收边发的：正文一产生就写进客户端的流（OpenAI 路径把裸正文扣在门禁
    // 内，所以它可以随便重试）。因此一旦写过正文，再重试就会把两段输出拼在一起。
    //
    // 已经写过正文时只允许一次补偿 —— 这正是改动之前的行为，required 和 missing_tool
    // 都依赖它。还没写过正文时才放开到 maxAttempts，而上报的故障恰好是这种形状：
    // 一轮纯 <tool_call> 且工具名无效不产生任何可见正文，所以 6 次尝试都够得着。
    if (visibleText.trim()) {
      // intercepted / malformed_protocol 消费的正是这一次"已见正文后的补偿"名额：
      // 叙述（或泄漏的协议残渣）已经流出去了，但迟到的 tool_use 仍然胜过一个
      // 死掉的会话。required / missing_tool 不受影响。
      //
      // 已知局限（有测试钉住）：如果这个名额先被别的理由（如 missing_tool）用掉，
      // 之后一轮带叙述的拦截就无法重试 —— 按原样交付收场。
      // thought_tool_call 消费的同样是这一次"已见正文后的补偿"名额：叙述已经流出
      // 去了，但迟到的 tool_use 仍然胜过一个死掉的会话（与 intercepted 同一条道理）。
      if (retriedAfterVisibleText) {
        if (retryReason === 'tool_error') {
          // 以前这里静默 break：生产环境看不见"本轮是垃圾、按原样交付"的定案。
          logger.warn(
            `Anthropic Agent 已见正文后再次 tool_error，补偿名额已用，按原样交付 (${describeToolErrors(currentToolErrors())})`,
            'ANTHROPIC'
          );
        }
        break;
      }
      retriedAfterVisibleText = true;
      // salvage-3：tool_error-after-prose 不再硬断 —— 消费同一个补偿名额做**文本
      // 抑制**重试：重试轮只放行 tool_use 块（文本/思考被 suppressAttemptOutput
      // 拦在 emit 层，检测记账照旧），失败就按今天交付。绝不新增名额；模型复述
      // 协议的老毛病（回显字面标签必然解析失败）因此不会把第二轮垃圾拼上线 ——
      // 垃圾轮的文本根本不上线。
      if (retryReason === 'tool_error') {
        suppressAttemptOutput = true;
        // attempt 侧的 recovered 文本进银行（剥掉登记残渣后），交付段仍会交付它。
        bankedRecoveredText += stripRecoveredResidue(recoveredBuffer, parser ? parser.getResidueSpans() : []);
        logger.warn(
          `Anthropic Agent 已见正文后本轮 tool_error，消耗补偿名额做文本抑制重试 (${describeToolErrors(currentToolErrors())})`,
          'ANTHROPIC'
        );
      }
    }
    if (isProtocolRecovery) protocolRecoveryRetried = true;

    // 有丢弃帧时任何拒绝理由都带上名字：required/tool_error 优先级更高时拦截会被
    // 盖住，但生产环境里这行紧跟着一串 UPSTREAM_NORMALIZER 丢弃日志出现，是验证
    // 拦截确实发生的唯一抓手。
    const rejectionDetail = normalizeDelta.interceptedToolNames.length > 0
      ? `${retryReason}; dropped: ${normalizeDelta.interceptedToolNames.join(', ')}`
      : retryReason;
    logger.warn(
      `Anthropic Agent attempt ${attemptsMade}/${maxAttempts} 被拒绝 (${rejectionDetail})`,
      'ANTHROPIC'
    );

    let retryResp = null;
    try {
      await runWithAnthropicPing(res, async () => {
        retryResp = await sendRequest(appendRetryHint(requestBody, retryHintFor(retryReason)));
      });
    } catch (e) {
      logger.error('Anthropic 流式重试失败', 'ANTHROPIC', '', e);
      if (e.publicMessage) throw e;
      break;
    }
    if (!retryResp?.status || !retryResp.response) break;
    currentUpstream = retryResp.response;
  }

  // 循环已定案：抑制旗标只约束重试轮的流内发射；交付段（银行里的 attempt 侧
  // 文本）不受它约束。
  const suppressedFinalAttempt = suppressAttemptOutput;
  suppressAttemptOutput = false;
  suppressPostToolUseOutput = false;

  // 空判据（hasToolProtocolError）用：visibleText 减去 **debris 类**残渣。debris
  // 走 textDelta 通道且跨轮累计，位置在 agent-tag 剥离与跨轮拼接后不再可用 ——
  // 但空判据是布尔题，按登记原文整段减去一次即可（同字节的副本删错不改变判空）。
  // 两侧同一规范化：span 原文先过 stripAgentTags 再比对（visibleText 本身已剥过
  // tag —— review loop 1，条目 6）。被闸门拒绝的合成负载从不进登记簿（它可能
  // 就是回答本身），因此永远不会被这里判空成 502（条目 8）。
  const subtractDebrisResidue = (text, spans) => {
    let out = text;
    for (const span of spans) {
      if (!span || span.channel !== 'text' || typeof span.text !== 'string' || !span.text) continue;
      const needle = stripAgentTags(span.text);
      if (!needle) continue;
      const at = out.indexOf(needle);
      if (at !== -1) out = out.slice(0, at) + out.slice(at + needle.length);
    }
    return out;
  };

  const finalToolErrors = currentToolErrors();
  // 有真正的正文时，工具错误不再升级成 502：客户端已经收到了一段回答，再补一个
  // error 事件只会让整条消息作废。判据是**正文**，不含抢救回来的原文 —— 一轮里除了
  // 一个残缺的 <tool_call> 什么都没有时，把裸 XML 当成回答交出去比明说失败更糟。
  //
  // salvage-3 的两处收紧：
  // - 空判据看**剥掉 debris 后的**正文 —— 纯残渣回合不算"已有回答"，照旧 502；
  //   绝不交付一条内容只有协议残渣的消息。
  // - required 未兑现但真实正文已经流出去时，按 end_turn 收尾 + warn，而不是 502：
  //   半条已交付的消息 + error 事件比一个没兑现的 required 更糟。
  const strippedVisibleText = subtractDebrisResidue(visibleText, residueSpans);
  const hasToolProtocolError = !!(
    !hasEmittedToolCalls &&
    !strippedVisibleText.trim() &&
    (requiresToolCall(toolChoice) || finalToolErrors.length > 0)
  );

  if (!hasToolProtocolError && !hasEmittedToolCalls && requiresToolCall(toolChoice)) {
    logger.warn(
      'Anthropic Agent tool_choice=required 未兑现，但正文已流出线上 — 按 end_turn 收尾而非 502',
      'ANTHROPIC'
    );
  }

  // 交付层剥残渣（layer 3）：recovered 文本剥掉**当轮登记**的 span（位置坐标系
  // 跟着 recoveredBuffer 走）后，剩什么交付什么 —— 无闭标记 span 的尾巴可能是
  // 真实回答。银行里躺着抑制重试之前 attempt 侧已剥好的文本；抑制的重试轮自己
  // 的 recovered 文本不交付（只有它的 tool_use 已经上线）。先剥残渣再剥 agent
  // tag（与 C 同序 —— 登记的是解析器原始字节）。剥离只发生在这里 —— 检测输入
  // （attemptVisibleText / cleanedText）从未被碰过。
  const finalRecoveredText = suppressedFinalAttempt
    ? bankedRecoveredText
    : bankedRecoveredText + stripRecoveredResidue(recoveredBuffer, parser ? parser.getResidueSpans() : []);
  if (!hasToolProtocolError && finalRecoveredText) {
    const residueFree = stripAgentTags(finalRecoveredText);
    if (residueFree.trim()) emitTextDelta(residueFree, { countsAsVisible: false });
  }
  if (!hasToolProtocolError && recoveredResidueStripped) {
    // Ask-first 决议：静默剥离，只在日志留痕，不注入任何替代文本。
    logger.warn('Anthropic Agent 交付前按登记位置剥离协议残渣（recoveredBuffer），零协议字节上线', 'ANTHROPIC');
  }
  if (!hasToolProtocolError && finalToolErrors.length > 0) {
    // logger 上只有 warn，没有 warning —— 旧的 logger.warning?.() 是静默空操作。
    logger.warn(
      `Anthropic Agent 工具协议出错但已产出内容，按正常回答返回 (${describeToolErrors(finalToolErrors)})`,
      'ANTHROPIC'
    );
  }

  if (hasToolProtocolError) {
    // 这个细节以前存在于 getErrors() 里却被丢掉，于是三种截然不同的原因
    // （非法 JSON / 未知工具名 / 被截断）挤进同一句不透明的报错，而 unknown_tool
    // 连一行日志都不留。诊断只能靠读源码。
    const detail = finalToolErrors.length
      ? describeToolErrors(finalToolErrors)
      : 'tool_choice=required 未触发任何工具调用';
    logger.warn(
      `Anthropic Agent 工具协议失败，${attemptsMade}/${maxAttempts} 次尝试后放弃 (${detail})`,
      'ANTHROPIC'
    );
    closeThinkingBlockIfOpen();
    closeTextBlockIfOpen();
    writeAnthropicError(
      res,
      attemptsMade > 1
        ? `上游连续 ${attemptsMade} 次返回了残缺、非法或不存在的工具调用 (${detail})`
        : `上游返回了残缺、非法或不存在的工具调用 (${detail})`,
      'invalid_tool_call_error'
    );
    return;
  }

  if (!visibleText.trim() && !hasEmittedToolCalls &&
      !['length', 'max_tokens', 'content_filter', 'refusal'].includes(upstreamFinishReason)) {
    closeThinkingBlockIfOpen();
    closeTextBlockIfOpen();
    writeAnthropicError(res, '上游重试后仍未返回正文或工具调用', 'api_error');
    return;
  }

  closeThinkingBlockIfOpen();
  closeTextBlockIfOpen();

  const stopReason = mapAnthropicStopReason(
    upstreamFinishReason,
    hasEmittedToolCalls,
    upstreamCompleted
  );
  if (!stopReason) {
    const detail = upstreamEventCount === 0 ? '上游未返回任何 SSE 事件' : '上游流在结束标记前断开';
    writeAnthropicError(res, detail, 'api_error');
    return;
  }

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
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null
    }
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
  const {
    message_id, model, hasTools, toolChoice, requestBody, allowedToolNames = [],
    toolSchemas = null, sendRequest = sendChatRequest, historyToolCalls = []
  } = ctx;

  let thinkingContent = '';
  // 本轮 attempt 的原始思考文本。thinkingContent 跨轮累计、原样进响应的 thinking
  // 块（既有语义不动）；回合**判定**（晋升 / thought_tool_call 证据）只看这一轮 ——
  // 与流式分支同一条纪律，上一轮的泄漏已经重试过了。
  let attemptThinkingContent = '';
  let answerContent = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let webSearchInfo = null;
  let upstreamFinishReason = null;
  let upstreamCompleted;
  let upstreamEventCount;
  let nativeToolAccumulator = hasTools
    ? createNativeToolCallAccumulator({ allowedToolNames, toolSchemas })
    : null;
  // clientToolNames：与流式分支同一条规则 —— 平台内部工具的丢弃帧不算拦截证据。
  const normalizeDelta = createUpstreamDeltaNormalizer({ clientToolNames: allowedToolNames });
  const acceptUpstreamFrame = createUpstreamResponseFilter();
  const isClientToolName = createClientToolNamePredicate(allowedToolNames);
  // 本轮关闭即晋升的原生调用：非流式没有线可写，先攒着，回合定案时与文本解析器的调用
  // 过同一本登记簿去重。think phase 的原生帧只留排放证据；早停谓词；phase 留档。按轮复位。
  let promotedNativeCalls = [];
  let nativeThinkEvidence = false;
  let stopRequested = false;
  const nativePhases = new Map();
  const drainPromotedNativeCalls = () => {
    for (const call of nativeToolAccumulator.takeCompleted()) {
      logger.warn(
        `Anthropic 非流式 Agent 原生工具调用晋升为 tool_use：${call.function.name}（phase ${nativePhases.get(call.function.name) || 'answer'}，无 function_id）`,
        'ANTHROPIC'
      );
      promotedNativeCalls.push(call);
    }
  };
  // 文本通道失控守卫 —— 流式分支的孪生（规则见 createTextChannelRunawayGuard）。非流式
  // 没有线可写，回合定案前用一个边收边解析的解析器只做**检测**；截断的轮子以它已放行
  // 的正文与调用为本轮结果（answerContent 在截断点结束：触发的那一 push 不累计），不再对
  // 截断的原文整段重解析 —— 跨 push 的半截调用会被判成 truncated_tool_call、触发器按
  // 正文泄漏、到 cap 的那个调用丢失，与流式分支交付的内容对不上。按轮复位。
  // 沿袭的不对称（刻意不动）：原生晋升之后 `promotedNativeCalls.length > 0` 在守卫之前
  // 就 return，此后的 delta 守卫看不见；流式分支则继续喂解析器。
  const maxToolCalls = resolveTextToolCallCap();
  let textParser = null;
  let textTagStripper = null;
  let textRunaway = null;
  // 已放行的**原始** textDelta（未剥 agent 标签）：解析器 text 通道的登记落点就是它的
  // 累计长度，交付层按位置剥残渣要同一坐标系；标签在交付点才剥（与未截断轮同序）。
  let streamedRawText = '';
  let streamedCalls = [];
  // 搜索表前缀（回合定案时才知道）：拼在原文之前，登记落点整体后移。
  let streamedPrefix = '';
  const startTextRound = () => {
    textParser = hasTools ? createToolCallStreamParser({ allowedToolNames, toolSchemas }) : null;
    textTagStripper = createAgentTagStripper();
    textRunaway = textParser
      ? createTextChannelRunawayGuard({ parser: textParser, maxToolCalls, label: 'Anthropic 非流式 Agent', tag: 'ANTHROPIC' })
      : null;
    streamedRawText = '';
    streamedCalls = [];
    streamedPrefix = '';
  };
  startTextRound();
  const collectTextCall = (call) => {
    streamedCalls.push(call);
    return true;
  };
  const cutTextChannelTurn = (rule) => {
    stopRequested = true;
    textRunaway.cut(rule);
  };
  /**
   * 截断轮的结算：流式解析器已放行的原文与调用（形状同 parseToolCallsFromText）。只有
   * text 通道的登记落在 streamedRawText 的坐标系里（recovered 通道非流式从不交付），
   * 交付层照旧按位置剥残渣、再剥 agent 标签 —— 截断轮与未截断轮走同一条交付路径。
   */
  const settledStreamedRound = () => ({
    cleanedText: streamedPrefix + streamedRawText,
    toolCalls: streamedCalls,
    errors: textParser.getErrors(),
    residueSpans: textParser.getResidueSpans()
      .filter(span => span.channel === 'text')
      .map(span => ({ ...span, at: span.at + streamedPrefix.length }))
  });

  /**
   * 处理一个上游 delta JSON
   * @param {Object} json - 上游 SSE delta
   */
  const onUpstreamDelta = async (json) => {
    // 丢弃其余候选回答的帧：上游多路并发会让内容重复
    if (!acceptUpstreamFrame(json)) return;
    if (json.usage) {
      promptTokens = json.usage.prompt_tokens || promptTokens;
      completionTokens = json.usage.completion_tokens || completionTokens;
    }
    if (!json.choices || json.choices.length === 0) return;
    const choice = json.choices[0];
    const reportedFinishReason = choice.finish_reason ?? choice.delta?.finish_reason;
    if (reportedFinishReason !== undefined && reportedFinishReason !== null) {
      upstreamFinishReason = reportedFinishReason;
    }
    const delta = choice.delta || {};
    const rawPhase = delta.phase;
    if (nativeToolAccumulator) {
      feedNativeFrame(nativeToolAccumulator, delta, reportedFinishReason, {
        isClientToolName,
        onThinkEvidence: () => { nativeThinkEvidence = true; },
        drain: drainPromotedNativeCalls,
        phases: nativePhases
      });
    }
    if (delta && delta.name === 'web_search') {
      webSearchInfo = delta.extra?.web_search_info;
    }
    const normalized = normalizeDelta(delta);
    if (!normalized) return;
    if (nativeToolAccumulator && isProseResume(delta, normalized, rawPhase)) {
      // 与流式分支同一条：正文恢复关闭打开中的调用。
      if (nativeToolAccumulator.closeOpen('boundary')) drainPromotedNativeCalls();
    }
    // 与流式分支同一条：批次已齐后第一帧内容（思考或正文）即叙述开头，提前终止上游。
    if (nativeToolAccumulator && delta.role !== 'function' && normalized.content &&
        nativeBatchComplete(nativeToolAccumulator)) {
      stopRequested = true;
      logger.warn('Anthropic 非流式 Agent 原生工具批次已晋升，提前终止上游（用量按本地估算）', 'ANTHROPIC');
      return;
    }
    // 晋升之后的叙述（"工具不可用"）不进交付文本 —— 流式分支 tool_use 后抑制的孪生。
    if (promotedNativeCalls.length > 0) return;
    delta.phase = normalized.phase;
    const content = normalized.content;
    if (delta.phase === 'think') {
      // 与流式分支同一条：文本通道调用之后的思考是失控的开头，截断，这一帧不累计。
      const thinkRule = textRunaway?.inspectThink(content);
      if (thinkRule) {
        cutTextChannelTurn(thinkRule);
        return;
      }
      // 与流式分支同一条：武装之后纯空白的思考不累计。
      if (textRunaway?.armed()) return;
      thinkingContent += content;
      attemptThinkingContent += content;
    } else if (delta.phase === 'answer') {
      if (textParser) {
        const parsed = textParser.push(content);
        const text = textTagStripper.push(parsed.textDelta);
        // 规则 (b)/(c)：触发时这一 push 的正文不进结果；同一 push 里已登记完成的调用仍收下。
        const pushRule = textRunaway.inspectPush(parsed, text);
        if (pushRule) cutTextChannelTurn(pushRule);
        else streamedRawText += parsed.textDelta;
        // 规则 (a)/(d)：到 cap 的那个照常收下，之后立刻停手。
        for (const call of parsed.completedCalls) {
          const callRule = textRunaway.inspectCall(call, collectTextCall);
          if (!callRule) continue;
          cutTextChannelTurn(callRule);
          if (callRule === 'cap') break;
        }
        textRunaway.endPush();
        // 截断：触发的那一 push 不累计 —— answerContent 在截断点结束。
        if (textRunaway.cutRule()) return;
      }
      answerContent += content;
    }
  };

  const initialStreamResult = await consumeUpstream(upstream, onUpstreamDelta, { shouldStop: () => stopRequested });
  upstreamCompleted = initialStreamResult.completed;
  upstreamEventCount = initialStreamResult.eventCount;

  if (!upstreamCompleted && !upstreamFinishReason) {
    const detail = upstreamEventCount === 0 ? '上游未返回任何 SSE 事件' : '上游流在结束标记前断开';
    return res.status(502).json({
      type: 'error',
      error: { type: 'api_error', message: detail }
    });
  }

  if (webSearchInfo) {
    const config = require('../config/index.js');
    try {
      const searchTable = await accountManager.generateMarkdownTable(webSearchInfo, config.searchInfoMode);
      if (thinkingContent) {
        thinkingContent = searchTable + '\n\n' + thinkingContent;
      } else {
        answerContent = searchTable + '\n\n' + answerContent;
        streamedPrefix = searchTable + '\n\n';
      }
    } catch (_) {}
  }

  // 文本通道截断的轮子以流式解析器的结果定案；其余照今天整段重解析。
  let parsedTools = textRunaway?.cutRule()
    ? settledStreamedRound()
    : (hasTools
      ? parseToolCallsFromText(answerContent, { allowedToolNames, toolSchemas })
      : { cleanedText: answerContent, toolCalls: [], errors: [], residueSpans: [] });
  let cleanedText = stripAgentTags(parsedTools.cleanedText);
  // 回合结束：打开中的原生调用按 round_end 关闭并排出，再 finalize() 单发结算 OpenAI
  // 形状的 tool_calls（原生的已排空，不会出来第二次）。
  const settleNativeCalls = () => {
    if (!nativeToolAccumulator) return [];
    nativeToolAccumulator.closeOpen('round_end');
    drainPromotedNativeCalls();
    return [...promotedNativeCalls, ...nativeToolAccumulator.finalize()];
  };
  // 跨通道去重登记簿替代原来的 concat：同名同参数只留先到的（原生在前 —— 它先关闭）。
  const mergeToolCalls = (native, parsed) => {
    // Misma semilla que la rama de streaming: informa, no suprime.
    const admit = createToolCallLedger({ seed: historyToolCalls });
    return [...native, ...parsed]
      .filter(call => {
        if (admit(call)) return true;
        logger.warn(
          `Anthropic 非流式 Agent 本轮重复的工具调用（${call.function.name}，跨通道同名同参数），丢弃后到的副本`,
          'ANTHROPIC'
        );
        return false;
      })
      .map((call, index) => ({ ...call, index }));
  };
  let nativeToolCalls = settleNativeCalls();
  let toolCalls = mergeToolCalls(nativeToolCalls, parsedTools.toolCalls);
  // 文本来源与原生来源分开记：终止性 finish 下只有文本来源的错误还点火 tool_error。
  let textToolErrors = parsedTools.errors;
  let toolErrors = [
    ...textToolErrors,
    ...(nativeToolAccumulator?.getErrors() || [])
  ];
  // 本轮 parser 的**原始** cleanedText 与登记 span（位置坐标系 = 原始文本）。
  // 检测（decideRetryReason / settleThinkPhase）继续吃 tag-stripped 的
  // cleanedText，逐字节不变；剥残渣只在交付点、在原始文本上按位置进行，然后
  // 才剥 agent tag（与 B 同序 —— review loop 1，条目 6）。
  let roundRawCleanedText = parsedTools.cleanedText;
  let roundResidueSpans = parsedTools.residueSpans || [];

  // 非流式没有"已经写到线上"的问题：什么都还没发出去，所以每一轮都可以重试。
  const terminalFinish = () =>
    ['length', 'max_tokens', 'content_filter', 'refusal'].includes(upstreamFinishReason);

  // think phase 的回合定案（与流式分支同一套守卫，注释见彼处：A 的守卫
  // —— openai-agent-runtime.js:232-243 —— 外加两条这里更严的本地守卫：非空白名单
  // fail closed、正文侧零工具错误；终止性 finish 既不晋升也不重试）。守卫不满足
  // 但确有调用/残骸时留下 thought_tool_call 的排放证据。每次正文重新结算后都要
  // 重新定案。
  let attemptThinkEvidence = false;
  const settleThinkPhase = () => {
    attemptThinkEvidence = false;
    if (!hasTools || toolCalls.length > 0) return;
    // 刻意不传 toolSchemas：think 通道里抢救永远不点火（与 B 同一条纪律）。
    const thinkParsed = parseToolCallsFromText(attemptThinkingContent, { allowedToolNames });
    const promotable = allowedToolNames.length > 0 &&
      thinkParsed.toolCalls.length > 0 &&
      thinkParsed.errors.length === 0 &&
      !thinkParsed.cleanedText.trim() &&
      !cleanedText.trim() &&
      toolErrors.length === 0 &&
      !terminalFinish();
    if (promotable) {
      // 晋升时，交付的 thinking 不再携带原始协议负载 —— 与 A 剥离 reasoning 同义
      // （openai-agent-runtime.js:262 晋升后返回 cleanedText）。与流式分支不同，
      // 这里什么都还没发给客户端，遏制是免费的：把本轮 think 段（thinkingContent
      // 的尾巴）换成解析后的 cleanedText；searchTable 前缀与既往轮次的思考不动。
      // 非晋升路径（含重试后的恢复轮）保持原样交付。
      if (attemptThinkingContent && thinkingContent.endsWith(attemptThinkingContent)) {
        thinkingContent = thinkingContent.slice(0, thinkingContent.length - attemptThinkingContent.length) +
          thinkParsed.cleanedText;
      }
      toolCalls = thinkParsed.toolCalls.map((call, index) => ({ ...call, index }));
      return;
    }
    // think phase 里的原生 function_call 帧（无 function_id）同样是排放证据。
    attemptThinkEvidence = nativeThinkEvidence || thinkParsed.toolCalls.length > 0 || thinkParsed.errors.length > 0;
  };
  settleThinkPhase();

  const decideRetryReason = () => {
    if (toolCalls.length > 0) return null;
    if (hasTools && requiresToolCall(toolChoice)) return 'required';
    // 以前任何一个工具错误都会让全部补偿失效并直接 502。被编造的工具名恰恰是最容易
    // 纠正的错误：把允许的名字摆在模型面前即可。终止性 finish 下原生来源的错误不点火
    // （截断的快照 = truncated_native_call，不发射也不重试；文本来源保持今天的行为）。
    if ((terminalFinish() ? textToolErrors : toolErrors).length > 0) return 'tool_error';
    // 与流式分支同一条防御：role:function 丢弃帧 + 零工具调用 + 本请求带工具，
    // 说明平台吃掉了模型的原生调用，用规范标记提示重发一次。终止性 finish 不重试
    // —— 与 missing_tool/empty 同一纪律。
    if (hasTools && normalizeDelta.interceptedToolNames.length > 0 && !terminalFinish()) {
      return 'intercepted';
    }
    // 同族防御：方括号协议写坏（孤儿闭标记 / 开头裸负载）整段泄漏为可见正文。
    // 只是重试信号，泄漏的 JSON 永远不执行。intercepted 在前——丢弃帧是更强的证据。
    if (hasTools && containsOrphanProtocolResidue(cleanedText) && !terminalFinish()) {
      return 'malformed_protocol';
    }
    // 同族第三形态：调用（或其残骸）泄漏在 think phase 里，晋升守卫没放行。
    // 排在 missing_tool 之前；泄漏的调用永远不从这里执行，这只是重试信号。
    if (hasTools && attemptThinkEvidence && !terminalFinish()) {
      return 'thought_tool_call';
    }
    if (hasTools && looksLikeUnexecutedToolAction(cleanedText) && !terminalFinish()) {
      return 'missing_tool';
    }
    if (!cleanedText.trim() && !terminalFinish()) return 'empty';
    return null;
  };

  const config = require('../config/index.js');
  const maxAttempts = Math.max(1, Number(config.agentTurnMaxAttempts) || 1);
  let attemptsMade = 1;
  let streamBrokeOnRetry = false;
  let protocolRecoveryRetried = false;
  // finding 2：拦截重试会用重试轮的解析结果整体替换 cleanedText。若重试轮空手
  // 而归，绝不能拿 502 换掉已经拿到的叙述 —— 留底，收尾时兜底交付（同流式分支
  // "迟到的叙述胜过死掉的会话"的精神）。留底形态：{ stripped, raw, spans }。
  let narrationFallback = null;

  while (attemptsMade < maxAttempts) {
    const retryReason = decideRetryReason();
    if (!retryReason) break;

    // 与流式分支同一条纪律：协议恢复重试（intercepted / malformed_protocol /
    // thought_tool_call 共享同一个名额）整个请求只允许一次。第二次说明提示没被
    // 采纳，把叙述散文按正常回答交付，别再烧尝试次数。放弃时留日志：生产环境
    // 要能区分"提示被采纳、回合恢复"和"第二次、原样交付"。
    const isProtocolRecovery = retryReason === 'intercepted' ||
      retryReason === 'malformed_protocol' ||
      retryReason === 'thought_tool_call';
    if (isProtocolRecovery) {
      if (protocolRecoveryRetried) {
        const giveUpDrops = normalizeDelta.interceptedToolNames.length > 0
          ? ` (dropped: ${normalizeDelta.interceptedToolNames.join(', ')})`
          : '';
        logger.warn(
          `Anthropic 非流式 Agent 协议恢复重试已用完，第二次 ${retryReason} 按原样交付${giveUpDrops}`,
          'ANTHROPIC'
        );
        break;
      }
      protocolRecoveryRetried = true;
    }

    // 有丢弃帧时任何拒绝理由都带上名字：required/tool_error 优先级更高时拦截会
    // 被盖住，这行日志是生产环境验证拦截确实发生的抓手。
    const rejectionDetail = normalizeDelta.interceptedToolNames.length > 0
      ? `${retryReason}; dropped: ${normalizeDelta.interceptedToolNames.join(', ')}`
      : retryReason;
    logger.warn(
      `Anthropic 非流式 Agent attempt ${attemptsMade}/${maxAttempts} 被拒绝 (${rejectionDetail})`,
      'ANTHROPIC'
    );

    let hint = retryReason === 'required'
      ? buildRetryHint(toolChoice)
      : (retryReason === 'missing_tool'
        ? buildMissingToolRetryHint()
        : (retryReason === 'empty'
          ? buildEmptyOutputRetryHint()
          : (retryReason === 'intercepted' || retryReason === 'malformed_protocol' || retryReason === 'thought_tool_call'
            ? buildAgentRetryHint(retryReason)
            : buildToolErrorRetryHint(toolErrors, allowedToolNames))));
    // required / missing_tool 优先级高于 intercepted，会把拦截藏在自己后面。
    // 不动优先级、不动上限——只让提示词把关键事实带上：调用没到客户端。
    if ((retryReason === 'required' || retryReason === 'missing_tool') &&
        normalizeDelta.interceptedToolNames.length > 0) {
      hint = `${hint}\n${buildAgentRetryHint('intercepted')}`;
    }
    // 同一个模式的 think 版本：required / tool_error 盖住 thought_tool_call 时，
    // 提示词仍要带上关键事实 —— 调用写在了模型自己够不到的隐藏推理里。
    if ((retryReason === 'required' || retryReason === 'tool_error') && attemptThinkEvidence) {
      hint = `${hint}\n${buildAgentRetryHint('thought_tool_call')}`;
    }

    // finding 2 的教义对 thought_tool_call 同样成立：14:08 形态（think 泄漏 + 成功
    // 叙述）的重试若空手而归，绝不能拿 502 换掉已经拿到的叙述。malformed_protocol
    // 刻意不在此列：它的 cleanedText 就是泄漏的协议残渣本身（负载 + 孤儿闭标记），
    // 兜底交付它等于把这套防御要挡的裸协议原样递给客户端。
    if ((retryReason === 'intercepted' || retryReason === 'thought_tool_call') && cleanedText.trim()) {
      // 叙述连同它那一轮的原始文本与登记 span 一起留底：兜底交付时残渣剥离要用
      // 同一坐标系（review loop 1，条目 9 —— 兜底轮零错误也可能携带残渣）。
      narrationFallback = { stripped: cleanedText, raw: roundRawCleanedText, spans: roundResidueSpans };
    }

    let retryResp;
    try {
      retryResp = await sendRequest(appendRetryHint(requestBody, hint));
    } catch (e) {
      logger.error('Anthropic 非流式重试失败', 'ANTHROPIC', '', e);
      if (e.publicMessage) throw e;
      break;
    }
    if (!retryResp?.status || !retryResp.response) break;

    attemptsMade += 1;
    const before = answerContent;
    // 每轮全新的累加器，否则上一轮的错误会一直跟着走。原生晋升的按轮状态一并复位。
    nativeToolAccumulator = createNativeToolCallAccumulator({ allowedToolNames, toolSchemas });
    promotedNativeCalls = [];
    nativeThinkEvidence = false;
    stopRequested = false;
    nativePhases.clear();
    // 文本通道守卫、检测解析器与已放行的正文/调用同样按轮全新。
    startTextRound();
    // normalizeDelta 在本分支是跨 attempt 共享的 —— 这本身是个已知缺陷（流式分支
    // 每轮新建；统一两个循环的计划在 lohari 仓库
    // _bmad-output/implementation-artifacts/spec-qwen2api-unify-agent-loop.md）。
    // 在那之前：拦截计数必须按轮**就地**归零（length = 0，不能重新赋值 ——
    // decideRetryReason 闭包持有的是同一个数组引用），否则上一轮的丢弃会把
    // 成功的重试再判成拦截，协议恢复名额被烧光后以 502 收场。
    normalizeDelta.interceptedToolNames.length = 0;
    // 判定输入按轮清零（thinkingContent 本身继续累计 —— 响应交付语义不动）。
    attemptThinkingContent = '';
    upstreamFinishReason = null;
    const retryResult = await consumeUpstream(retryResp.response, onUpstreamDelta, { shouldStop: () => stopRequested });
    upstreamCompleted = retryResult.completed;
    if (!upstreamCompleted && !upstreamFinishReason) {
      streamBrokeOnRetry = true;
      break;
    }
    const retried = answerContent.slice(before.length);
    const parsedRetry = textRunaway?.cutRule()
      ? settledStreamedRound()
      : parseToolCallsFromText(retried, { allowedToolNames, toolSchemas });
    nativeToolCalls = settleNativeCalls();
    toolCalls = mergeToolCalls(nativeToolCalls, parsedRetry.toolCalls);
    cleanedText = stripAgentTags(parsedRetry.cleanedText);
    textToolErrors = parsedRetry.errors;
    toolErrors = [...textToolErrors, ...nativeToolAccumulator.getErrors()];
    // 交付轮换人：原始文本与登记 span 一起换（丢了这行，上一轮的 span 配不上
    // 本轮文本，残渣原样上线 —— 有测试钉住）。
    roundRawCleanedText = parsedRetry.cleanedText;
    roundResidueSpans = parsedRetry.residueSpans || [];
    // 重试轮的 think phase 同样要定案：晋升或留证据，下一次 decideRetryReason 才看得见。
    settleThinkPhase();
  }

  // 与流式分支对称的收尾观测：次数用尽而最后一轮仍被拒绝时留痕（协议恢复的
  // give-up 在循环内已有自己的日志，且只在 attemptsMade < maxAttempts 时触发，
  // 不会与这行重复）。措辞中立：接下来可能按原样交付、502 或兜底叙述，不预判。
  if (!streamBrokeOnRetry && attemptsMade >= maxAttempts) {
    const finalRejection = decideRetryReason();
    if (finalRejection) {
      logger.warn(
        `Anthropic 非流式 Agent 尝试次数用尽（${attemptsMade}/${maxAttempts}），最后一轮仍被拒绝 (${finalRejection})`,
        'ANTHROPIC'
      );
    }
  }

  if (streamBrokeOnRetry) {
    return res.status(502).json({
      type: 'error',
      error: { type: 'api_error', message: '工具调用重试流在结束标记前断开' }
    });
  }

  // finding 2：拦截重试之后的轮次两手空空时，交还拦截那一轮的叙述，而不是 502。
  // 客户端拿到"工具好像坏了"的叙述还能继续对话；拿到 502 这回合就死了。
  // 原始文本与登记 span 跟着叙述一起换 —— 交付剥离用同一坐标系。
  if (toolCalls.length === 0 && !cleanedText.trim() && narrationFallback) {
    cleanedText = narrationFallback.stripped;
    roundRawCleanedText = narrationFallback.raw;
    roundResidueSpans = narrationFallback.spans;
  }

  // salvage-3 layer 3：交付轮登记过残渣才动交付文本（review loop 1，条目 9：
  // 门挂在 residueSpans 上，不挂 toolErrors —— narrationFallback 轮零错误也可能
  // 携带残渣）。位置驱动：在**原始**文本上按登记落点剥，再剥 agent tag（与 B
  // 同序）。检测与重试判定（decideRetryReason / containsOrphanProtocolResidue）
  // 早已在未剥离文本上跑完 —— 剥离只发生在交付点。剥离必须在下面的空判据
  // **之前**（review loop 2）：一整轮只有 debris 残渣（无信封负载配不平 ——
  // 有登记、零 toolErrors）时，剥后为空要走「无正文」的 502，绝不能交付
  // content: [] 的空消息（frozen matrix：never an empty-content message；
  // 复现脚本 repro-item9-corner.js 钉死过 200 + 空数组的老结局）。
  // Ask-first 决议：静默剥离、日志留痕，不注入任何替代文本。零残渣轮逐字节
  // 保持今天的交付。
  if (hasTools && roundResidueSpans.length > 0) {
    const residueFree = stripAgentTags(stripToolCallResidue(roundRawCleanedText, roundResidueSpans));
    if (residueFree !== cleanedText) {
      cleanedText = residueFree;
      logger.warn('Anthropic 非流式交付前按登记位置剥离协议残渣，零协议字节交付', 'ANTHROPIC');
    }
  }

  // 残渣纯度判据（review loop 2）：剥离已经跑完（上面的 layer-3 块），此处的
  // cleanedText 就是将要进 content blocks 的交付文本。整轮登记过残渣、剥后什么
  // 都不剩（bare 负载 debris、孤儿闭标记）→ 这轮和 tool_error 轮是同一类失败：
  // 502 invalid_tool_call_error，绝不交付 content: [] 的空消息，也绝不把裸协议
  // 当回答发出去（frozen matrix：never an empty-content message / raw protocol
  // never reaches a client）。剥后还有真实正文的轮子照常交付 —— 一句散文 + 一个
  // 迷路的闭标记绝不能升级成 502。
  const residueOnlyTurn = hasTools && roundResidueSpans.length > 0 && !cleanedText.trim();
  if (hasTools && toolCalls.length === 0 &&
      (toolErrors.length > 0 || requiresToolCall(toolChoice) || residueOnlyTurn)) {
    // 这个细节以前存在于 errors 里却被丢掉，于是三种截然不同的原因挤进同一句
    // 不透明的报错，而 unknown_tool 连一行日志都不留。
    const detail = toolErrors.length
      ? describeToolErrors(toolErrors)
      : (requiresToolCall(toolChoice)
        ? 'tool_choice=required 未触发任何工具调用'
        : '整轮内容只有协议残渣，剥离后为空');
    // logger 上只有 warn，没有 warning —— 旧的 logger.warning?.() 是静默空操作。
    logger.warn(
      `Anthropic 非流式工具协议失败，${attemptsMade}/${maxAttempts} 次尝试后放弃 (${detail})`,
      'ANTHROPIC'
    );
    return res.status(502).json({
      type: 'error',
      error: {
        type: 'invalid_tool_call_error',
        message: attemptsMade > 1
          ? `上游连续 ${attemptsMade} 次返回了残缺、非法或不存在的工具调用 (${detail})`
          : `上游返回了残缺、非法或不存在的工具调用 (${detail})`
      }
    });
  }

  if (toolCalls.length === 0 && !cleanedText.trim() &&
      !['length', 'max_tokens', 'content_filter', 'refusal'].includes(upstreamFinishReason)) {
    return res.status(502).json({
      type: 'error',
      error: { type: 'api_error', message: '上游重试后仍未返回正文或工具调用' }
    });
  }

  const stopReason = mapAnthropicStopReason(
    upstreamFinishReason,
    toolCalls.length > 0,
    upstreamCompleted
  );
  if (!stopReason) {
    return res.status(502).json({
      type: 'error',
      error: { type: 'api_error', message: '上游流在结束标记前断开' }
    });
  }

  if (promptTokens === 0 && completionTokens === 0) {
    // 早停的回合收不到上游尾部的 usage 帧：原生调用的参数 JSON 也进本地估算，免得 ~0。
    const nativeArgsText = nativeToolCalls.map(call => call.function.arguments || '').join('');
    const usage = createUsageObject(requestBody?.messages || '', thinkingContent + answerContent + nativeArgsText, null);
    promptTokens = usage.prompt_tokens || 0;
    completionTokens = usage.completion_tokens || 0;
  }

  const contentBlocks = [];
  if (thinkingContent && thinkingContent.trim()) {
    contentBlocks.push({
      type: 'thinking',
      thinking: thinkingContent,
      signature: `qwen2api_${generateUUID().replace(/-/g, '')}`
    });
  }
  if (cleanedText && cleanedText.trim()) {
    contentBlocks.push({ type: 'text', text: cleanedText });
  }
  for (const call of toolCalls) {
    let input;
    try { input = JSON.parse(call.function.arguments || '{}'); } catch (_) { input = {}; }
    contentBlocks.push({
      type: 'tool_use',
      id: toAnthropicToolUseId(call.id),
      name: call.function.name,
      input
    });
  }

  // Daily stats 累计——一次性归属主账户（同 stream 分支注释）
  attributeChatUsage(ctx.currentAccount, promptTokens, completionTokens);

  const createdAt = new Date().toISOString();
  res.set({ 'Content-Type': 'application/json' });
  res.json({
    id: message_id,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    created_at: createdAt,
    metadata: {},
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null
    }
  });
};

/**
 * Anthropic /v1/messages 主入口
 * @param {object} req - Express 请求
 * @param {object} res - Express 响应
 */
const handleAnthropicMessages = async (req, res) => {
  try {
    const compatibility = analyzeAnthropicCompatibility(req.body || {});
    const compatibilityHeaders = buildAnthropicCompatibilityHeaders(compatibility);
    if (Object.keys(compatibilityHeaders).length > 0) {
      res.set(compatibilityHeaders);
      logger.warn(
        `Anthropic compatibility notice: ${compatibility.summary}`,
        'ANTHROPIC'
      );
    }

    const built = await buildInternalRequest(req.body || {});
    const { body, hasTools, historyToolCalls, toolChoice, allowedToolNames, toolSchemas, model } = built;

    const upstreamResp = await sendChatRequest(body);
    if (!upstreamResp.status || !upstreamResp.response) {
      return res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: upstreamResp.message || 'Request failed' }
      });
    }

    // Aviso al cliente cuando el contexto se recortó en silencio. El fallback por fallo
    // del adjunto deja pasar un 200 con una fracción del contexto original: sin esta
    // cabecera el cliente cree que el modelo lo vio todo. Convención existente:
    // anthropic.compatibility.js#X-Qwen2API-Anthropic-Warnings.
    if (upstreamResp.contextCompacted) {
      res.set('X-Qwen2API-Context-Compacted', String(upstreamResp.contextSerializedBytes || 0));
    }

    const message_id = `msg_${generateUUID().replace(/-/g, '').slice(0, 24)}`;
    const ctx = {
      message_id,
      model,
      hasTools,
      historyToolCalls,
      toolChoice,
      allowedToolNames,
      toolSchemas,
      requestBody: body,
      currentAccount: upstreamResp.currentAccount
    };

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
        error: { type: 'api_error', message: error.publicMessage || 'Service error' }
      });
    } else {
      if (!res.writableEnded) {
        try { writeAnthropicError(res, error.publicMessage || '上游响应处理失败', 'api_error'); } catch (_) { /* ignore */ }
      }
    }
  }
};

module.exports = {
  handleAnthropicMessages,
  analyzeAnthropicCompatibility,
  buildAnthropicCompatibilityHeaders,
  // 暴露内部辅助以便测试
  flattenAnthropicMessages,
  buildInternalRequest,
  normalizeAnthropicTools,
  normalizeAnthropicToolChoice,
  normalizeAnthropicSystem,
  mapAnthropicStopReason,
  consumeUpstream,
  runWithAnthropicPing,
  handleAnthropicStream,
  handleAnthropicNonStream,
  describeToolErrors,
  buildToolErrorRetryHint
};
