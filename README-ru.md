<div align="center">

> [中文](README.md) | [🇷🇺 Русская версия](README-ru.md) | [English](README-en.md)

# 🚀 Qwen-Proxy

[![Version](https://img.shields.io/badge/version-2026.04.06.12.30-blue.svg)](https://github.com/Rfym21/Qwen2API)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-supported-blue.svg)](https://hub.docker.com/r/rfym21/qwen2api)

[🔗 Присоединиться к чату](https://t.me/nodejs_project) | [📖 Документация](#api-документация) | [🐳 Развертывание Docker](#развертывание-docker)

</div>

## 🛠️ Быстрый старт

### Описание проекта

Qwen-Proxy — это прокси-сервис, преобразующий `https://chat.qwen.ai` и `Qwen Code / Qwen Cli` в API, совместимый с OpenAI. С помощью этого проекта вам нужен всего один аккаунт, чтобы использовать любой клиент с поддержкой OpenAI API (например, ChatGPT-Next-Web, LobeChat и др.) для вызова различных моделей `https://chat.qwen.ai` и `Qwen Code / Qwen Cli`. Модели в эндпоинте `/cli` предоставляются `Qwen Code / Qwen Cli`, поддерживают контекст 256K и нативный параметр tools.

**Основные возможности:**
- Совместимость с форматом OpenAI API, бесшовная интеграция с различными клиентами
- Поддержка ротации нескольких аккаунтов для повышения доступности
- Поддержка потоковых/непотоковых ответов
- Поддержка мультимодальности (распознавание изображений, генерация изображений)
- Поддержка интеллектуального поиска, глубокого размышления и других продвинутых функций
- Поддержка CLI-эндпоинта с контекстом 256K и возможностью вызова инструментов
- Веб-интерфейс управления для удобной настройки и мониторинга
- Массовое добавление аккаунтов с отображением прогресса в реальном времени, параллельность входа настраивается в системных настройках

### ⚠️ Примечание о высокой нагрузке

> **Важно**: `chat.qwen.ai` ограничивает скорость запросов по IP. Известно, что это ограничение не связано с Cookie, а только с IP-адресом.

**Решения:**

Для высоконагруженного использования рекомендуется применять пул прокси для ротации IP:

| Вариант | Способ настройки | Описание |
|---------|------------------|----------|
| **Вариант 1** | `PROXY_URL` + [ProxyFlow](https://github.com/Rfym21/ProxyFlow) | Прямая настройка прокси-адреса, все запросы проходят через пул с ротацией IP |
| **Вариант 2** | `QWEN_CHAT_PROXY_URL` + [UrlProxy](https://github.com/Rfym21/UrlProxy) + [ProxyFlow](https://github.com/Rfym21/ProxyFlow) | Комбинация обратного прокси + пул прокси для более гибкой ротации IP |

**Примеры настройки:**

```bash
# Вариант 1: Прямое использование пула прокси
PROXY_URL=http://127.0.0.1:8282  # Адрес ProxyFlow

# Вариант 2: Обратный прокси + пул прокси
QWEN_CHAT_PROXY_URL=http://127.0.0.1:8000/qwen  # Адрес обратного прокси UrlProxy (UrlProxy настроен с HTTP_PROXY на ProxyFlow)
```

### 🌐 Прокси для каждого аккаунта / Per-account proxy

Каждому аккаунту можно назначить собственный исходящий прокси, чтобы разные аккаунты ходили с разных IP одновременно и не попадали под массовый бан `chat.qwen.ai` по корреляции IP.

**Приоритет:** `account.proxy` > глобальный `PROXY_URL` > без прокси

**Поддерживаемые протоколы:** HTTP / HTTPS / SOCKS5 (как у `PROXY_URL`)

**Через панель (рекомендуется):**
Откройте dashboard → при добавлении аккаунта заполните поле «Proxy URL», либо нажмите кнопку «Изменить proxy» на карточке существующего аккаунта.

**Через ENV (DATA_SAVE_MODE=none):**

```bash
# Старый формат (обратная совместимость, прокси не задан)
ACCOUNTS=user1@mail.com:pass1,user2@mail.com:pass2

# Новый формат (URL прокси через `|`, можно смешивать со старым)
ACCOUNTS=user1@mail.com:pass1|http://10.0.0.1:8080,user2@mail.com:pass2|socks5://10.0.0.2:1080
```

**Схема `data/data.json` (file-режим):**

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

Если поле `proxy` равно `null` или отсутствует, аккаунт ходит через глобальный `PROXY_URL` (если он задан).

> ⚠️ **Внимание:** прокси-URL в ответах API **не маскируются**. Проект рассчитан на запуск в доверенной локальной/частной сети с единственным администратором.

### Требования к окружению

- Node.js 18+ (необходим при развертывании из исходников)
- Docker (опционально)
- Redis (опционально, для персистентного хранения данных)

### ⚙️ Настройка окружения

Создайте файл `.env` и настройте следующие параметры:

```bash
# 🌐 Конфигурация сервиса
LISTEN_ADDRESS=localhost       # Адрес прослушивания
SERVICE_PORT=3000             # Порт сервиса

# 🔐 Безопасность
API_KEY=sk-123456,sk-456789   # API-ключи (обязательно, поддержка нескольких ключей)
ACCOUNTS=                     # Настройка аккаунтов (формат: user1:pass1[|proxy_url],user2:pass2[|proxy_url])

# 🚀 Многопроцессная конфигурация PM2
PM2_INSTANCES=1               # Количество процессов PM2 (1/число/max)
PM2_MAX_MEMORY=1G             # Ограничение памяти PM2 (100M/1G/2G и т.д.)
                              # Примечание: в кластерном режиме PM2 все процессы используют один порт

# 🔍 Конфигурация функций
SEARCH_INFO_MODE=table        # Режим отображения результатов поиска (table/text)
OUTPUT_THINK=true             # Выводить ли процесс размышления (true/false)
SIMPLE_MODEL_MAP=false        # Упрощенное сопоставление моделей (true/false)

# 🌐 Прокси и обратный прокси
QWEN_CHAT_PROXY_URL=          # Пользовательский URL обратного прокси Chat API (по умолчанию: https://chat.qwen.ai)
QWEN_CLI_PROXY_URL=           # Пользовательский URL обратного прокси CLI API (по умолчанию: https://portal.qwen.ai)
PROXY_URL=                    # Адрес HTTP/HTTPS/SOCKS5 прокси (например: http://127.0.0.1:7890)

# 🗄️ Хранение данных
DATA_SAVE_MODE=none           # Режим сохранения данных (none/file/redis)
REDIS_URL=                    # Адрес подключения к Redis (опционально, при TLS используйте rediss://)
BATCH_LOGIN_CONCURRENCY=5     # Параллельность входа при массовом добавлении аккаунтов

# 📸 Конфигурация кэширования
CACHE_MODE=default            # Режим кэширования изображений (default/file)
```

#### 📋 Описание параметров

| Параметр | Описание | Пример |
|----------|----------|--------|
| `LISTEN_ADDRESS` | Адрес прослушивания сервиса | `localhost` или `0.0.0.0` |
| `SERVICE_PORT` | Порт работы сервиса | `3000` |
| `API_KEY` | API-ключи доступа, поддержка нескольких ключей. Первый ключ — администраторский (доступ к панели управления), остальные — обычные (только вызов API). Разделяются запятой | `sk-admin123,sk-user456,sk-user789` |
| `PM2_INSTANCES` | Количество процессов PM2 | `1`/`4`/`max` |
| `PM2_MAX_MEMORY` | Ограничение памяти PM2 | `100M`/`1G`/`2G` |
| `SEARCH_INFO_MODE` | Формат отображения результатов поиска | `table` или `text` |
| `OUTPUT_THINK` | Отображать ли процесс размышления AI | `true` или `false` |
| `SIMPLE_MODEL_MAP` | Упрощенное сопоставление моделей, возвращает только базовые модели без вариантов | `true` или `false` |
| `QWEN_CHAT_PROXY_URL` | Пользовательский адрес обратного прокси Chat API | `https://your-proxy.com` |
| `QWEN_CLI_PROXY_URL` | Пользовательский адрес обратного прокси CLI API | `https://your-cli-proxy.com` |
| `PROXY_URL` | Адрес прокси для исходящих запросов, поддержка HTTP/HTTPS/SOCKS5 | `http://127.0.0.1:7890` |
| `DATA_SAVE_MODE` | Способ персистентного хранения данных | `none`/`file`/`redis` |
| `REDIS_URL` | Адрес подключения к Redis, при использовании TLS-шифрования необходим протокол `rediss://` | `redis://localhost:6379` или `rediss://xxx.upstash.io` |
| `BATCH_LOGIN_CONCURRENCY` | Параллельность входа при массовом добавлении аккаунтов, можно динамически менять в системных настройках фронтенда | `5` |
| `CACHE_MODE` | Способ хранения кэша изображений | `default`/`file` |
| `LOG_LEVEL` | Уровень логирования | `DEBUG`/`INFO`/`WARN`/`ERROR` |
| `ENABLE_FILE_LOG` | Включить ли файловое логирование | `true` или `false` |
| `LOG_DIR` | Директория файлов логов | `./logs` |
| `MAX_LOG_FILE_SIZE` | Максимальный размер файла лога (МБ) | `10` |
| `MAX_LOG_FILES` | Количество сохраняемых файлов логов | `5` |

> 💡 **Подсказка**: Можно бесплатно создать экземпляр Redis на [Upstash](https://upstash.com/), при использовании протокола TLS адрес имеет формат `rediss://...`
<div>
<img src="./docs/images/upstash.png" alt="Upstash Redis" width="600">
</div>

#### 🔑 Настройка нескольких API_KEY

Переменная окружения `API_KEY` поддерживает настройку нескольких API-ключей для реализации разных уровней доступа:

**Формат настройки:**
```bash
# Один ключ (права администратора)
API_KEY=sk-admin123

# Несколько ключей (первый — администратор, остальные — обычные пользователи)
API_KEY=sk-admin123,sk-user456,sk-user789
```

**Описание прав:**

| Тип ключа | Область прав | Описание функций |
|-----------|--------------|------------------|
| **Администраторский ключ** | Полные права | • Доступ к панели управления<br>• Изменение системных настроек<br>• Вызов всех API-эндпоинтов<br>• Добавление/удаление обычных ключей |
| **Обычный ключ** | Права вызова API | • Только вызов API-эндпоинтов<br>• Нет доступа к панели управления<br>• Нет возможности изменять системные настройки |

**Сценарии использования:**
- **Командная работа**: назначение ключей с разными правами для разных членов команды
- **Интеграция приложений**: предоставление ограниченного API-доступа сторонним приложениям
- **Разделение безопасности**: разделение административных и пользовательских прав

**Примечания:**
- Первый API_KEY автоматически становится администраторским ключом с максимальными правами
- Администратор может динамически добавлять или удалять обычные ключи через панель управления
- Все ключи могут вызывать API-эндпоинты, различия в правах касаются только функций управления

#### 📸 Описание режимов CACHE_MODE

Переменная окружения `CACHE_MODE` управляет способом хранения кэша изображений для оптимизации производительности загрузки и обработки:

| Режим | Описание | Сценарий использования |
|-------|----------|------------------------|
| `default` | Кэширование в памяти (по умолчанию) | Однопроцессное развертывание, кэш теряется при перезапуске |
| `file` | Файловое кэширование | Многопроцессное развертывание, кэш сохраняется в директорию `./caches/` |

**Рекомендуемая настройка:**
- **Однопроцессное развертывание**: используйте `CACHE_MODE=default`, максимальная производительность
- **Многопроцессное/кластерное развертывание**: используйте `CACHE_MODE=file`, обеспечивает общий кэш между процессами
- **Развертывание Docker**: рекомендуется `CACHE_MODE=file` с монтированием директории `./caches`

**Структура директории файлового кэша:**
```
caches/
├── [signature1].txt    # Файл кэша, содержит URL изображения
├── [signature2].txt
└── ...
```

---

## 🚀 Способы развертывания

### 🐳 Развертывание Docker

#### Способ 1: Прямой запуск

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

#### Способ 2: Docker Compose

```bash
# Скачать файл конфигурации
curl -o docker-compose.yml https://raw.githubusercontent.com/Rfym21/Qwen2API/refs/heads/main/docker/docker-compose.yml

# Запустить сервис
docker compose pull && docker compose up -d
```

### 📦 Локальное развертывание

```bash
# Клонировать проект
git clone https://github.com/Rfym21/Qwen2API.git
cd Qwen2API

# Установить зависимости
npm install

# Настроить переменные окружения
cp .env.example .env
# Отредактировать файл .env

# Умный запуск (рекомендуется — автоматически определяет одно-/многопроцессный режим)
npm start

# Режим разработки
npm run dev
```

### 🚀 Многопроцессное развертывание PM2

Используйте PM2 для многопроцессного развертывания в продакшене, обеспечивая лучшую производительность и стабильность.

**Важно**: В кластерном режиме PM2 все процессы используют один порт, PM2 автоматически выполняет балансировку нагрузки.

### 🤖 Умный режим запуска

Используйте `npm start` для автоматического определения способа запуска:

- При `PM2_INSTANCES=1` — однопроцессный режим
- При `PM2_INSTANCES>1` — кластерный режим Node.js
- Количество процессов автоматически ограничивается числом ядер CPU

### ☁️ Развертывание на Hugging Face

Быстрое развертывание на Hugging Face Spaces:

[![Deploy to Hugging Face](https://img.shields.io/badge/🤗%20Hugging%20Face-Deploy-yellow)](https://huggingface.co/spaces/devme/q2waepnilm)

<div>
<img src="./docs/images/hf.png" alt="Hugging Face Deployment" width="600">
</div>

### ☁️ Развертывание на Vercel

Быстрое развертывание на Vercel:

[![Развернуть с Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FRfym21%2FQwen2API)

Необходимо настроить переменные окружения:
```
ACCOUNTS=email:password
SERVICE_PORT=80
API_KEY=sk-xxx
DATA_SAVE_MODE=none
```

---

## 📁 Структура проекта

```
Qwen2API/
├── README.md
├── ecosystem.config.js              # Конфигурация PM2
├── package.json
│
├── docker/                          # Директория конфигурации Docker
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── docker-compose-redis.yml
│
├── caches/                          # Директория файлов кэша
├── data/                            # Директория файлов данных
│   ├── data.json
│   └── data_template.json
├── scripts/                         # Директория скриптов
│   └── fingerprint-injector.js      # Скрипт инъекции отпечатка браузера
│
├── src/                             # Директория исходного кода бэкенда
│   ├── server.js                    # Главный файл сервера
│   ├── start.js                     # Скрипт умного запуска (авто-определение одно-/многопроцессного режима)
│   ├── config/
│   │   └── index.js                 # Файл конфигурации
│   ├── controllers/                 # Директория контроллеров
│   │   ├── chat.js                  # Контроллер чата
│   │   ├── chat.image.video.js      # Контроллер генерации изображений/видео
│   │   ├── cli.chat.js              # Контроллер CLI-чата
│   │   └── models.js                # Контроллер моделей
│   ├── middlewares/                 # Директория middleware
│   │   ├── authorization.js         # Middleware авторизации
│   │   └── chat-middleware.js       # Middleware чата
│   ├── models/                      # Директория моделей
│   │   └── models-map.js            # Конфигурация сопоставления моделей
│   ├── routes/                      # Директория маршрутов
│   │   ├── accounts.js              # Маршруты аккаунтов
│   │   ├── chat.js                  # Маршруты чата
│   │   ├── cli.chat.js              # Маршруты CLI-чата
│   │   ├── models.js                # Маршруты моделей
│   │   ├── settings.js              # Маршруты настроек
│   │   └── verify.js                # Маршруты верификации
│   └── utils/                       # Директория утилит
│       ├── account-rotator.js       # Ротатор аккаунтов
│       ├── account.js               # Управление аккаунтами
│       ├── chat-helpers.js          # Вспомогательные функции чата
│       ├── cli.manager.js           # Менеджер CLI
│       ├── cookie-generator.js      # Генератор Cookie
│       ├── data-persistence.js      # Персистентность данных
│       ├── fingerprint.js           # Генерация отпечатка браузера
│       ├── img-caches.js            # Кэш изображений
│       ├── logger.js                # Утилита логирования
│       ├── precise-tokenizer.js     # Точный токенизатор
│       ├── proxy-helper.js          # Вспомогательные функции прокси
│       ├── redis.js                 # Подключение к Redis
│       ├── request.js               # Обертка HTTP-запросов
│       ├── setting.js               # Управление настройками
│       ├── ssxmod-manager.js        # Менеджер параметров ssxmod
│       ├── token-manager.js         # Менеджер токенов
│       ├── tools.js                 # Обработка вызова инструментов
│       └── upload.js                # Загрузка файлов
│
└── public/                          # Директория фронтенд-проекта
    ├── dist/                        # Скомпилированные фронтенд-файлы
    │   ├── assets/                  # Статические ресурсы
    │   ├── favicon.png
    │   └── index.html
    ├── src/                         # Исходный код фронтенда
    │   ├── App.vue                  # Главный компонент приложения
    │   ├── main.js                  # Точка входа
    │   ├── style.css                # Глобальные стили
    │   ├── assets/                  # Статические ресурсы
    │   │   └── background.mp4
    │   ├── routes/                  # Конфигурация маршрутизации
    │   │   └── index.js
    │   └── views/                   # Компоненты страниц
    │       ├── auth.vue             # Страница авторизации
    │       ├── dashboard.vue        # Панель управления
    │       └── settings.vue         # Страница настроек
    ├── package.json                 # Конфигурация фронтенд-зависимостей
    ├── package-lock.json
    ├── index.html                   # Входной HTML фронтенда
    ├── postcss.config.js            # Конфигурация PostCSS
    ├── tailwind.config.js           # Конфигурация TailwindCSS
    ├── vite.config.js               # Конфигурация сборки Vite
    └── public/                      # Публичные статические ресурсы
        └── favicon.png
```

## 📖 API-документация

### 🔐 Аутентификация API

API поддерживает многоключевую аутентификацию, все запросы должны содержать действительный API-ключ в заголовке:

```http
Authorization: Bearer sk-your-api-key
```

**Поддерживаемые типы ключей:**
- **Администраторский ключ**: первый настроенный API_KEY, обладает полными правами
- **Обычный ключ**: остальные настроенные API_KEY, только вызов API-эндпоинтов

**Примеры аутентификации:**
```bash
# Использование администраторского ключа
curl -H "Authorization: Bearer sk-admin123" http://localhost:3000/v1/models

# Использование обычного ключа
curl -H "Authorization: Bearer sk-user456" http://localhost:3000/v1/chat/completions
```

### 🔍 Получение списка моделей

Получение списка всех доступных AI-моделей.

```http
GET /v1/models
Authorization: Bearer sk-your-api-key
```

```http
GET /models (без аутентификации)
```

**Пример ответа:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen-max-latest",
      "object": "model",
      "created": 1677610602,
      "owned_by": "qwen"
    }
  ]
}
```

### 💬 Чат-диалог

Отправка сообщения и получение ответа AI.

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

**Тело запроса:**
```json
{
  "model": "qwen-max-latest",
  "messages": [
    {
      "role": "system",
      "content": "Ты полезный помощник."
    },
    {
      "role": "user",
      "content": "Привет, расскажи о себе."
    }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2000
}
```

**Пример ответа:**
```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "qwen-max-latest",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Привет! Я AI-помощник..."
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

### 🎨 Генерация/редактирование изображений

Используйте модели с суффиксом `-image` для генерации изображений из текста.
Используйте модели с суффиксом `-image-edit` для редактирования изображений.
При использовании моделей `-image` можно управлять размером изображения, добавив параметр `size` в тело запроса или включив ключевые слова `1:1`, `4:3`, `3:4`, `16:9`, `9:16` в текст сообщения.

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-your-api-key
```

**Тело запроса:**
```json
{
  "model": "qwen-max-latest-image",
  "messages": [
    {
      "role": "user",
      "content": "Нарисуй котенка, играющего в саду, в мультяшном стиле"
    }
  ],
  "size": "1:1",
  "stream": false
}
```

**Поддерживаемые параметры:**
- `size`: размер изображения, поддерживается `"1:1"`, `"4:3"`, `"3:4"`, `"16:9"`, `"9:16"`
- `stream`: поддержка потокового и непотокового ответа

**Пример ответа:**
```json
{
  "created": 1677652288,
  "model": "qwen-max-latest",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "![image](https://example.com/generated-image.jpg)"
      },
      "finish_reason": "stop"
    }
  ]
}
```

### 🎯 Продвинутые функции

#### 🔍 Режим интеллектуального поиска

Добавьте суффикс `-search` к имени модели для включения функции поиска:

```json
{
  "model": "qwen-max-latest-search",
  "messages": [...]
}
```

#### 🧠 Режим рассуждений

Добавьте суффикс `-thinking` к имени модели для вывода процесса размышления:

```json
{
  "model": "qwen-max-latest-thinking",
  "messages": [...]
}
```

#### 🔍🧠 Комбинированный режим

Одновременное включение поиска и рассуждений:

```json
{
  "model": "qwen-max-latest-thinking-search",
  "messages": [...]
}
```

#### 🎨 Режим генерации изображений T2I

Активируйте генерацию изображений из текста, установив параметр `chat_type` в значение `t2i`:

```json
{
  "model": "qwen-max-latest",
  "chat_type": "t2i",
  "messages": [
    {
      "role": "user",
      "content": "Нарисуй милого котенка"
    }
  ],
  "size": "1:1"
}
```

**Поддерживаемые размеры изображений:** `1:1`, `4:3`, `3:4`, `16:9`, `9:16`

**Умное определение размера:** система автоматически распознает ключевые слова размера в промпте и устанавливает соответствующий размер

#### 🖼️ Мультимодальная поддержка

API автоматически обрабатывает загрузку изображений, поддерживает отправку изображений в диалоге:

```json
{
  "model": "qwen-max-latest",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Что изображено на этой картинке?"
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

### 🖥️ CLI-эндпоинт

CLI-эндпоинт использует OAuth-токены Qwen Code / Qwen Cli для доступа, поддерживает контекст 256K и вызов инструментов (Function Calling).

**Поддерживаемые модели:**

| ID модели | Описание |
|-----------|----------|
| `qwen3-coder-plus` | Qwen3 Coder Plus |
| `qwen3-coder-flash` | Qwen3 Coder Flash (быстрее) |
| `coder-model` | Qwen 3.5 Plus (с цепочкой рассуждений, контекст 256K) |
| `qwen3.5-plus` | Алиас для `coder-model`, автоматическое перенаправление |

#### 💬 CLI чат-диалог

Отправка чат-запросов через CLI-эндпоинт, поддержка потоковых и непотоковых ответов.

```http
POST /cli/v1/chat/completions
Content-Type: application/json
Authorization: Bearer API_KEY
```

**Тело запроса:**
```json
{
  "model": "qwen3-coder-plus",
  "messages": [
    {
      "role": "user",
      "content": "Привет, расскажи о себе."
    }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2000
}
```

Использование `coder-model` (т.е. Qwen 3.5 Plus) или его алиаса `qwen3.5-plus`:
```json
{
  "model": "coder-model",
  "messages": [
    {
      "role": "user",
      "content": "Напиши алгоритм быстрой сортировки."
    }
  ],
  "stream": false
}
```

**Потоковый запрос:**
```json
{
  "model": "qwen3-coder-flash",
  "messages": [
    {
      "role": "user",
      "content": "Напиши стихотворение о весне."
    }
  ],
  "stream": true
}
```

**Формат ответа:**

Непотоковый ответ соответствует стандартному формату OpenAI API:
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
        "content": "Привет! Я AI-помощник..."
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

Потоковый ответ использует формат Server-Sent Events (SSE):
```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"qwen3-coder-flash","choices":[{"index":0,"delta":{"content":"Привет"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"qwen3-coder-flash","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: [DONE]
```
