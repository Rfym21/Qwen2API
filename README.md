<div align="center">

> [中文](README.md) | [🇷🇺 Русская версия](README-ru.md) | [English](README-en.md)

# 🚀 Qwen-Proxy

[![Version](https://img.shields.io/badge/version-2026.04.29.23.45-blue.svg)](https://github.com/Rfym21/Qwen2API)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-supported-blue.svg)](https://hub.docker.com/r/rfym21/qwen2api)

[🔗 加入交流群](https://t.me/nodejs_project) | [📖 文档](#api-文档) | [🐳 Docker 部署](#docker-部署)

</div>

## 🛠️ 快速开始

### 项目说明

Qwen-Proxy 是一个将 `https://chat.qwen.ai` 和 `Qwen Code / Qwen Cli` 转换为 OpenAI 兼容 API 的代理服务。通过本项目，您只需要一个账户，即可以使用任何支持 OpenAI API 的客户端（如 ChatGPT-Next-Web、LobeChat 等）来调用 `https://chat.qwen.ai` 和 `Qwen Code / Qwen Cli`的各种模型。其中 `/cli` 端点下的模型由 `Qwen Code / Qwen Cli` 提供，支持256k上下文，原生 tools 参数支持

**主要特性：**
- 兼容 OpenAI API 格式，无缝对接各类客户端
- 兼容 Anthropic Messages API（`/v1/messages`），支持 Claude Code、Anthropic SDK 等客户端
- 支持 Function Calling（OpenAI `tools` / Anthropic `tools`），含流式 `arguments` 增量分片与 `tool_choice=required` 强校验重试
- 支持多账户轮询，提高可用性
- 支持流式/非流式响应
- 支持多模态（图片识别、视频理解、图片/视频生成）
- 支持 OpenAI 风格资源端点：`/v1/images/generations`、`/v1/images/edits`、`/v1/videos`
- 支持智能搜索、深度思考等高级功能
- 支持 CLI 端点，提供 256K 上下文和工具调用能力
- 提供 Web 管理界面，方便配置和监控
- 批量添加账号支持实时进度展示，可在系统设置中调整登录并发数

### 🌐 账号级代理 / Per-account proxy

每个账号可以配置自己专属的出站代理，从而让多个账号通过不同的 IP 同时使用，规避 `chat.qwen.ai` 基于 IP 的关联封禁。

**优先级：** `account.proxy` > 全局 `PROXY_URL` > 不使用代理

**支持的代理协议：** HTTP / HTTPS / SOCKS5（与 `PROXY_URL` 一致）

**前端配置（推荐）：**
打开管理面板 → 添加账号时填写 "代理地址" 字段，或在已有账号卡片上点击 "修改代理" 按钮。

**ENV 配置（DATA_SAVE_MODE=none）：**

```bash
# 旧格式（向后兼容，账号级代理留空）
ACCOUNTS=user1@mail.com:pass1,user2@mail.com:pass2

# 新格式（用 | 分隔代理 URL，可与旧格式混用）
ACCOUNTS=user1@mail.com:pass1|http://10.0.0.1:8080,user2@mail.com:pass2|socks5://10.0.0.2:1080
```

**file 模式 (`data/data.json`) schema：**

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

`proxy` 字段为 `null` 或缺失时，账号回退到全局 `PROXY_URL`（若配置）。

> ⚠️ **注意：** 接口返回的代理 URL 不做脱敏处理。本项目假设运行在受信任的本地或私有网络环境中，由单一管理员使用。

### 环境要求

- Node.js 18+ (源码部署时需要)
- Docker (可选)
- Redis (可选，用于数据持久化)

### ⚙️ 环境配置

创建 `.env` 文件并配置以下参数：

```bash
# 🌐 服务配置
LISTEN_ADDRESS=localhost       # 监听地址
SERVICE_PORT=3000             # 服务端口

# 🔐 安全配置
API_KEY=sk-123456,sk-456789   # API 密钥 (必填，支持多密钥)
ACCOUNTS=                     # 账户配置 (格式: user1:pass1[|proxy_url],user2:pass2[|proxy_url])

# 🚀 PM2 多进程配置
PM2_INSTANCES=1               # PM2进程数量 (1/数字/max)
PM2_MAX_MEMORY=1G             # PM2内存限制 (100M/1G/2G等)
                              # 注意: PM2集群模式下所有进程共用同一个端口

# 🔍 功能配置
SEARCH_INFO_MODE=table        # 搜索信息展示模式 (table/text)
OUTPUT_THINK=true             # 是否输出思考过程 (true/false)
SIMPLE_MODEL_MAP=false        # 简化模型映射 (true/false)

# 🌐 代理与反代配置
QWEN_CHAT_PROXY_URL=          # 自定义 Chat API 反代URL (默认: https://chat.qwen.ai)
QWEN_CLI_PROXY_URL=           # 自定义 CLI API 反代URL (默认: https://portal.qwen.ai)
PROXY_URL=                    # HTTP/HTTPS/SOCKS5 代理地址 (例如: http://127.0.0.1:7890)

# 🗄️ 数据存储
DATA_SAVE_MODE=none           # 数据保存模式 (none/file/redis)
REDIS_URL=                    # Redis 连接地址 (可选，使用TLS时为rediss://)
BATCH_LOGIN_CONCURRENCY=5     # 批量添加账号时的登录并发数

# 📸 缓存配置
CACHE_MODE=default            # 图片缓存模式 (default/file)
```

#### 📋 配置说明

| 参数 | 说明 | 示例 |
|------|------|------|
| `LISTEN_ADDRESS` | 服务监听地址 | `localhost` 或 `0.0.0.0` |
| `SERVICE_PORT` | 服务运行端口 | `3000` |
| `API_KEY` | API 访问密钥，支持多密钥配置。第一个为管理员密钥（可访问前端管理页面），其他为普通密钥（仅可调用API）。多个密钥用逗号分隔 | `sk-admin123,sk-user456,sk-user789` |
| `PM2_INSTANCES` | PM2进程数量 | `1`/`4`/`max` |
| `PM2_MAX_MEMORY` | PM2内存限制 | `100M`/`1G`/`2G` |
| `SEARCH_INFO_MODE` | 搜索结果展示格式 | `table` 或 `text` |
| `OUTPUT_THINK` | 是否显示 AI 思考过程 | `true` 或 `false` |
| `SIMPLE_MODEL_MAP` | 简化模型映射，只返回基础模型不包含变体 | `true` 或 `false` |
| `QWEN_CHAT_PROXY_URL` | 自定义 Chat API 反代地址 | `https://your-proxy.com` |
| `QWEN_CLI_PROXY_URL` | 自定义 CLI API 反代地址 | `https://your-cli-proxy.com` |
| `PROXY_URL` | 出站请求代理地址，支持 HTTP/HTTPS/SOCKS5 | `http://127.0.0.1:7890` |
| `DATA_SAVE_MODE` | 数据持久化方式 | `none`/`file`/`redis` |
| `REDIS_URL` | Redis 数据库连接地址，使用TLS加密时需使用 `rediss://` 协议 | `redis://localhost:6379` 或 `rediss://xxx.upstash.io` |
| `BATCH_LOGIN_CONCURRENCY` | 批量添加账号时的登录并发数，可在前端系统设置中动态调整 | `5` |
| `CACHE_MODE` | 图片缓存存储方式 | `default`/`file` |
| `LOG_LEVEL` | 日志级别 | `DEBUG`/`INFO`/`WARN`/`ERROR` |
| `ENABLE_FILE_LOG` | 是否启用文件日志 | `true` 或 `false` |
| `LOG_DIR` | 日志文件目录 | `./logs` |
| `MAX_LOG_FILE_SIZE` | 最大日志文件大小(MB) | `10` |
| `MAX_LOG_FILES` | 保留的日志文件数量 | `5` |

> 💡 **提示**: 可以在 [Upstash](https://upstash.com/) 免费创建 Redis 实例，使用 TLS 协议时地址格式为 `rediss://...`
<div>
<img src="./docs/images/upstash.png" alt="Upstash Redis" width="600">
</div>

#### 🔑 多API_KEY配置说明

`API_KEY` 环境变量支持配置多个API密钥，用于实现不同权限级别的访问控制：

**配置格式:**
```bash
# 单个密钥（管理员权限）
API_KEY=sk-admin123

# 多个密钥（第一个为管理员，其他为普通用户）
API_KEY=sk-admin123,sk-user456,sk-user789
```

**权限说明:**

| 密钥类型 | 权限范围 | 功能描述 |
|----------|----------|----------|
| **管理员密钥** | 完整权限 | • 访问前端管理页面<br>• 修改系统设置<br>• 调用所有API接口<br>• 添加/删除普通密钥 |
| **普通密钥** | API调用权限 | • 仅可调用API接口<br>• 无法访问前端管理页面<br>• 无法修改系统设置 |

**使用场景:**
- **团队协作**: 为不同团队成员分配不同权限的API密钥
- **应用集成**: 为第三方应用提供受限的API访问权限
- **安全隔离**: 将管理权限与普通使用权限分离

**注意事项:**
- 第一个API_KEY自动成为管理员密钥，拥有最高权限
- 管理员可以通过前端页面动态添加或删除普通密钥
- 所有密钥都可以正常调用API接口，权限差异仅体现在管理功能上

#### 📸 CACHE_MODE 缓存模式说明

`CACHE_MODE` 环境变量控制图片缓存的存储方式，用于优化图片上传和处理性能：

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `default` | 内存缓存模式 (默认) | 单进程部署，重启后缓存丢失 |
| `file` | 文件缓存模式 | 多进程部署，缓存持久化到 `./caches/` 目录 |

**推荐配置:**
- **单进程部署**: 使用 `CACHE_MODE=default`，性能最佳
- **多进程/集群部署**: 使用 `CACHE_MODE=file`，确保进程间缓存共享
- **Docker 部署**: 建议使用 `CACHE_MODE=file` 并挂载 `./caches` 目录

**文件缓存目录结构:**
```
caches/
├── [signature1].txt    # 缓存文件，包含图片URL
├── [signature2].txt
└── ...
```

---

## 🚀 部署方式

### 🐳 Docker 部署

#### 方式一：直接运行

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

#### 方式二：Docker Compose

```bash
# 下载配置文件
curl -o docker-compose.yml https://raw.githubusercontent.com/Rfym21/Qwen2API/refs/heads/main/docker/docker-compose.yml

# 启动服务
docker compose pull && docker compose up -d
```

### 📦 本地部署

```bash
# 克隆项目
git clone https://github.com/Rfym21/Qwen2API.git
cd Qwen2API

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 文件

# 智能启动 (推荐 - 自动判断单进程/多进程)
npm start

# 开发模式
npm run dev
```

### 🚀 PM2 多进程部署

使用 PM2 进行生产环境多进程部署，提供更好的性能和稳定性。

**重要说明**: PM2 集群模式下，所有进程共用同一个端口，PM2 会自动进行负载均衡。

### 🤖 智能启动模式

使用 `npm start` 可以自动判断启动方式：

- 当 `PM2_INSTANCES=1` 时，使用单进程模式
- 当 `PM2_INSTANCES>1` 时，使用 Node.js 集群模式
- 自动限制进程数不超过 CPU 核心数

### ☁️ Hugging Face 部署

快速部署到 Hugging Face Spaces：

[![Deploy to Hugging Face](https://img.shields.io/badge/🤗%20Hugging%20Face-Deploy-yellow)](https://huggingface.co/spaces/devme/q2waepnilm)

<div>
<img src="./docs/images/hf.png" alt="Hugging Face Deployment" width="600">
</div>

### ☁️ Vercel 部署

快速部署到 Vercel：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FRfym21%2FQwen2API)

需要配置环境变量：
```
ACCOUNTS=email:password
SERVICE_PORT=80
API_KEY=sk-xxx
DATA_SAVE_MODE=none
```


---

## 📁 项目结构

```
Qwen2API/
├── README.md
├── ecosystem.config.js              # PM2配置文件
├── package.json
│
├── docker/                          # Docker配置目录
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── docker-compose-redis.yml
│
├── caches/                          # 缓存文件目录
├── data/                            # 数据文件目录
│   ├── data.json
│   └── data_template.json
├── scripts/                         # 脚本目录
│   └── fingerprint-injector.js      # 浏览器指纹注入脚本
│
├── src/                             # 后端源代码目录
│   ├── server.js                    # 主服务器文件
│   ├── start.js                     # 智能启动脚本 (自动判断单进程/多进程)
│   ├── config/
│   │   └── index.js                 # 配置文件
│   ├── controllers/                 # 控制器目录
│   │   ├── chat.js                  # 聊天控制器
│   │   ├── chat.image.video.js      # 图片/视频生成控制器
│   │   ├── cli.chat.js              # CLI聊天控制器
│   │   └── models.js                # 模型控制器
│   ├── middlewares/                 # 中间件目录
│   │   ├── authorization.js         # 授权中间件
│   │   └── chat-middleware.js       # 聊天中间件
│   ├── models/                      # 模型目录
│   │   └── models-map.js            # 模型映射配置
│   ├── routes/                      # 路由目录
│   │   ├── accounts.js              # 账户路由
│   │   ├── chat.js                  # 聊天路由
│   │   ├── cli.chat.js              # CLI聊天路由
│   │   ├── models.js                # 模型路由
│   │   ├── settings.js              # 设置路由
│   │   └── verify.js                # 验证路由
│   └── utils/                       # 工具函数目录
│       ├── account-rotator.js       # 账户轮询器
│       ├── account.js               # 账户管理
│       ├── chat-helpers.js          # 聊天辅助函数
│       ├── cli.manager.js           # CLI管理器
│       ├── cookie-generator.js      # Cookie生成器
│       ├── data-persistence.js      # 数据持久化
│       ├── fingerprint.js           # 浏览器指纹生成
│       ├── img-caches.js            # 图片缓存
│       ├── logger.js                # 日志工具
│       ├── precise-tokenizer.js     # 精确分词器
│       ├── proxy-helper.js          # 代理辅助函数
│       ├── redis.js                 # Redis连接
│       ├── request.js               # HTTP请求封装
│       ├── setting.js               # 设置管理
│       ├── ssxmod-manager.js        # ssxmod参数管理
│       ├── token-manager.js         # Token管理器
│       ├── tools.js                 # 工具调用处理
│       └── upload.js                # 文件上传
│
└── public/                          # 前端项目目录
    ├── dist/                        # 编译后的前端文件
    │   ├── assets/                  # 静态资源
    │   ├── favicon.png
    │   └── index.html
    ├── src/                         # 前端源代码
    │   ├── App.vue                  # 主应用组件
    │   ├── main.js                  # 入口文件
    │   ├── style.css                # 全局样式
    │   ├── assets/                  # 静态资源
    │   │   └── background.mp4
    │   ├── routes/                  # 路由配置
    │   │   └── index.js
    │   └── views/                   # 页面组件
    │       ├── auth.vue             # 认证页面
    │       ├── dashboard.vue        # 仪表板页面
    │       └── settings.vue         # 设置页面
    ├── package.json                 # 前端依赖配置
    ├── package-lock.json
    ├── index.html                   # 前端入口HTML
    ├── postcss.config.js            # PostCSS配置
    ├── tailwind.config.js           # TailwindCSS配置
    ├── vite.config.js               # Vite构建配置
    └── public/                      # 公共静态资源
        └── favicon.png
```

## 📖 API 文档

### 🔐 API 认证说明

本API支持多密钥认证机制，所有API请求都需要在请求头中包含有效的API密钥：

```http
Authorization: Bearer sk-your-api-key
```

**支持的密钥类型:**
- **管理员密钥**: 第一个配置的API_KEY，拥有完整权限
- **普通密钥**: 其他配置的API_KEY，仅可调用API接口

**认证示例:**
```bash
# 使用管理员密钥
curl -H "Authorization: Bearer sk-admin123" http://localhost:3000/v1/models

# 使用普通密钥
curl -H "Authorization: Bearer sk-user456" http://localhost:3000/v1/chat/completions
```

### 🔍 获取模型列表

获取所有可用的 AI 模型列表。

```http
GET /v1/models
Authorization: Bearer sk-your-api-key
```

```http
GET /models (免认证)
```

**说明:**
- `id`: 推荐直接作为请求里的 `model` 使用，优先展示更易读的模型名称
- `name`: 上游原始模型 ID，便于与官方接口或日志对照
- `upstream_id`: 不带能力后缀的上游模型 ID
- `display_name`: 不带能力后缀的展示名
- 当 `SIMPLE_MODEL_MAP=false` 时，会额外返回 `-thinking`、`-search`、`-image`、`-video`、`-image-edit` 等能力变体

**响应示例:**
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

### 💬 聊天对话

发送聊天消息并获取 AI 回复。

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

**请求体:**
```json
{
  "model": "Qwen3.6-Plus",
  "messages": [
    {
      "role": "system",
      "content": "你是一个有用的助手。"
    },
    {
      "role": "user",
      "content": "你好，请介绍一下自己。"
    }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2000
}
```

**响应示例:**
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
        "content": "你好！我是一个AI助手..."
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

### 🛠️ Function Calling（工具调用）

`/v1/chat/completions` 支持完整的 OpenAI Function Calling 协议。即便上游 Web 接口本身不具备原生 tools 能力，本服务通过提示词注入与流式状态机解析，使其行为与 OpenAI API 一致：

- 自动将 `tools[]` 压缩为 TS 风格签名注入提示词，节省约 70% token 开销
- 流式输出按 OpenAI 规范分片：先发 `function.name + 空 arguments` 头块，随后多个 `arguments` 切片
- 历史消息中的 `assistant.tool_calls` 与 `role:"tool"` 自动折叠回链，`tool_call_id` 精确关联
- `tool_choice` 全四态：`"auto"` / `"required"` / `{type:"function",function:{name:"..."}}` / `"none"`
- `tool_choice="required"` 或指定函数时，若首次未触发工具调用，自动追加强约束提示重试一次

**请求示例：**

```json
{
  "model": "qwen3-coder-plus",
  "stream": true,
  "messages": [
    {"role": "user", "content": "查一下北京的天气"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "获取城市天气",
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

**流式响应（节选）：**

```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":\"Beijing\"}"}}]}}]}

