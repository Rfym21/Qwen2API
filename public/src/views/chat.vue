<template>
  <div class="chat h-screen flex flex-col items-center">
    <div class="chat-header p-4 bg-white/60 w-full flex justify-between">
      <span>Qwen</span>
      <span>{{ t("chat.title") }}</span>
    </div>
    <div class="chat-messages flex-auto overflow-y-auto max-w-5xl w-full">
      <div
        v-for="(message, index) in state.messages"
        :key="index"
        :class="`chat-message m-4 flex flex-col role-${message.role}`"
      >
        <div class="message-content">
          {{ message.content }}
        </div>
      </div>
    </div>
    <div class="chat-input max-w-5xl w-full">
      <div class="rounded-xl border p-4 m-4 bg-white/60">
        <textarea
          class="w-full outline-none bg-transparent"
          v-model="state.prompt"
        ></textarea>
        <div class="flex justify-between mt-2">
          <select
            class="border rounded py-2 outline-none bg-transparent text-sm"
            v-model="state.model"
          >
            <option v-for="opt in state.models" :key="opt" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <button
            class="bg-blue-500 text-white px-4 py-2 rounded-full text-sm"
            @click="send"
          >
            {{ t("chat.send") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, onMounted } from "vue";
import { useI18n } from "vue-i18n";

defineOptions({
  name: "Chat",
});

const { t } = useI18n();

const apiKey = localStorage.getItem("apiKey");
const typeKey = "Content-Type";
const tokenKey = "Authorization";
const token = `Bearer ${apiKey}`;

const state = reactive({
  models: [],
  messages: [],
  prompt: "",
  model: "",
});

function createSseTransformer() {
  function pushMessage(block, controller) {
    const regLine = /(data|event|id|retry):\s?(.*)/;
    const message = { data: "", event: "", id: "", retry: "" };

    const lines = block.split("\n");

    lines.forEach(function (line) {
      if (!line) return;

      const match = regLine.exec(line);
      if (match) {
        const key = match[1];
        const value = match[2];
        message[key] += value;
      } else {
        console.warn("不符合SSE规范字段", line);
      }
    });

    if (message.data.length > 0) {
      controller.enqueue(message);
    }
  }

  const time = Date.now();
  let buffer = "";

  function start() {
    console.info(time, "sse-start");
  }

  function transform(chunk, controller) {
    buffer += chunk;

    const s = "\n\n";

    function check() {
      check.boundary = buffer.indexOf(s);
      return check.boundary > -1;
    }

    while (check()) {
      const block = buffer.slice(0, check.boundary);
      console.info(time, block, "sse-transform");
      pushMessage(block, controller);
      buffer = buffer.slice(check.boundary + s.length);
    }
  }

  function flush() {
    console.info(time, buffer, "sse-flush");
  }

  return { start, transform, flush };
}

function fetchSSE(url, body, callbacks) {
  return fetch(url, {
    method: "POST",
    headers: {
      [typeKey]: "application/json",
      [tokenKey]: token,
    },
    body: JSON.stringify(body),
  }).then(function (response) {
    const contentType = response.headers.get(typeKey);
    if (response.ok && contentType?.includes("text/event-stream")) {
      const sseTransformer = createSseTransformer();
      return response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream(sseTransformer))
        .pipeTo(new WritableStream(callbacks));
    } else {
      const error = new Error(`${response.status} - ${response.statusText}`);
      return Promise.reject(error);
    }
  });
}

function send() {
  state.messages.push({
    role: "user",
    content: state.prompt,
  });
  state.prompt = "";

  fetchSSE(
    "/v1/chat/completions",
    {
      model: state.model,
      messages: state.messages,
      stream: true,
    },
    {
      start() {
        console.info("SSE连接已开始");
        state.messages.push({
          role: "assistant",
          content: "",
        });
      },
      write(data) {
        try {
          const parsed = JSON.parse(data.data);
          parsed.choices?.forEach((choice) => {
            const content = choice?.delta?.content;
            if (content) {
              const lastMessage = state.messages[state.messages.length - 1];
              lastMessage.content += content;
            }
          });
        } catch (err) {
          console.info(err.message, data);
        }
      },
      close() {
        console.info("SSE连接已关闭");
      },
    },
  );
}

onMounted(async function () {
  const res = await fetch("/v1/models", {
    method: "GET",
    headers: {
      [tokenKey]: token,
    },
  });
  const { data } = await res.json();
  state.model = data[0].id;
  state.models = data.map((item) => {
    return {
      label: item.name,
      value: item.id,
    };
  });
});
</script>

<style scoped>
.role-user {
  align-items: flex-end;
}

.role-user .message-content {
  @apply bg-blue-100 py-2 px-4 rounded-lg;
}

.role-assistant .message-content {
  white-space: pre-wrap;
}
</style>
