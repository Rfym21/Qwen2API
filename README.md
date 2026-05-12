<div align="center">

> [🇷🇺 Русская версия / Russian version](README-ru.md)

# 🚀 Qwen-Proxy

[![Version](https://img.shields.io/badge/version-2026.04.29.23.45-blue.svg)](https://github.com/Rfym21/Qwen2API)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-supported-blue.svg)](https://hub.docker.com/r/rfym21/qwen2api)

[🔗 加入交流群](https://t.me/nodejs_project) | [📖 檔案](#api-檔案) | [🐳 Docker 部署](#docker-部署)

</div>

## 🛠️ 快速開始

### 專案說明

Qwen-Proxy 是一個將 `https://chat.qwen.ai` 和 `Qwen Code / Qwen Cli` 轉換為 OpenAI 相容 API 的代理服務。通過本專案，您只需要一個帳戶，即可以使用任何支援 OpenAI API 的客戶端（如 ChatGPT-Next-Web、LobeChat 等）來呼叫 `https://chat.qwen.ai` 和 `Qwen Code / Qwen Cli`的各種模型。其中 `/cli` 端點下的模型由 `Qwen Code / Qwen Cli` 提供，支援256k上下文，原生 tools 引數支援

**主要特性：**
- 相容 OpenAI API 格式，無縫對接各類客戶端
- 相容 Anthropic Messages API（`/v1/messages`），支援 Claude Code、Anthropic SDK 等客戶端
- 支援 Function Calling（OpenAI `tools` / Anthropic `tools`），含流式 `arguments` 增量分片與 `tool_choice=required` 強校驗重試
- 支援多帳戶輪詢，提高可用性
- 支援流式/非流式響應
- 支援多模態（圖片識別、影片理解、圖片/影片生成）
- 支援 OpenAI 風格資源端點：`/v1/images/generations`、`/v1/images/edits`、`/v1/videos`
- 支援智慧搜尋、深度思考等高階功能
- 支援 CLI 端點，提供 256K 上下文和工具呼叫能力
- 提供 Web 管理介面，方便配置和監控
- 批次新增帳號支援即時進度展示，可在系統設定中調整登入併發數

### ⚠️ 高併發說明

> **重要提示**: `chat.qwen.ai` 對單 IP 有限速策略，目前已知該限制與 Cookie 無關，僅與 IP 相關。

**解決方案：**

如需高併發使用，建議配合代理池實現 IP 輪換：

| 方案 | 配置方式 | 說明 |
|------|----------|------|
| **方案一** | `PROXY_URL` + [ProxyFlow](https://github.com/Rfym21/ProxyFlow) | 直接配置代理地址，所有請求通過代理池輪換 IP |
| **方案二** | `QWEN_CHAT_PROXY_URL` + [UrlProxy](https://github.com/Rfym21/UrlProxy) + [ProxyFlow](https://github.com/Rfym21/ProxyFlow) | 通過反代 + 代理池組合，實現更靈活的 IP 輪換 |

**配置示例：**

```bash
# 方案一：直接使用代理池
PROXY_URL=http://127.0.0.1:8282  # ProxyFlow 代理地址

# 方案二：反代 + 代理池組合
QWEN_CHAT_PROXY_URL=http://127.0.0.1:8000/qwen  # UrlProxy 反代地址（UrlProxy 配置 HTTP_PROXY 指向 ProxyFlow）
```

### 🌐 帳號級代理 / Per-account proxy

每個帳號可以配置自己專屬的出站代理，從而讓多個帳號通過不同的 IP 同時使用，規避 `chat.qwen.ai` 基於 IP 的關聯封禁。

**優先順序：** `account.proxy` > 全域性 `PROXY_URL` > 不使用代理

**支援的代理協議：** HTTP / HTTPS / SOCKS5（與 `PROXY_URL` 一致）

**前端配置（推薦）：**
開啟管理面板 → 新增帳號時填寫 "代理地址" 欄位，或在已有帳號卡片上點選 "修改代理" 按鈕。

**ENV 配置（DATA_SAVE_MODE=none）：**

```bash
# 舊格式（向後相容，帳號級代理留空）
ACCOUNTS=user1@mail.com:pass1,user2@mail.com:pass2

# 新格式（用 | 分隔代理 URL，可與舊格式混用）
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

`proxy` 欄位為 `null` 或缺失時，帳號回退到全域性 `PROXY_URL`（若配置）。

> ⚠️ **注意：** 介面返回的代理 URL 不做脫敏處理。本專案假設執行在受信任的本地或私有網路環境中，由單一管理員使用。

### 環境要求

- Node.js 18+ (原始碼部署時需要)
- Docker (可選)
- Redis (可選，用於資料持久化)

### ⚙️ 環境配置

建立 `.env` 檔案並配置以下引數：

```bash
# 🌐 服務配置
LISTEN_ADDRESS=localhost       # 監聽地址
SERVICE_PORT=3000             # 服務埠

# 🔐 安全配置
API_KEY=sk-123456,sk-456789   # API 金鑰 (必填，支援多金鑰)
ACCOUNTS=                     # 帳戶配置 (格式: user1:pass1[|proxy_url],user2:pass2[|proxy_url])

# 🚀 PM2 多程式配置
PM2_INSTANCES=1               # PM2程式數量 (1/數字/max)
PM2_MAX_MEMORY=1G             # PM2記憶體限制 (100M/1G/2G等)
                              # 注意: PM2叢集模式下所有程式共用同一個埠

# 🔍 功能配置
SEARCH_INFO_MODE=table        # 搜尋資訊展示模式 (table/text)
OUTPUT_THINK=true             # 是否輸出思考過程 (true/false)
SIMPLE_MODEL_MAP=false        # 簡化模型對映 (true/false)

# 🌐 代理與反代配置
QWEN_CHAT_PROXY_URL=          # 自定義 Chat API 反代URL (預設: https://chat.qwen.ai)
QWEN_CLI_PROXY_URL=           # 自定義 CLI API 反代URL (預設: https://portal.qwen.ai)
PROXY_URL=                    # HTTP/HTTPS/SOCKS5 代理地址 (例如: http://127.0.0.1:7890)

# 🗄️ 資料儲存
DATA_SAVE_MODE=none           # 資料儲存模式 (none/file/redis)
REDIS_URL=                    # Redis 連線地址 (可選，使用TLS時為rediss://)
BATCH_LOGIN_CONCURRENCY=5     # 批次新增帳號時的登入併發數

# 📸 快取配置
CACHE_MODE=default            # 圖片快取模式 (default/file)
```

#### 📋 配置說明

| 引數 | 說明 | 示例 |
|------|------|------|
| `LISTEN_ADDRESS` | 服務監聽地址 | `localhost` 或 `0.0.0.0` |
| `SERVICE_PORT` | 服務執行埠 | `3000` |
| `API_KEY` | API 訪問金鑰，支援多金鑰配置。第一個為管理員金鑰（可訪問前端管理頁面），其他為普通金鑰（僅可呼叫API）。多個金鑰用逗號分隔 | `sk-admin123,sk-user456,sk-user789` |
| `PM2_INSTANCES` | PM2程式數量 | `1`/`4`/`max` |
| `PM2_MAX_MEMORY` | PM2記憶體限制 | `100M`/`1G`/`2G` |
| `SEARCH_INFO_MODE` | 搜尋結果展示格式 | `table` 或 `text` |
| `OUTPUT_THINK` | 是否顯示 AI 思考過程 | `true` 或 `false` |
| `SIMPLE_MODEL_MAP` | 簡化模型對映，只返回基礎模型不包含變體 | `true` 或 `false` |
| `QWEN_CHAT_PROXY_URL` | 自定義 Chat API 反代地址 | `https://your-proxy.com` |
| `QWEN_CLI_PROXY_URL` | 自定義 CLI API 反代地址 | `https://your-cli-proxy.com` |
| `PROXY_URL` | 出站請求代理地址，支援 HTTP/HTTPS/SOCKS5 | `http://127.0.0.1:7890` |
| `DATA_SAVE_MODE` | 資料持久化方式 | `none`/`file`/`redis` |
| `REDIS_URL` | Redis 資料庫連線地址，使用TLS加密時需使用 `rediss://` 協議 | `redis://localhost:6379` 或 `rediss://xxx.upstash.io` |
| `BATCH_LOGIN_CONCURRENCY` | 批次新增帳號時的登入併發數，可在前端系統設定中動態調整 | `5` |
| `CACHE_MODE` | 圖片快取儲存方式 | `default`/`file` |
| `LOG_LEVEL` | 日誌級別 | `DEBUG`/`INFO`/`WARN`/`ERROR` |
| `ENABLE_FILE_LOG` | 是否啟用檔案日誌 | `true` 或 `false` |
| `LOG_DIR` | 日誌檔案目錄 | `./logs` |
| `MAX_LOG_FILE_SIZE` | 最大日誌檔案大小(MB) | `10` |
| `MAX_LOG_FILES` | 保留的日誌檔案數量 | `5` |

> 💡 **提示**: 可以在 [Upstash](https://upstash.com/) 免費建立 Redis 例項，使用 TLS 協議時地址格式為 `rediss://...`
<div>
<img src="./docs/images/upstash.png" alt="Upstash Redis" width="600">
</div>

#### 🔑 多API_KEY配置說明

`API_KEY` 環境變數支援配置多個API金鑰，用於實現不同許可權級別的訪問控制：

**配置格式:**
```bash
# 單個金鑰（管理員許可權）
API_KEY=sk-admin123

# 多個金鑰（第一個為管理員，其他為普通使用者）
API_KEY=sk-admin123,sk-user456,sk-user789
```

**許可權說明:**

| 金鑰型別 | 許可權範圍 | 功能描述 |
|----------|----------|----------|
| **管理員金鑰** | 完整許可權 | • 訪問前端管理頁面<br>• 修改系統設定<br>• 呼叫所有API介面<br>• 新增/刪除普通金鑰 |
| **普通金鑰** | API呼叫許可權 | • 僅可呼叫API介面<br>• 無法訪問前端管理頁面<br>• 無法修改系統設定 |

**使用場景:**
- **團隊協作**: 為不同團隊成員分配不同許可權的API金鑰
- **應用整合**: 為第三方應用提供受限的API訪問許可權
- **安全隔離**: 將管理許可權與普通使用許可權分離

**注意事項:**
- 第一個API_KEY自動成為管理員金鑰，擁有最高許可權
- 管理員可以通過前端頁面動態新增或刪除普通金鑰
- 所有金鑰都可以正常呼叫API介面，許可權差異僅體現在管理功能上

#### 📸 CACHE_MODE 快取模式說明

`CACHE_MODE` 環境變數控制圖片快取的儲存方式，用於最佳化圖片上傳和處理效能：

| 模式 | 說明 | 適用場景 |
|------|------|----------|
| `default` | 記憶體快取模式 (預設) | 單程式部署，重啟後快取丟失 |
| `file` | 檔案快取模式 | 多程式部署，快取持久化到 `./caches/` 目錄 |

**推薦配置:**
- **單程式部署**: 使用 `CACHE_MODE=default`，效能最佳
- **多程式/叢集部署**: 使用 `CACHE_MODE=file`，確保程式間快取共享
- **Docker 部署**: 建議使用 `CACHE_MODE=file` 並掛載 `./caches` 目錄

**檔案快取目錄結構:**
```
caches/
├── [signature1].txt    # 快取檔案，包含圖片URL
├── [signature2].txt
└── ...
```

---

## 🚀 部署方式

### 🐳 Docker 部署

#### 方式一：直接執行

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
# 下載配置檔案
curl -o docker-compose.yml https://raw.githubusercontent.com/Rfym21/Qwen2API/refs/heads/main/docker/docker-compose.yml

# 啟動服務
docker compose pull && docker compose up -d
```

### 📦 本地部署

```bash
# 克隆專案
git clone https://github.com/Rfym21/Qwen2API.git
cd Qwen2API

# 安裝依賴
npm install

# 配置環境變數
cp .env.example .env
# 編輯 .env 檔案

# 智慧啟動 (推薦 - 自動判斷單程式/多程式)
npm start

# 開發模式
npm run dev
```

### 🚀 PM2 多程式部署

使用 PM2 進行生產環境多程式部署，提供更好的效能和穩定性。

**重要說明**: PM2 叢集模式下，所有程式共用同一個埠，PM2 會自動進行負載均衡。

### 🤖 智慧啟動模式

使用 `npm start` 可以自動判斷啟動方式：

- 當 `PM2_INSTANCES=1` 時，使用單程式模式
- 當 `PM2_INSTANCES>1` 時，使用 Node.js 叢集模式
- 自動限制程式數不超過 CPU 核心數

### ☁️ Hugging Face 部署

快速部署到 Hugging Face Spaces：

[![Deploy to Hugging Face](https://img.shields.io/badge/🤗%20Hugging%20Face-Deploy-yellow)](https://huggingface.co/spaces/devme/q2waepnilm)

<div>
<img src="./docs/images/hf.png" alt="Hugging Face Deployment" width="600">
</div>

---

## 📁 專案結構

```
Qwen2API/
├── README.md
├── ecosystem.config.js              # PM2配置檔案
├── package.json
│
├── docker/                          # Docker配置目錄
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── docker-compose-redis.yml
│
├── caches/                          # 快取檔案目錄
├── data/                            # 資料檔案目錄
│   ├── data.json
│   └── data_template.json
├── scripts/                         # 指令碼目錄
│   └── fingerprint-injector.js      # 瀏覽器指紋注入指令碼
│
├── src/                             # 後端原始碼目錄
│   ├── server.js                    # 主伺服器檔案
│   ├── start.js                     # 智慧啟動指令碼 (自動判斷單程式/多程式)
│   ├── config/
│   │   └── index.js                 # 配置檔案
│   ├── controllers/                 # 控制器目錄
│   │   ├── chat.js                  # 聊天控制器
│   │   ├── chat.image.video.js      # 圖片/影片生成控制器
│   │   ├── cli.chat.js              # CLI聊天控制器
│   │   └── models.js                # 模型控制器
│   ├── middlewares/                 # 中介軟體目錄
│   │   ├── authorization.js         # 授權中介軟體
│   │   └── chat-middleware.js       # 聊天中介軟體
│   ├── models/                      # 模型目錄
│   │   └── models-map.js            # 模型對映配置
│   ├── routes/                      # 路由目錄
│   │   ├── accounts.js              # 帳戶路由
│   │   ├── chat.js                  # 聊天路由
│   │   ├── cli.chat.js              # CLI聊天路由
│   │   ├── models.js                # 模型路由
│   │   ├── settings.js              # 設定路由
│   │   └── verify.js                # 驗證路由
│   └── utils/                       # 工具函式目錄
│       ├── account-rotator.js       # 帳戶輪詢器
│       ├── account.js               # 帳戶管理
│       ├── chat-helpers.js          # 聊天輔助函式
│       ├── cli.manager.js           # CLI管理器
│       ├── cookie-generator.js      # Cookie生成器
│       ├── data-persistence.js      # 資料持久化
│       ├── fingerprint.js           # 瀏覽器指紋生成
│       ├── img-caches.js            # 圖片快取
│       ├── logger.js                # 日誌工具
│       ├── precise-tokenizer.js     # 精確分詞器
│       ├── proxy-helper.js          # 代理輔助函式
│       ├── redis.js                 # Redis連線
│       ├── request.js               # HTTP請求封裝
│       ├── setting.js               # 設定管理
│       ├── ssxmod-manager.js        # ssxmod引數管理
│       ├── token-manager.js         # Token管理器
│       ├── tools.js                 # 工具呼叫處理
│       └── upload.js                # 檔案上傳
│
└── public/                          # 前端專案目錄
    ├── dist/                        # 編譯後的前端檔案
    │   ├── assets/                  # 靜態資源
    │   ├── favicon.png
    │   └── index.html
    ├── src/                         # 前端原始碼
    │   ├── App.vue                  # 主應用元件
    │   ├── main.js                  # 入口檔案
    │   ├── style.css                # 全域性樣式
    │   ├── assets/                  # 靜態資源
    │   │   └── background.mp4
    │   ├── routes/                  # 路由配置
    │   │   └── index.js
    │   └── views/                   # 頁面元件
    │       ├── auth.vue             # 認證頁面
    │       ├── dashboard.vue        # 儀錶板頁面
    │       └── settings.vue         # 設定頁面
    ├── package.json                 # 前端依賴配置
    ├── package-lock.json
    ├── index.html                   # 前端入口HTML
    ├── postcss.config.js            # PostCSS配置
    ├── tailwind.config.js           # TailwindCSS配置
    ├── vite.config.js               # Vite構建配置
    └── public/                      # 公共靜態資源
        └── favicon.png
```

## 📖 API 檔案

### 🔐 API 認證說明

本API支援多金鑰認證機制，所有API請求都需要在請求頭中包含有效的API金鑰：

```http
Authorization: Bearer sk-your-api-key
```

**支援的金鑰型別:**
- **管理員金鑰**: 第一個配置的API_KEY，擁有完整許可權
- **普通金鑰**: 其他配置的API_KEY，僅可呼叫API介面

**認證示例:**
```bash
# 使用管理員金鑰
curl -H "Authorization: Bearer sk-admin123" http://localhost:3000/v1/models

# 使用普通金鑰
curl -H "Authorization: Bearer sk-user456" http://localhost:3000/v1/chat/completions
```

### 🔍 獲取模型列表

獲取所有可用的 AI 模型列表。

```http
GET /v1/models
Authorization: Bearer sk-your-api-key
```

```http
GET /models (免認證)
```

**說明:**
- `id`: 推薦直接作為請求裡的 `model` 使用，優先展示更易讀的模型名稱
- `name`: 上游原始模型 ID，便於與官方介面或日誌對照
- `upstream_id`: 不帶能力字尾的上游模型 ID
- `display_name`: 不帶能力字尾的展示名
- 當 `SIMPLE_MODEL_MAP=false` 時，會額外返回 `-thinking`、`-search`、`-image`、`-video`、`-image-edit` 等能力變體

**響應示例:**
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

### 💬 聊天對話

傳送聊天訊息並獲取 AI 回覆。

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

**請求體:**
```json
{
  "model": "Qwen3.6-Plus",
  "messages": [
    {
      "role": "system",
      "content": "你是一個有用的助手。"
    },
    {
      "role": "user",
      "content": "你好，請介紹一下自己。"
    }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2000
}
```

**響應示例:**
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
        "content": "你好！我是一個AI助手..."
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

### 🛠️ Function Calling（工具呼叫）

`/v1/chat/completions` 支援完整的 OpenAI Function Calling 協議。即便上游 Web 介面本身不具備原生 tools 能力，本服務通過提示詞注入與流式狀態機解析，使其行為與 OpenAI API 一致：

- 自動將 `tools[]` 壓縮為 TS 風格簽名注入提示詞，節省約 70% token 開銷
- 流式輸出按 OpenAI 規範分片：先發 `function.name + 空 arguments` 頭塊，隨後多個 `arguments` 切片
- 歷史訊息中的 `assistant.tool_calls` 與 `role:"tool"` 自動摺疊回鏈，`tool_call_id` 精確關聯
- `tool_choice` 全四態：`"auto"` / `"required"` / `{type:"function",function:{name:"..."}}` / `"none"`
- `tool_choice="required"` 或指定函式時，若首次未觸發工具呼叫，自動追加強約束提示重試一次

**請求示例：**

```json
{
  "model": "qwen3-coder-plus",
  "stream": true,
  "messages": [
    {"role": "user", "content": "查一下北京的天氣"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "獲取城市天氣",
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

**流式響應（節選）：**

```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":\"Beijing\"}"}}]}}]}

data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

OpenAI SDK、LangChain、Cline、Continue 等遵循 OpenAI 工具協議的客戶端可直接接入。

### 🤖 Anthropic Messages API

相容 Anthropic 的 `/v1/messages` 端點，可直接對接 Claude Code、Anthropic SDK、aider 等客戶端。

```http
POST /v1/messages
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

支援的欄位：

| 欄位 | 說明 |
|---|---|
| `model` | 任意 Qwen 模型名（如 `qwen3-coder-plus`） |
| `system` | 字串或 `{type:"text"}` 塊陣列 |
| `messages[].content` | 字串、文本塊、圖片塊、`tool_use` 塊、`tool_result` 塊 |
| `tools[]` | Anthropic 風格 `{name,input_schema,description}` |
| `tool_choice` | `{type:"auto"}` / `{type:"any"}`（=必須呼叫） / `{type:"tool",name:"..."}` / `{type:"none"}` |
| `thinking` | `{type:"enabled",budget_tokens:N}` 啟用思考模式 |
| `stream` | 流式 SSE 輸出 |

**請求示例（含工具呼叫）：**

```json
{
  "model": "qwen3-coder-plus",
  "max_tokens": 1024,
  "messages": [
    {"role": "user", "content": "查廣州天氣"}
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

**非流式響應：**

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
      "input": { "city": "廣州" }
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
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"廣州\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":234,"output_tokens":25}}

event: message_stop
data: {"type":"message_stop"}
```

### 🎨 影像與影片生成

當前支援兩種呼叫方式：
- 使用 `/v1/chat/completions` + 模型字尾：`-image`、`-image-edit`、`-video`
- 使用 OpenAI 風格資源端點：`/v1/images/generations`、`/v1/images/edits`、`/v1/videos`

以下示例中的模型名請以 `/v1/models` 返回的 `id` 欄位為準。

#### 方式一：通過 `/v1/chat/completions`

文本生圖：

```json
{
  "model": "Qwen3-Omni-Flash-image",
  "messages": [
    {
      "role": "user",
      "content": "畫一隻在花園裡玩耍的小貓咪，卡通風格"
    }
  ],
  "size": "1:1",
  "stream": false
}
```

圖片編輯：

```json
{
  "model": "Qwen3-Omni-Flash-image-edit",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "把這張圖片改成淺藍色科技風海報"
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

影片生成：

```json
{
  "model": "Qwen3-Omni-Flash-video",
  "messages": [
    {
      "role": "user",
      "content": "生成一個 3 秒夜景延時影片，城市街道霓虹燈閃爍"
    }
  ],
  "size": "9:16",
  "stream": false
}
```

**支援的尺寸引數:**
- `/v1/chat/completions` 下的圖片/影片生成支援 `1:1`、`4:3`、`3:4`、`16:9`、`9:16`
- `/v1/images/generations`、`/v1/images/edits`、`/v1/videos` 相容 `1024x1024`、`1536x1024`、`1024x1536`、`1792x1024`、`1024x1792`

#### 方式二：OpenAI 風格資源端點

影像生成：

```http
POST /v1/images/generations
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

```json
{
  "model": "Qwen3-Omni-Flash",
  "prompt": "一隻橘貓坐在木桌上看向鏡頭，寫實風格",
  "size": "1024x1024",
  "response_format": "url"
}
```

影像編輯：

```http
POST /v1/images/edits
Content-Type: multipart/form-data
Authorization: Bearer sk-your-api-key
```

表單欄位：
- `model`: 可選，不傳時自動選擇支援圖片編輯的預設模型
- `prompt`: 可選，預設為 `請基於上傳圖片完成編輯`
- `image`: 必填，支援 multipart 檔案上傳，也支援 JSON 字串形式的圖片 URL / data URI
- `size`: 可選，支援 OpenAI 風格尺寸寫法
- `response_format`: 可選，支援 `url`、`b64_json`

影片生成：

```http
POST /v1/videos
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

```json
{
  "model": "Qwen3-Omni-Flash",
  "prompt": "一個簡短的 3 秒夜景延時影片，城市街道霓虹燈閃爍",
  "size": "1024x1792"
}
```

影像生成響應示例：

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

影片生成響應示例：

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

### 🎯 高階功能

#### 🔍 智慧搜尋模式

在模型名稱後新增 `-search` 字尾啟用搜索功能：

```json
{
  "model": "Qwen3.6-Plus-search",
  "messages": [...]
}
```

#### 🧠 推理模式

在模型名稱後新增 `-thinking` 字尾啟用思考過程輸出：

```json
{
  "model": "Qwen3.6-Plus-thinking",
  "messages": [...]
}
```

#### 🔍🧠 組合模式

同時啟用搜索和推理功能：

```json
{
  "model": "Qwen3.6-Plus-thinking-search",
  "messages": [...]
}
```

#### 🖼️ 多模態支援

API 自動處理圖片和影片上傳，支援在對話中傳送圖片、影片 URL 或 Base64 data URI。

圖片理解示例：

```json
{
  "model": "Qwen3.5-Omni-Plus",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "這張圖片裡有什麼？"
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

影片理解示例：

```json
{
  "model": "Qwen3.5-Omni-Plus",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "請用一句話描述這個影片"
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

支援的影片欄位：
- `input_video`
- `video_url`
- `video`

### 🖥️ CLI 端點

CLI 端點使用 Qwen Code / Qwen Cli 的 OAuth 令牌訪問，支援 256K 上下文和工具呼叫（Function Calling）。

**支援的模型：**

| 模型 ID | 說明 |
|---------|------|
| `qwen3-coder-plus` | Qwen3 Coder Plus |
| `qwen3-coder-flash` | Qwen3 Coder Flash（速度更快） |
| `coder-model` | Qwen 3.5 Plus（帶思維鏈，256K 上下文） |
| `qwen3.5-plus` | `coder-model` 的別名，自動重定向 |

#### 💬 CLI 聊天對話

通過 CLI 端點傳送聊天請求，支援流式和非流式響應。

```http
POST /cli/v1/chat/completions
Content-Type: application/json
Authorization: Bearer API_KEY
```

**請求體:**
```json
{
  "model": "qwen3-coder-plus",
  "messages": [
    {
      "role": "user",
      "content": "你好，請介紹一下自己。"
    }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2000
}
```

使用 `coder-model`（即 Qwen 3.5 Plus）或其別名 `qwen3.5-plus`：
```json
{
  "model": "coder-model",
  "messages": [
    {
      "role": "user",
      "content": "寫一個快速排序演算法。"
    }
  ],
  "stream": false
}
```

**流式請求:**
```json
{
  "model": "qwen3-coder-flash",
  "messages": [
    {
      "role": "user",
      "content": "寫一首關於春天的詩。"
    }
  ],
  "stream": true
}
```

**響應格式:**

非流式響應與標準 OpenAI API 格式相同：
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
        "content": "你好！我是一個AI助手..."
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

流式響應使用 Server-Sent Events (SSE) 格式：
```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"qwen3-coder-flash","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"qwen3-coder-flash","choices":[{"index":0,"delta":{"content":"！"},"finish_reason":null}]}

data: [DONE]
```

Port 3000 已被 systemd 服務佔用，這是正常的。用 systemd 管理服務：
# 檢視狀態
systemctl --user status qwen2api
# 重啟
systemctl --user restart qwen2api
# 檢視日誌
journalctl --user -u qwen2api -n 30 --no-pager
# 停止（如果你想手動跑）
systemctl --user stop qwen2api
bun src/start.js
當前 systemd 服務正在背景正常執行中：
systemctl --user status qwen2api --no-pager | head -3
要確認就直接 curl health endpoint：
curl -s http://localhost:3000/health | python3 -m json.tool

systemctl --user kill qwen2api.service -s SIGKILL 2>&1; sleep 1; lsof -ti:3000 2>/dev/null | xargs -r kill -9 2>/dev/null; sleep 1; systemctl --user status qwen2api.service --no-pager 2>&1 | head -8
