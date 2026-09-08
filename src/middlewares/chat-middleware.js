const { generateUUID } = require('../utils/tools.js')
const { isChatType, isThinkingEnabled, parserModel, parserMessages, extractMediaToFiles, harvestCurrentTurnMedia, attachMediaToLastMessage } = require('../utils/chat-helpers.js')
const { buildToolSystemPrompt, foldToolMessages } = require('../utils/tool-prompt.js')
const { buildAgentTurnDirective, buildToolHistoryLedger } = require('../utils/agent-turn.js')
const { logger } = require('../utils/logger')
const { mapIncomingModel } = require('../utils/model-map.js')

const shouldEnableToolRuntime = (tools, chatType, toolChoice) => (
  Array.isArray(tools) &&
  tools.length > 0 &&
  chatType === 't2t' &&
  toolChoice !== 'none'
)

const HARVEST_CHAT_TYPES = new Set(['t2t', 'search', 'image_edit'])

const AGENT_CURRENT_MESSAGE_MARKER = '# Current message'

const ensureAgentCurrentEnvelope = (content, role = 'user') => {
  const wrap = (text) => {
    const value = String(text || '')
    if (value.includes('# Conversation history (JSONL)') || value.includes(AGENT_CURRENT_MESSAGE_MARKER)) {
      return value
    }
    return `${AGENT_CURRENT_MESSAGE_MARKER}\n${JSON.stringify({ role, content: value })}`
  }

  if (typeof content === 'string') return wrap(content)
  if (!Array.isArray(content)) return content

  let wrapped = false
  const result = content.map(item => {
    if (!wrapped && item?.type === 'text') {
      wrapped = true
      return { ...item, text: wrap(item.text) }
    }
    return item
  })
  if (!wrapped) result.unshift({ type: 'text', text: wrap('') })
  return result
}

/**
 * 处理聊天请求体的中间件
 * 解析和转换请求参数为内部格式
 */