data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

OpenAI SDK、LangChain、Cline、Continue 等遵循 OpenAI 工具协议的客户端可直接接入。

### 🤖 Anthropic Messages API

提供 **Anthropic-compatible bridge** 的 `/v1/messages` 端点，可直接对接 Claude Code、Anthropic SDK、aider 等常见客户端。

> 说明：Qwen2API 是兼容桥接层，不是 Anthropic 官方等价实现。对未支持字段，本项目当前采用**尽量宽松**的策略：尽可能接受请求，并通过响应头与服务端日志显式提示，而不是继续静默忽略。对 `system`、多轮 `messages`、`tools`、`tool_choice`、`thinking` 等字段，当前为**近似兼容**，并非官方原生语义。

```http
POST /v1/messages
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

**兼容矩阵：**

| 字段 / 能力 | 状态 | 当前行为 | 备注 / 客户端影响 |
|---|---|---|---|
| `model` | Supported | 映射到 Qwen 模型名 | 可用任意可解析的 Qwen 模型 ID |
| `messages.text` | Supported | 支持基础文本消息 | 基础聊天可用 |
| `messages.image` | Supported | 支持图片块并转译到内部图片格式 | 适合常见多模态客户端 |
| `messages.tool_use` | Partial | 接收 Anthropic 风格 `tool_use` 历史块，但内部会转译并折叠 | 不是上游原生工具调用语义 |
| `messages.tool_result` | Partial | 接收 `tool_result`，内部转为桥接层工具结果文本 | `is_error` 等细节不保证保真 |
| `system` | Partial | 会被合并进提示前缀 | 不是独立的原生 system 层 |
| `messages`（多轮） | Partial | 多轮历史会被压缩/转译 | 结构化上下文语义为近似兼容 |
| `tools[]` | Partial | 支持基础 `{name,input_schema,description}` | 通过 prompt/XML 模拟，不是原生 upstream tool execution |
| `tool_choice` | Partial | 支持 `auto` / `any` / `tool` / `none` 基础形态 | 依赖提示词与 retry hint，不是上游强保证 |
| `thinking` | Partial | 当前接受旧式 `thinking: {type:"enabled", budget_tokens:N}` 并近似映射 | 不等价官方新式 adaptive thinking / effort 语义 |
| `stream` | Supported | 返回 Anthropic 风格 SSE 事件序列 | 适合 Claude Code 等流式客户端 |
| `max_tokens` | Ignored with warning | 当前不会真实限制上游输出 | 会通过 warning headers / logs 显式提示 |
| `stop_sequences` | Ignored with warning | 当前未映射到上游停止序列 | 会通过 warning headers / logs 显式提示 |
| `metadata` | Ignored with warning | 当前不参与上游请求 | 会通过 warning headers / logs 显式提示 |
| `temperature` / `top_p` / `top_k` | Ignored with warning | 当前不参与上游采样控制 | 会通过 warning headers / logs 显式提示 |
| `service_tier` | Ignored with warning | 当前不支持 | 会通过 warning headers / logs 显式提示 |
| `container` | Ignored with warning | 当前不支持 | 会通过 warning headers / logs 显式提示 |
| `output_config` | Ignored with warning | 当前不支持 structured outputs / effort 等官方语义 | 会通过 warning headers / logs 显式提示 |
| `mcp_servers` | Not supported yet | 当前不支持 Anthropic MCP runtime 语义 | 当前仅提示风险，后续版本可能改为显式报错 |
| `context_management` | Not supported yet | 当前不支持 compaction / context editing 等官方语义 | 当前仅提示风险，后续版本可能改为显式报错 |

当请求包含近似支持或未支持字段时，响应可能带有以下 header：

- `X-Qwen2API-Anthropic-Compatibility`
- `X-Qwen2API-Anthropic-Warnings`

这些 header 用于提示当前请求中哪些 Anthropic 能力是 **Partial**、哪些字段被 **Ignored with warning**，不会改变成功响应 body 的基本结构。

**请求示例（含工具调用）：**

```json
{
  "model": "qwen3-coder-plus",
  "max_tokens": 1024,
  "messages": [
    {"role": "user", "content": "查广州天气"}
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

> 注意：上例中的 `max_tokens` 当前会被接受，但仍属于 **Ignored with warning**，不会像官方 Anthropic API 那样真实约束上游输出。

**非流式响应：**

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
      "input": { "city": "广州" }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": { "input_tokens": 233, "output_tokens": 25 }
}
```

**流式 SSE 事件序列：**

```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_xxx","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"广州\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":234,"output_tokens":25}}

