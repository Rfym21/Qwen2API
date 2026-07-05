<div align="center">

> [中文](README.md) | [🇷🇺 Русская версия](README-ru.md) | [English](README-en.md)

# 🚀 Qwen-Proxy

[![Version](https://img.shields.io/badge/version-2026.04.29.23.45-blue.svg)](https://github.com/Rfym21/Qwen2API)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-supported-blue.svg)](https://hub.docker.com/r/rfym21/qwen2api)

[🔗 Join Telegram Group](https://t.me/nodejs_project) | [📖 Documentation](#api-documentation) | [🐳 Docker Deployment](#docker-deployment)

</div>

## 🛠️ Quick Start

### Project Description

Qwen-Proxy is a proxy service that converts `https://chat.qwen.ai` and `Qwen Code / Qwen Cli` into an OpenAI-compatible API. With this project, you only need one account to use any OpenAI API-compatible client (such as ChatGPT-Next-Web, LobeChat, etc.) to call various models from `https://chat.qwen.ai` and `Qwen Code / Qwen Cli`. Models under the `/cli` endpoint are provided by `Qwen Code / Qwen Cli`, supporting 256k context and native tools parameter support.

**Main Features:**
- Compatible with OpenAI API format for seamless integration with various clients
- Compatible with Anthropic Messages API (`/v1/messages`), supporting Claude Code, Anthropic SDK, and other clients
- Supports Function Calling (OpenAI `tools` / Anthropic `tools`), including streaming `arguments` incremental chunks and `tool_choice=required` strict validation retry
- Supports multi-account polling to improve availability
- Supports streaming/non-streaming responses
- Supports multimodal (image recognition, video understanding, image/video generation)
- Supports OpenAI-style resource endpoints: `/v1/images/generations`, `/v1/images/edits`, `/v1/videos`
- Supports advanced features like smart search and deep thinking
- Supports CLI endpoints with 256K context and tool calling capabilities
- Provides web management interface for easy configuration and monitoring
- Batch account addition supports real-time progress display, adjustable login concurrency in system settings

### 🌐 Per-Account Proxy

Each account can be configured with its own outbound proxy, allowing multiple accounts to use different IPs simultaneously, avoiding IP-based association bans from `chat.qwen.ai`.

**Priority:** `account.proxy` > Global `PROXY_URL` > No proxy

**Supported Proxy Protocols:** HTTP / HTTPS / SOCKS5 (consistent with `PROXY_URL`)

**Frontend Configuration (Recommended):**
Open the management panel → Fill in the "Proxy Address" field when adding accounts, or click the "Modify Proxy" button on existing account cards.

**ENV Configuration (DATA_SAVE_MODE=none):**

```bash
# Old format (backward compatible, per-account proxy left empty)
ACCOUNTS=user1@mail.com:pass1,user2@mail.com:pass2

# New format (separated by | for proxy URLs, can be mixed with old format)
ACCOUNTS=user1@mail.com:pass1|http://10.0.0.1:8080,user2@mail.com:pass2|socks5://10.0.0.2:1080
```

**File mode (`data/data.json`) schema:**

```json
{
  "accounts": [
    {
      "email": "user@mail.com",
      "password": "...",
      "token": "...",
      "expires": 1234567890,
      "proxy": "http://10.0.0.1:8080"
    }
  ]
}
```

When the [proxy](file://d:\Code\Qwen2API\src\utils\account-parser.js#L27-L27) field is `null` or missing, the account falls back to the global `PROXY_URL` (if configured).

> ⚠️ **Note:** Proxy URLs returned by the interface are not sanitized. This project assumes it runs in a trusted local or private network environment used by a single administrator.

### Requirements

- Node.js 18+ (required for source deployment)
- Docker (optional)
- Redis (optional, for data persistence)

### ⚙️ Environment Configuration

Create a `.env` file and configure the following parameters:

```bash
# 🌐 Service Configuration
LISTEN_ADDRESS=localhost       # Listen address
SERVICE_PORT=3000             # Service port

# 🔐 Security Configuration
API_KEY=sk-123456,sk-456789   # API key (required, supports multiple keys)
ACCOUNTS=                     # Account configuration (format: user1:pass1[|proxy_url],user2:pass2[|proxy_url])

# 🚀 PM2 Multi-process Configuration
PM2_INSTANCES=1               # Number of PM2 processes (1/number/max)
PM2_MAX_MEMORY=1G             # PM2 memory limit (100M/1G/2G, etc.)
                              # Note: All processes in PM2 cluster mode share the same port

# 🔍 Feature Configuration
SEARCH_INFO_MODE=table        # Search info display mode (table/text)
OUTPUT_THINK=true             # Whether to output thinking process (true/false)
LEGACY_REASONING_IN_CONTENT=false # Reasoning format, false=reasoning_content field, true=legacy <think> inside content (true/false)
SIMPLE_MODEL_MAP=false        # Simplify model mapping (true/false)
MODELS_CACHE_TTL=3600         # Model list cache TTL in seconds, 0=never expires

# 🌐 Proxy and Reverse Proxy Configuration
QWEN_CHAT_PROXY_URL=          # Custom Chat API reverse proxy URL (default: https://chat.qwen.ai)
QWEN_CLI_PROXY_URL=           # Custom CLI API reverse proxy URL (default: https://portal.qwen.ai)
PROXY_URL=                    # HTTP/HTTPS/SOCKS5 proxy address (example: http://127.0.0.1:7890)

# 🗄️ Data Storage
DATA_SAVE_MODE=none           # Data save mode (none/file/redis)
REDIS_URL=                    # Redis connection address (optional, rediss:// for TLS)
BATCH_LOGIN_CONCURRENCY=5     # Login concurrency during batch account addition

# 📸 Cache Configuration
CACHE_MODE=default            # Image cache mode (default/file)
```

#### 📋 Configuration Description

| Parameter | Description | Example |
|-----------|-------------|---------|
| `LISTEN_ADDRESS` | Service listen address | `localhost` or `0.0.0.0` |
| [SERVICE_PORT](file://d:\Code\Qwen2API\src\start.js#L12-L12) | Service running port | `3000` |
| `API_KEY` | API access key, supports multi-key configuration. The first is the admin key (can access frontend management page), others are regular keys (API calls only). Multiple keys separated by commas | `sk-admin123,sk-user456,sk-user789` |
| [PM2_INSTANCES](file://d:\Code\Qwen2API\src\start.js#L11-L11) | Number of PM2 processes | `1`/`4`/`max` |
| `PM2_MAX_MEMORY` | PM2 memory limit | `100M`/`1G`/`2G` |
| `SEARCH_INFO_MODE` | Search result display format | `table` or [text](file://d:\Code\Qwen2API\src\utils\tool-prompt.js#L206-L206) |
| `OUTPUT_THINK` | Whether to show AI thinking process | `true` or `false` |
| `LEGACY_REASONING_IN_CONTENT` | Reasoning output format. Default `false` = reasoning goes to a separate `reasoning_content` field; `true` = legacy behavior (`<think>` inside `content`) | `true` or `false` |
| `SIMPLE_MODEL_MAP` | Simplify model mapping, return basic models without variants only | `true` or `false` |
| `MODELS_CACHE_TTL` | Model list cache TTL in seconds; after expiry the next request refreshes it from upstream; `0` = never expires | `3600` |
| `QWEN_CHAT_PROXY_URL` | Custom Chat API reverse proxy address | `https://your-proxy.com` |
| `QWEN_CLI_PROXY_URL` | Custom CLI API reverse proxy address | `https://your-cli-proxy.com` |
| `PROXY_URL` | Outbound request proxy address, supports HTTP/HTTPS/SOCKS5 | `http://127.0.0.1:7890` |
| `DATA_SAVE_MODE` | Data persistence method | `none`/`file`/[redis](file://d:\Code\Qwen2API\src\utils\logger.js#L294-L296) |
| `REDIS_URL` | Redis database connection address, use `rediss://` protocol when using TLS encryption | `redis://localhost:6379` or `rediss://xxx.upstash.io` |
| `BATCH_LOGIN_CONCURRENCY` | Login concurrency during batch account addition, can be adjusted dynamically in frontend system settings | `5` |
| `CACHE_MODE` | Image cache storage method | `default`/`file` |
| [LOG_LEVEL](file://d:\Code\Qwen2API\backend\core\config.py#L30-L30) | Log level | `DEBUG`/`INFO`/`WARN`/`ERROR` |
| `ENABLE_FILE_LOG` | Enable file logging | `true` or `false` |
| `LOG_DIR` | Log file directory | `./logs` |
| `MAX_LOG_FILE_SIZE` | Maximum log file size (MB) | `10` |
| `MAX_LOG_FILES` | Number of log files to retain | `5` |

> 💡 **Tip**: You can create a free Redis instance at [Upstash](https://upstash.com/), use `rediss://...` format when using TLS protocol
<div>
<img src="./docs/images/upstash.png" alt="Upstash Redis" width="600">
</div>

#### 🔑 Multi-API_KEY Configuration Description

The `API_KEY` environment variable supports configuring multiple API keys to implement access control with different permission levels:

**Configuration Format:**
```bash
# Single key (admin privileges)
API_KEY=sk-admin123

# Multiple keys (first is admin, others are regular users)
API_KEY=sk-admin123,sk-user456,sk-user789
```

**Permission Description:**

| Key Type | Permission Scope | Function Description |
|----------|------------------|----------------------|
| **Admin Key** | Full Permissions | • Access frontend management page<br>• Modify system settings<br>• Call all API interfaces<br>• Add/delete regular keys |
| **Regular Key** | API Call Permissions | • API interface calls only<br>• Cannot access frontend management page<br>• Cannot modify system settings |

**Use Cases:**
- **Team Collaboration**: Assign different permission API keys to different team members
- **Application Integration**: Provide restricted API access permissions for third-party applications
- **Security Isolation**: Separate management permissions from regular usage permissions

**Notes:**
- The first API_KEY automatically becomes the admin key with highest privileges
- Admins can dynamically add or delete regular keys through the frontend page
- All keys can normally call API interfaces, permission differences only affect management functions

#### 📸 CACHE_MODE Cache Mode Description

The `CACHE_MODE` environment variable controls the storage method of image caching to optimize image upload and processing performance:

| Mode | Description | Use Case |
|------|-------------|----------|
| `default` | Memory cache mode (default) | Single process deployment, cache lost after restart |
| `file` | File cache mode | Multi-process deployment, cache persisted to `./caches/` directory |

**Recommended Configuration:**
- **Single Process Deployment**: Use `CACHE_MODE=default`, best performance
- **Multi-Process/Cluster Deployment**: Use `CACHE_MODE=file`, ensure inter-process cache sharing
- **Docker Deployment**: Recommend using `CACHE_MODE=file` and mounting `./caches` directory

**File Cache Directory Structure:**
```
caches/
├── [signature1].txt    # Cache file containing image URL
├── [signature2].txt
└── ...
```

---

## 🚀 Deployment Methods

### 🐳 Docker Deployment

#### Method One: Direct Run

```bash
docker run -d \
  -p 3000:3000 \
  -e API_KEY=sk-admin123,sk-user456,sk-user789 \
  -e DATA_SAVE_MODE=none \
  -e CACHE_MODE=file \
  -e ACCOUNTS= \
  -v ./caches:/app/caches \
  --name qwen2api \
  rfym21/qwen2api:latest
```

#### Method Two: Docker Compose

```bash
# Download configuration file
curl -o docker-compose.yml https://raw.githubusercontent.com/Rfym21/Qwen2API/refs/heads/main/docker/docker-compose.yml

# Start service
docker compose pull && docker compose up -d
```

### 📦 Local Deployment

```bash
# Clone project
git clone https://github.com/Rfym21/Qwen2API.git
cd Qwen2API

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# Edit .env file

# Smart start (recommended - automatically determines single/multi-process)
npm start

# Development mode
npm run dev
```

### 🚀 PM2 Multi-Process Deployment

Use PM2 for production environment multi-process deployment, providing better performance and stability.

**Important Note**: In PM2 cluster mode, all processes share the same port, and PM2 automatically performs load balancing.

### 🤖 Smart Start Mode

Using `npm start` can automatically determine the startup method:

- When `PM2_INSTANCES=1`, uses single-process mode
- When `PM2_INSTANCES>1`, uses Node.js cluster mode
- Automatically limits process count to no more than CPU cores

### ☁️ Hugging Face Deployment

Quickly deploy to Hugging Face Spaces:

[![Deploy to Hugging Face](https://img.shields.io/badge/🤗%20Hugging%20Face-Deploy-yellow)](https://huggingface.co/spaces/devme/q2waepnilm)

<div>
<img src="./docs/images/hf.png" alt="Hugging Face Deployment" width="600">
</div>

### ☁️ Vercel Deployment

Quickly deploy to Vercel:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FRfym21%2FQwen2API)

Need to configure environment variables:
```
ACCOUNTS=email:password
SERVICE_PORT=80
API_KEY=sk-xxx
DATA_SAVE_MODE=none
```

---

## 📁 Project Structure

```
Qwen2API/
├── README.md
├── README-en.md
├── ecosystem.config.js              # PM2 configuration file
├── package.json
│
├── docker/                          # Docker configuration directory
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── docker-compose-redis.yml
│
├── caches/                          # Cache file directory
├── data/                            # Data file directory
│   ├── data.json
│   └── data_template.json
├── scripts/                         # Script directory
│   └── fingerprint-injector.js      # Browser fingerprint injection script
│
├── src/                             # Backend source code directory
│   ├── server.js                    # Main server file
│   ├── start.js                     # Smart start script (automatically determines single/multi-process)
│   ├── config/
│   │   └── index.js                 # Configuration file
│   ├── controllers/                 # Controllers directory
│   │   ├── chat.js                  # Chat controller
│   │   ├── chat.image.video.js      # Image/video generation controller
│   │   ├── cli.chat.js              # CLI chat controller
│   │   └── models.js                # Models controller
│   ├── middlewares/                 # Middlewares directory
│   │   ├── authorization.js         # Authorization middleware
│   │   └── chat-middleware.js       # Chat middleware
│   ├── models/                      # Models directory
│   │   └── models-map.js            # Model mapping configuration
│   ├── routes/                      # Routes directory
│   │   ├── accounts.js              # Account routes
│   │   ├── chat.js                  # Chat routes
│   │   ├── cli.chat.js              # CLI chat routes
│   │   ├── models.js                # Model routes
│   │   ├── settings.js              # Settings routes
│   │   └── verify.js                # Verification routes
│   └── utils/                       # Utility functions directory
│       ├── account-rotator.js       # Account rotator
│       ├── account.js               # Account management
│       ├── chat-helpers.js          # Chat helper functions
│       ├── cli.manager.js           # CLI manager
│       ├── cookie-generator.js      # Cookie generator
│       ├── data-persistence.js      # Data persistence
│       ├── fingerprint.js           # Browser fingerprint generation
│       ├── img-caches.js            # Image cache
│       ├── logger.js                # Logging utility
│       ├── precise-tokenizer.js     # Precise tokenizer
│       ├── proxy-helper.js          # Proxy helper functions
│       ├── redis.js                 # Redis connection
│       ├── request.js               # HTTP request wrapper
│       ├── setting.js               # Setting management
│       ├── ssxmod-manager.js        # Ssxmod parameter management
│       ├── token-manager.js         # Token manager
│       ├── tools.js                 # Tool calling processing
│       └── upload.js                # File upload
│
└── public/                          # Frontend project directory
    ├── dist/                        # Compiled frontend files
    │   ├── assets/                  # Static resources
    │   ├── favicon.png
    │   └── index.html
    ├── src/                         # Frontend source code
    │   ├── App.vue                  # Main application component
    │   ├── main.js                  # Entry file
    │   ├── style.css                # Global styles
    │   ├── assets/                  # Static resources
    │   │   └── background.mp4
    │   ├── routes/                  # Route configuration
    │   │   └── index.js
    │   └── views/                   # Page components
    │       ├── auth.vue             # Authentication page
    │       ├── dashboard.vue        # Dashboard page
    │       └── settings.vue         # Settings page
    ├── package.json                 # Frontend dependency configuration
    ├── package-lock.json
    ├── index.html                   # Frontend entry HTML
    ├── postcss.config.js            # PostCSS configuration
    ├── tailwind.config.js           # TailwindCSS configuration
    ├── vite.config.js               # Vite build configuration
    └── public/                      # Public static resources
        └── favicon.png
```

## 📖 API Documentation

### 🔐 API Authentication Description

This API supports multi-key authentication mechanism. All API requests require a valid API key in the request header:

```http
Authorization: Bearer sk-your-api-key
```

**Supported Key Types:**
- **Admin Key**: First configured API_KEY, has full permissions
- **Regular Key**: Other configured API_KEYs, API calls only

**Authentication Example:**
```bash
# Using admin key
curl -H "Authorization: Bearer sk-admin123" http://localhost:3000/v1/models

# Using regular key
curl -H "Authorization: Bearer sk-user456" http://localhost:3000/v1/chat/completions
```

### 🔍 Get Model List

Get the list of all available AI models.

```http
GET /v1/models
Authorization: Bearer sk-your-api-key
```

```http
GET /models (no authentication required)
```

**Description:**
- [id](file://d:\Code\Qwen2API\backend\api\admin.py#L26-L26): Recommended to use directly as [model](file://d:\Code\Qwen2API\src\controllers\anthropic.js#L238-L238) in requests, prioritizing more readable model names
- [name](file://d:\Code\Qwen2API\backend\api\admin.py#L27-L27): Upstream original model ID, convenient for official interfaces or logs reference
- `upstream_id`: Upstream model ID without capability suffix
- `display_name`: Display name without capability suffix
- When `SIMPLE_MODEL_MAP=false`, additionally returns capability variants like `-thinking`, `-search`, `-image`, `-video`, `-image-edit`, etc.

**Response Example:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "Qwen3-Omni-Flash-image",
      "name": "qwen3-omni-flash-2025-12-01-image",
      "upstream_id": "qwen3-omni-flash-2025-12-01",
      "display_name": "Qwen3-Omni-Flash",
      "object": "model",
      "created": 1677610602,
      "owned_by": "qwen"
    }
  ]
}
```

### 💬 Chat Conversation

Send chat messages and get AI responses.

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

**Request Body:**
```json
{
  "model": "Qwen3.6-Plus",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "Hello, please introduce yourself."
    }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2000
}
```

**Response Example:**
```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "qwen3.6-plus",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! I am an AI assistant..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 50,
    "total_tokens": 70
  }
}
```

### 🛠️ Function Calling

`/v1/chat/completions` supports the complete OpenAI Function Calling protocol. Even if the upstream web interface doesn't have native tools capability, this service makes its behavior consistent with OpenAI API through prompt injection and streaming state machine parsing:

- Automatically compresses `tools[]` into TS-style signatures injected into prompts, saving about 70% token overhead
- Streaming output follows OpenAI specification: first sends `function.name + empty arguments` header block, followed by multiple `arguments` slices
- `assistant.tool_calls` and `role:"tool"` in historical messages automatically fold back in chain, `tool_call_id` precisely associated
- `tool_choice` all four states: `"auto"` / `"required"` / `{type:"function",function:{name:"..."}}` / `"none"`
- When `tool_choice="required"` or specifying function, if no tool call triggered initially, automatically appends strong constraint prompt for retry once

**Request Example:**

```json
{
  "model": "qwen3-coder-plus",
  "stream": true,
  "messages": [
    {"role": "user", "content": "Check Beijing's weather"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get city weather",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "required"
}
```

**Streaming Response (excerpt):**

```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":\"Beijing\"}"}}]}}]}

data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

OpenAI SDK, LangChain, Cline, Continue, and other clients following OpenAI tool protocols can be directly integrated.

### 🤖 Anthropic Messages API

Provides an **Anthropic-compatible bridge** for the `/v1/messages` endpoint, allowing direct use with common clients such as Claude Code, the Anthropic SDK, and aider.

> Note: Qwen2API is a compatibility bridge, not an Anthropic-equivalent backend. For unsupported fields, the current strategy is intentionally **permissive**: the request is accepted whenever possible, and important unsupported fields are surfaced through response headers and server logs instead of being silently ignored. Fields such as `system`, multi-turn `messages`, `tools`, `tool_choice`, and `thinking` are currently **approximate compatibility**, not native Anthropic semantics.

```http
POST /v1/messages
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

**Compatibility matrix:**

| Field / capability | Status | Current behavior | Notes / client impact |
|---|---|---|---|
| `model` | Supported | Mapped to a Qwen model name | Any resolvable Qwen model ID can be used |
| `messages.text` | Supported | Supports basic text messages | Standard chat clients work |
| `messages.image` | Supported | Supports image blocks and translates them into the internal image format | Suitable for common multimodal clients |
| `messages.tool_use` | Partial | Accepts Anthropic-style `tool_use` history blocks, then translates/folds them internally | Not native upstream tool-call semantics |
| `messages.tool_result` | Partial | Accepts `tool_result` and converts it into bridge-layer tool-result text | Details such as `is_error` are not guaranteed to be preserved |
| `system` | Partial | Merged into the prompt prefix | Not preserved as a native upstream system layer |
| `messages` (multi-turn) | Partial | Multi-turn history is compacted / translated | Structured conversation semantics are approximate |
| `tools[]` | Partial | Supports the basic `{name,input_schema,description}` shape | Implemented through prompt/XML simulation, not native upstream tool execution |
| `tool_choice` | Partial | Supports the basic `auto` / `any` / `tool` / `none` modes | Relies on prompt steering and retry hints, not an upstream hard guarantee |
| `thinking` | Partial | Currently accepts legacy `thinking: {type:"enabled", budget_tokens:N}` and maps it approximately | Not equivalent to Anthropic's newer adaptive thinking / effort semantics |
| `stream` | Supported | Returns an Anthropic-style SSE event sequence | Suitable for Claude Code and other streaming clients |
| `max_tokens` | Ignored with warning | Currently does not enforce an upstream output limit | Exposed through warning headers / logs |
| `stop_sequences` | Ignored with warning | Not currently mapped to upstream stop behavior | Exposed through warning headers / logs |
| `metadata` | Ignored with warning | Not used in the upstream request | Exposed through warning headers / logs |
| `temperature` / `top_p` / `top_k` | Ignored with warning | Not currently mapped to upstream sampling controls | Exposed through warning headers / logs |
| `service_tier` | Ignored with warning | Not supported | Exposed through warning headers / logs |
| `container` | Ignored with warning | Not supported | Exposed through warning headers / logs |
| `output_config` | Ignored with warning | Does not currently support official structured outputs / effort semantics | Exposed through warning headers / logs |
| `mcp_servers` | Not supported yet | Anthropic MCP runtime semantics are not supported | Currently surfaced as a risk warning; a later version may convert this into an explicit error |
| `context_management` | Not supported yet | Official compaction / context-editing semantics are not supported | Currently surfaced as a risk warning; a later version may convert this into an explicit error |

When a request includes approximate or unsupported fields, the response may include these headers:

- `X-Qwen2API-Anthropic-Compatibility`
- `X-Qwen2API-Anthropic-Warnings`

These headers indicate which Anthropic capabilities are **Partial** and which fields were **Ignored with warning**. They do not change the basic successful response body shape.

**Request Example (with tool calling):**

```json
{
  "model": "qwen3-coder-plus",
  "max_tokens": 1024,
  "messages": [
    {"role": "user", "content": "Check Guangzhou weather"}
  ],
  "tools": [
    {
      "name": "get_weather",
      "input_schema": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }
  ],
  "tool_choice": { "type": "any" }
}
```

> Note: `max_tokens` is accepted in the example above, but it is currently **Ignored with warning** and does not enforce an upstream output limit the way the official Anthropic API does.

**Non-streaming Response:**

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "model": "qwen3-coder-plus",
  "content": [
    {
      "type": "tool_use",
      "id": "call_xxx",
      "name": "get_weather",
      "input": { "city": "Guangzhou" }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": { "input_tokens": 233, "output_tokens": 25 }
}
```

**Streaming SSE Event Sequence:**

```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_xxx","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"Guangzhou\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":234,"output_tokens":25}}

event: message_stop
data: {"type":"message_stop"}
```

### 🎨 Image and Video Generation

Currently supports two calling methods:
- Using `/v1/chat/completions` + model suffix: `-image`, `-image-edit`, `-video`
- Using OpenAI-style resource endpoints: `/v1/images/generations`, `/v1/images/edits`, `/v1/videos`

In the following examples, please refer to the `id` field returned by `/v1/models` for model names.

#### Method One: Through `/v1/chat/completions`

Text-to-image:

```json
{
  "model": "Qwen3-Omni-Flash-image",
  "messages": [
    {
      "role": "user",
      "content": "Draw a kitten playing in the garden, cartoon style"
    }
  ],
  "size": "1:1",
  "stream": false
}
```

Image editing:

```json
{
  "model": "Qwen3-Omni-Flash-image-edit",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Change this image to light blue tech style poster"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,..."
          }
        }
      ]
    }
  ],
  "stream": false
}
```

Video generation:

```json
{
  "model": "Qwen3-Omni-Flash-video",
  "messages": [
    {
      "role": "user",
      "content": "Generate a 3-second night scene time-lapse video, city street neon lights flickering"
    }
  ],
  "size": "9:16",
  "stream": false
}
```

**Supported Size Parameters:**
- Image/video generation under `/v1/chat/completions` supports `1:1`, `4:3`, `3:4`, `16:9`, `9:16`
- `/v1/images/generations`, `/v1/images/edits`, `/v1/videos` compatible with `1024x1024`, `1536x1024`, `1024x1536`, `1792x1024`, `1024x1792`

#### Method Two: OpenAI-Style Resource Endpoints

Image generation:

```http
POST /v1/images/generations
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

```json
{
  "model": "Qwen3-Omni-Flash",
  "prompt": "An orange cat sitting on a wooden table looking at the camera, realistic style",
  "size": "1024x1024",
  "response_format": "url"
}
```

Image editing:

```http
POST /v1/images/edits
Content-Type: multipart/form-data
Authorization: Bearer sk-your-api-key
```

Form fields:
- [model](file://d:\Code\Qwen2API\src\controllers\anthropic.js#L238-L238): Optional, automatically selects default model supporting image editing when not passed
- [prompt](file://d:\Code\Qwen2API\backend\api\anthropic.py#L0-L0): Optional, defaults to "Please complete the edit based on the uploaded image"
- [image](file://d:\Code\Qwen2API\src\utils\upload.js#L20-L20): Required, supports multipart file upload, also supports JSON string form of image URL/data URI
- [size](file://d:\Code\Qwen2API\backend\services\chat_id_pool.py#L180-L182): Optional, supports OpenAI-style size notation
- `response_format`: Optional, supports [url](file://d:\Code\Qwen2API\src\utils\request.js#L81-L81), `b64_json`

Video generation:

```http
POST /v1/videos
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

```json
{
  "model": "Qwen3-Omni-Flash",
  "prompt": "A brief 3-second night scene time-lapse video, city street neon lights flickering",
  "size": "1024x1792"
}
```

Image generation response example:

```json
{
  "created": 1776126402,
  "data": [
    {
      "url": "https://cdn.qwenlm.ai/output/example/generated-image.png"
    }
  ]
}
```

Video generation response example:

```json
{
  "id": "video_1776126509490",
  "object": "video",
  "created": 1776126509,
  "model": "qwen3-omni-flash-2025-12-01",
  "status": "completed",
  "data": [
    {
      "url": "https://cdn.qwenlm.ai/output/example/generated-video.mp4"
    }
  ]
}
```

### 🎯 Advanced Features

#### 🔍 Smart Search Mode

Append `-search` suffix to model name to enable search functionality:

```json
{
  "model": "Qwen3.6-Plus-search",
  "messages": [...]
}
```

#### 🧠 Reasoning Mode

Append `-thinking` suffix to model name to enable thinking process output:

```json
{
  "model": "Qwen3.6-Plus-thinking",
  "messages": [...]
}
```

#### 🔍🧠 Combined Mode

Enable both search and reasoning functionality simultaneously:

```json
{
  "model": "Qwen3.6-Plus-thinking-search",
  "messages": [...]
}
```

#### 🖼️ Multimodal Support

API automatically handles image and video uploads, supports sending image/video URLs or Base64 data URIs in conversations.

Image understanding example:

```json
{
  "model": "Qwen3.5-Omni-Plus",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What's in this picture?"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,..."
          }
        }
      ]
    }
  ]
}
```

Video understanding example:

```json
{
  "model": "Qwen3.5-Omni-Plus",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Describe this video in one sentence"
        },
        {
          "type": "input_video",
          "input_video": {
            "url": "data:video/mp4;base64,..."
          }
        }
      ]
    }
  ]
}
```

Supported video fields:
- `input_video`
- `video_url`
- `video`

### 🖥️ CLI Endpoint

CLI endpoint accesses using Qwen Code / Qwen Cli's OAuth token, supports 256K context and tool calling (Function Calling).

**Supported Models:**

| Model ID | Description |
|---------|-------------|
| `qwen3-coder-plus` | Qwen3 Coder Plus |
| `qwen3-coder-flash` | Qwen3 Coder Flash (faster speed) |
| `coder-model` | Qwen 3.5 Plus (with reasoning chain, 256K context) |
| `qwen3.5-plus` | Alias for `coder-model`, automatic redirect |

#### 💬 CLI Chat Conversation

Send chat requests through CLI endpoint, supports streaming and non-streaming responses.

```http
POST /cli/v1/chat/completions
Content-Type: application/json
Authorization: Bearer API_KEY
```

**Request Body:**
```json
{
  "model": "qwen3-coder-plus",
  "messages": [
    {
      "role": "user",
      "content": "Hello, please introduce yourself."
    }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2000
}
```

Using `coder-model` (i.e., Qwen 3.5 Plus) or its alias `qwen3.5-plus`:
```json
{
  "model": "coder-model",
  "messages": [
    {
      "role": "user",
      "content": "Write a quick sort algorithm."
    }
  ],
  "stream": false
}
```

**Streaming Request:**
```json
{
  "model": "qwen3-coder-flash",
  "messages": [
    {
      "role": "user",
      "content": "Write a poem about spring."
    }
  ],
  "stream": true
}
```

**Response Format:**

Non-streaming response is the same as standard OpenAI API format:
```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "qwen3-coder-plus",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! I am an AI assistant..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 50,
    "total_tokens": 70
  }
}
```

Streaming response uses Server-Sent Events (SSE) format:
```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"qwen3-coder-flash","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"qwen3-coder-flash","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: [DONE]
```

---

## ⚠️ Disclaimer

1. This project is for learning and communication purposes only, **strictly prohibited for any commercial use**.
2. All consequences arising from the use of this project are borne by the user, and the project developer assumes no responsibility.
3. This project does not guarantee the service availability or stability of `chat.qwen.ai` and `Qwen Code / Qwen Cli`.
4. Users should comply with laws and regulations in their respective regions, as well as Tongyi Qianwen's terms of service and usage policies.
5. For infringement, please contact the author for deletion.

## 🚫 Commercial Use Prohibited

This project uses a **personal learning and research only** license:

- Prohibited from using this project or its derivatives for any commercial purposes, including but not limited to: selling, renting, providing paid services, embedding in commercial products, etc.
- Prohibited from using this project to perform any actions that violate Tongyi Qianwen's terms of service.
- Prohibited from using this project for large-scale automated calls, malicious attacks, or abuse of upstream services.