const processRequestBody = async (req, res, next) => {
  try {
    // 获取请求体原始数据
    let {
      messages,            // 消息历史
      model,               // 模型
      stream,              // 流式输出
      enable_thinking,     // 是否启用思考
      thinking_budget,      // 思考预算
      size,                  //图片尺寸
      tools,                // 工具列表（OpenAI function calling）
      tool_choice           // 工具调用控制
    } = req.body

    // 先做 MODEL_MAP 映射，再判定 thinking / chat_type：目标 id 的 -thinking 后缀要照常生效
    model = await mapIncomingModel(model)

    const now = Math.floor(Date.now() / 1000)
    const fid = generateUUID()
    const thinkingConfig = await isThinkingEnabled(model, enable_thinking, thinking_budget)

    // 构建请求体 — 对齐 React 前端格式
    const body = {
      stream: stream !== false,
      version: '2.1',
      incremental_output: true,
      chat_id: null,                    // 由 sendChatRequest 填充
      chatId: null,
      chat_mode: 'normal',
      model: await parserModel(model),
      parent_id: null,
      parentId: null,
      messages: [{
        id: null,
        fid: fid,
        parentId: null,
        parent_id: null,
        childrenIds: [generateUUID()],
        role: 'user',                   // 取最后一条消息的角色
        content: '',                    // 由下方 parserMessages 填充
        user_action: 'chat',
        files: [],
        timestamp: now,
        models: [await parserModel(model)],
        model: '',
        chat_type: isChatType(model),
        feature_config: {
          output_schema: 'phase', // 必需：缺失时上游不再返回 delta.phase，chat.js 会丢弃全部增量（completion=0）
          thinking_enabled: thinkingConfig.thinking_enabled,
          research_mode: 'normal',
          auto_thinking: true,
          thinking_mode: 'Auto',
          thinking_format: 'summary', // 与官方 FE + Max 模型 meta 一致
          auto_search: true
        },
        extra: { meta: { subChatType: isChatType(model) } },
        sub_chat_type: isChatType(model)
      }],
      timestamp: now
    }

    // 处理 stream 参数
    if (stream === true || stream === 'true') {
      body.stream = true
    } else {
      body.stream = false
    }

    // 处理 tools 参数 : 通过提示词为网页版模型注入工具调用能力
    const chatType = isChatType(model)
    // OpenAI 允许请求同时携带 tools 和 tool_choice="none"。这种请求必须走普通
    // 文本完成路径，不能注入工具协议或启用严格 Agent 回合门禁。
    const hasTools = shouldEnableToolRuntime(tools, chatType, tool_choice)
    const originalLastMessage = Array.isArray(messages) ? messages[messages.length - 1] : null
    const afterToolResult = ['tool', 'function'].includes(String(originalLastMessage?.role || '').toLowerCase())
    // 当前回合的图片几乎从来不在最后一条消息上：真实客户端会在图片后面再补一条纯文本
    // 消息（OpenClaw 的 OPENCLAW_INTERNAL_CONTEXT，Claude Code 的 `[Image: source: …]`），
    // 而 parserMessages 只上传最后一条的媒体。先收上来，折叠完再挂回去。
    // 详见 chat-helpers.js#harvestCurrentTurnMedia（含 2026-09-08 的真实抓包证据）。
    // 白名单，不是黑名单：routes/chat.js 的分发表把 deep_research 和**所有未知类型**都
    // 交给 handleImageVideoCompletion，而那个控制器只在 t2i/t2v/image_edit 里给 content
    // 赋值。用黑名单的话，任何新增/未知类型都会默默落进收割区。
    //
    // image_edit 必须留在名单里：那条路正是靠收割把输入图放进 files[]
    // （chat.image.video.js:1290-1313）。t2i/t2v 排除掉：那里 content 是纯文本提示词，
    // 收割会把它变成数组、塞进空的 '\n\n' 分隔符，还会为一张控制器根本不看的图付一次上传，
    // 顺带打断 '@16:9' 这类尺寸嗅探。
    const currentTurnMedia = HARVEST_CHAT_TYPES.has(chatType)
      ? harvestCurrentTurnMedia(messages)
      : []

    let preparedMessages = messages
    let toolSystemPrompt = ''
    let toolHistoryLedger = ''
    if (hasTools) {
      toolSystemPrompt = buildToolSystemPrompt(tools, { tool_choice })
      // Sobre los mensajes CRUDOS, antes del fold: despues foldToolMessages deja la
      // llamada como texto (`[TOOL CALL #1]`) sin tool_calls ni tool_call_id, y el ledger
      // saldria vacio sin que nada lo delate. Gemelo de anthropic.js#buildInternalRequest,
      // que lo arma sobre `flat` antes de su propio fold.
      toolHistoryLedger = buildToolHistoryLedger(messages || [])
      preparedMessages = foldToolMessages(messages || [])
      req.has_tools = true
      req.tool_choice = tool_choice || 'auto'
      req.allowed_tool_names = tools
        .map(tool => tool?.function?.name)
        .filter(name => typeof name === 'string' && name.length > 0)
      // Fuente de las puertas de schema del parser (reparacion de comillas internas y
      // aceptacion tras prosa): nombre de herramienta -> JSON Schema. Gemelo de
      // anthropic.js#buildInternalRequest — sin esto ambas puertas fallan cerradas en
      // /v1/chat/completions y una llamada narrada valida se pierde.
      // Object.create(null): los nombres vienen del cliente, `__proto__` jamas toca la
      // cadena de prototipos. Nombre duplicado = fail closed (se borra la entrada, el
      // nombre sigue en la whitelist): dos declaraciones no tienen un schema unico y
      // last-wins invalidaria silenciosamente la primera.
      const toolSchemas = Object.create(null)
      const seenToolNames = new Set()
      for (const tool of tools) {
        const name = tool?.function?.name
        if (typeof name !== 'string' || name.length === 0) continue
        // Nombre repetido = fail closed: dos declaraciones no tienen un schema unico y
        // last-wins invalidaria en silencio a la primera. Se comprueba sobre los nombres
        // VISTOS, no sobre las entradas: si la primera declaracion se salto por schema
        // inservible, la segunda tampoco puede reclamar el nombre.
        if (seenToolNames.has(name)) {
          delete toolSchemas[name]
          continue
        }
        seenToolNames.add(name)
        const parameters = tool.function.parameters
        // Un schema ausente o que no es un objeto no vale como schema. Sin entrada, la puerta
        // semantica (hasOwnProperty en tool-prompt.js#gateAfterProsePayload) falla cerrada —
        // el comportamiento previo a esta spec. Con entrada basura pasaria a leer `required`
        // de undefined, es decir "ninguno", y admitiria un payload pelado tras prosa con
        // argumentos arbitrarios sin validar.
        if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) continue
        toolSchemas[name] = parameters
      }
      req.tool_schemas = toolSchemas
    } else {
      req.has_tools = false
      req.allowed_tool_names = []
      req.tool_schemas = null
    }

    // 必须在 foldToolMessages 之后再挂：折叠会把 role=tool/assistant 的消息换成新对象，
    // 挂早了那份就被丢掉了。挂到最后一条，parserMessages 才会去上传它。
    attachMediaToLastMessage(preparedMessages, currentTurnMedia)

    // 处理 messages 参数 : 消息历史（返回 OpenAI 格式消息数组）
    const parsedMessages = await parserMessages(preparedMessages, thinkingConfig, chatType)

    // 将解析后的消息填充到 React UI 格式的消息对象中
    // 取最后一条用户消息作为主消息内容，历史消息通过 content 传递
    const lastMessage = parsedMessages[parsedMessages.length - 1] || { role: 'user', content: '' }
    // 图片从 content[] 换到 files[]：content[] 带图 + files[] 带外置上下文文档的组合
    // 会让上游 500（详见 chat-helpers.js#extractMediaToFiles）。
    //
    // 只对走文本控制器的 chat_type 生效。routes/chat.js 的分发表把 t2t / search 交给
    // handleChatCompletion，其余（t2i / t2v / image_edit，以及未知类型的兜底）全部交给
    // handleImageVideoCompletion —— 后者拿的就是这个 req.body，并且直接读
    // messages[0].content，期待原始的 content 数组。换成字符串会让 image_edit 走进
    // `!Array.isArray(userPrompt)` 分支退化成 t2i，把输入图片整个丢掉。
    const splitsMediaToFiles = chatType === 't2t' || chatType === 'search'
    const { content: envelopeContent, files: envelopeFiles } = splitsMediaToFiles
      ? extractMediaToFiles(lastMessage.content || '')
      : { content: lastMessage.content || '', files: [] }
    body.messages[0].role = lastMessage.role || 'user'
    body.messages[0].content = envelopeContent
    // files 的键位在上面的信封字面量里（对齐 React UI 的键顺序，别挪），这里只填内容。
    body.messages[0].files.push(...envelopeFiles)
    body.messages[0].chat_type = chatType
    body.messages[0].sub_chat_type = chatType
    body.messages[0].feature_config.thinking_enabled = thinkingConfig.thinking_enabled

    // 工具提示词拼接到用户消息内容上
    if (hasTools && toolSystemPrompt) {
      body.messages[0].content = ensureAgentCurrentEnvelope(
        body.messages[0].content,
        lastMessage.role || 'user'
      )
      // Orden fijo en ambos caminos: toolPrompt -> ledger -> envelope -> directive. El
      // ledger va pegado al protocolo porque es parte del contrato de herramientas (sin el
      // protocolo delante seria una lista de ordinales sueltos), y delante de la historia
      // que documenta. Vive en el prefijo, que parseAgentEnvelope (utils/request.js) nunca
      // externaliza: dentro del bloque de historia el contrapeso desapareceria justo en las
      // conversaciones largas, que son las que repiten llamadas.
      const toolPrefix = [toolSystemPrompt, toolHistoryLedger].filter(Boolean).join('\n\n')
      const msgContent = body.messages[0].content
      if (typeof msgContent === 'string') {
        body.messages[0].content = `${toolPrefix}\n\n${msgContent}`
      } else if (Array.isArray(msgContent)) {
        const textIdx = msgContent.findIndex(c => c?.type === 'text')
        if (textIdx >= 0) {
          msgContent[textIdx].text = `${toolPrefix}\n\n${msgContent[textIdx].text || ''}`
        } else {
          msgContent.unshift({ type: 'text', text: toolPrefix })
        }
      }

      const turnDirective = buildAgentTurnDirective({ afterToolResult })
      const directedContent = body.messages[0].content
      if (typeof directedContent === 'string') {
        body.messages[0].content = `${directedContent}\n\n${turnDirective}`
      } else if (Array.isArray(directedContent)) {
        const textIdx = directedContent.findIndex(c => c?.type === 'text')
        if (textIdx >= 0) {
          directedContent[textIdx].text = `${directedContent[textIdx].text || ''}\n\n${turnDirective}`
        } else {
          directedContent.unshift({ type: 'text', text: turnDirective })
        }
      }
    }

    // 保存完整消息历史供下游使用（用于多轮对话上下文）
    req.parsed_messages = parsedMessages
    req.enable_thinking = thinkingConfig.thinking_enabled
    req.enable_web_search = chatType === 'search' ? true : false

    // 顶层 chat_type 供路由选择器使用 (selectChatCompletion)
    body.chat_type = chatType

    // 处理图片尺寸
    if (size) {
      body.size = size
    }

    // 处理请求体,将body赋值给req.body
    req.body = body

    next()
  } catch (e) {
    logger.error('处理请求体时发生错误', 'MIDDLEWARE', '', e)
    res.status(500)
      .json({
        status: 500,
        message: "在处理请求体时发生错误 ~ ~ ~"
      })
  }
}

module.exports = {
  processRequestBody,
  shouldEnableToolRuntime,
  ensureAgentCurrentEnvelope
}