event: message_stop
data: {"type":"message_stop"}
```

### 🎨 图像与视频生成

当前支持两种调用方式：
- 使用 `/v1/chat/completions` + 模型后缀：`-image`、`-image-edit`、`-video`
- 使用 OpenAI 风格资源端点：`/v1/images/generations`、`/v1/images/edits`、`/v1/videos`

以下示例中的模型名请以 `/v1/models` 返回的 `id` 字段为准。

#### 方式一：通过 `/v1/chat/completions`

文本生图：

```json
{
  "model": "Qwen3-Omni-Flash-image",
  "messages": [
    {
      "role": "user",
      "content": "画一只在花园里玩耍的小猫咪，卡通风格"
    }
  ],
  "size": "1:1",
  "stream": false
}
```

图片编辑：

```json
{
  "model": "Qwen3-Omni-Flash-image-edit",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "把这张图片改成浅蓝色科技风海报"
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

视频生成：

```json
{
  "model": "Qwen3-Omni-Flash-video",
  "messages": [
    {
      "role": "user",
      "content": "生成一个 3 秒夜景延时视频，城市街道霓虹灯闪烁"
    }
  ],
  "size": "9:16",
  "stream": false
}
```

**支持的尺寸参数:**
- `/v1/chat/completions` 下的图片/视频生成支持 `1:1`、`4:3`、`3:4`、`16:9`、`9:16`
- `/v1/images/generations`、`/v1/images/edits`、`/v1/videos` 兼容 `1024x1024`、`1536x1024`、`1024x1536`、`1792x1024`、`1024x1792`

#### 方式二：OpenAI 风格资源端点

图像生成：

```http
POST /v1/images/generations
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

```json
{
  "model": "Qwen3-Omni-Flash",
  "prompt": "一只橘猫坐在木桌上看向镜头，写实风格",
  "size": "1024x1024",
  "response_format": "url"
}
```

图像编辑：

```http
POST /v1/images/edits
Content-Type: multipart/form-data
Authorization: Bearer sk-your-api-key
```

表单字段：
- `model`: 可选，不传时自动选择支持图片编辑的默认模型
- `prompt`: 可选，默认为 `请基于上传图片完成编辑`
- `image`: 必填，支持 multipart 文件上传，也支持 JSON 字符串形式的图片 URL / data URI
- `size`: 可选，支持 OpenAI 风格尺寸写法
- `response_format`: 可选，支持 `url`、`b64_json`

视频生成：

```http
POST /v1/videos
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

```json
{
  "model": "Qwen3-Omni-Flash",
  "prompt": "一个简短的 3 秒夜景延时视频，城市街道霓虹灯闪烁",
  "size": "1024x1792"
}
```

图像生成响应示例：

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

视频生成响应示例：

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

### 🎯 高级功能

#### 🔍 智能搜索模式

在模型名称后添加 `-search` 后缀启用搜索功能：

```json
{
  "model": "Qwen3.6-Plus-search",
  "messages": [...]
}
```

#### 🧠 推理模式

在模型名称后添加 `-thinking` 后缀启用思考过程输出：

```json
{
  "model": "Qwen3.6-Plus-thinking",
  "messages": [...]
}
```

#### 🔍🧠 组合模式

同时启用搜索和推理功能：

```json
{
  "model": "Qwen3.6-Plus-thinking-search",
  "messages": [...]
}
```

#### 🖼️ 多模态支持

API 自动处理图片和视频上传，支持在对话中发送图片、视频 URL 或 Base64 data URI。

图片理解示例：

```json
{
  "model": "Qwen3.5-Omni-Plus",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "这张图片里有什么？"
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

视频理解示例：

```json
{
  "model": "Qwen3.5-Omni-Plus",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "请用一句话描述这个视频"
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

支持的视频字段：
- `input_video`
- `video_url`
- `video`

### 🖥️ CLI 端点

CLI 端点使用 Qwen Code / Qwen Cli 的 OAuth 令牌访问，支持 256K 上下文和工具调用（Function Calling）。

**支持的模型：**

| 模型 ID | 说明 |
|---------|------|
| `qwen3-coder-plus` | Qwen3 Coder Plus |
| `qwen3-coder-flash` | Qwen3 Coder Flash（速度更快） |
| `coder-model` | Qwen 3.5 Plus（带思维链，256K 上下文） |
| `qwen3.5-plus` | `coder-model` 的别名，自动重定向 |

#### 💬 CLI 聊天对话

通过 CLI 端点发送聊天请求，支持流式和非流式响应。

```http
POST /cli/v1/chat/completions
Content-Type: application/json
Authorization: Bearer API_KEY
```

**请求体:**
```json
{
  "model": "qwen3-coder-plus",
  "messages": [
    {
      "role": "user",
      "content": "你好，请介绍一下自己。"
    }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2000
}
```

使用 `coder-model`（即 Qwen 3.5 Plus）或其别名 `qwen3.5-plus`：
```json
{
  "model": "coder-model",
  "messages": [
    {
      "role": "user",
      "content": "写一个快速排序算法。"
    }
  ],
  "stream": false
}
```

**流式请求:**
```json
{
  "model": "qwen3-coder-flash",
  "messages": [
    {
      "role": "user",
      "content": "写一首关于春天的诗。"
    }
  ],
  "stream": true
}
```

**响应格式:**

非流式响应与标准 OpenAI API 格式相同：
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
        "content": "你好！我是一个AI助手..."
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

流式响应使用 Server-Sent Events (SSE) 格式：
```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"qwen3-coder-flash","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"qwen3-coder-flash","choices":[{"index":0,"delta":{"content":"！"},"finish_reason":null}]}

data: [DONE]
```

---

## ⚠️ 免责声明

1. 本项目仅供学习交流使用，**严禁用于任何商业用途**。
2. 使用本项目所产生的一切后果由使用者自行承担，项目开发者不承担任何责任。
3. 本项目不对 `chat.qwen.ai` 及 `Qwen Code / Qwen Cli` 的服务可用性、稳定性作任何保证。
4. 使用者应遵守所在地区的法律法规，以及通义千问的服务条款和使用政策。
5. 如有侵权，请联系作者删除。

## 🚫 禁止商用

本项目采用 **仅限个人学习与研究** 的使用许可：

- 禁止将本项目或其衍生作品用于任何商业目的，包括但不限于：出售、出租、提供付费服务、嵌入商业产品等。
- 禁止利用本项目进行任何违反通义千问服务条款的行为。
- 禁止将本项目用于大规模自动化调用、恶意攻击或滥用上游服务。
