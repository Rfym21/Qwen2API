const ModelsMap = {
  "qwen3-coder-plus": {
    "capabilities": {
      "document": true,
      "vision": true,
      "video": true,
      "audio": true,
      "citations": true
    },
    "max_context_length": 1048576,
    "max_generation_length": 65536,
    "abilities": {
      "document": 1,
      "vision": 1,
      "video": 1,
      "audio": 1,
      "mcp": 1,
      "citations": 1
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "mcp": [
      "image-generation",
      "code-interpreter",
      "amap",
      "fire-crawl"
    ]
  },
  "qwen3-235b-a22b": {
    "capabilities": {
      "document": true,
      "vision": true,
      "video": true,
      "audio": true,
      "citations": true,
      "thinking_budget": true,
      "thinking": true
    },
    "max_context_length": 131072,
    "max_thinking_generation_length": 38912,
    "max_summary_generation_length": 8192,
    "abilities": {
      "document": 1,
      "vision": 1,
      "video": 1,
      "audio": 1,
      "mcp": 1,
      "citations": 1,
      "thinking_budget": 1,
      "thinking": 1
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "mcp": [
      "image-generation",
      "code-interpreter",
      "amap",
      "fire-crawl"
    ]
  },
  "qwen3-30b-a3b": {
    "capabilities": {
      "document": true,
      "vision": true,
      "video": true,
      "audio": true,
      "citations": true,
      "thinking_budget": true,
      "thinking": true
    },
    "max_context_length": 131072,
    "max_thinking_generation_length": 38912,
    "max_summary_generation_length": 8192,
    "abilities": {
      "document": 1,
      "vision": 1,
      "video": 1,
      "audio": 1,
      "mcp": 1,
      "citations": 1,
      "thinking_budget": 1,
      "thinking": 1
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "mcp": [
      "image-generation",
      "code-interpreter",
      "amap",
      "fire-crawl"
    ]
  },
  "qwen3-32b": {
    "capabilities": {
      "document": true,
      "vision": true,
      "video": true,
      "audio": true,
      "citations": true,
      "thinking_budget": true,
      "thinking": true
    },
    "max_context_length": 131072,
    "max_thinking_generation_length": 38912,
    "max_summary_generation_length": 8192,
    "abilities": {
      "document": 1,
      "vision": 1,
      "video": 1,
      "audio": 1,
      "mcp": 1,
      "citations": 1,
      "thinking_budget": 1,
      "thinking": 1
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "mcp": [
      "image-generation",
      "code-interpreter",
      "amap",
      "fire-crawl"
    ]
  },
  "qwen-max-latest": {
    "capabilities": {
      "vision": true,
      "document": true,
      "video": true,
      "audio": true,
      "citations": true,
      "thinking": true
    },
    "max_context_length": 131072,
    "max_generation_length": 8192,
    "abilities": {
      "vision": 1,
      "document": 1,
      "video": 1,
      "audio": 1,
      "mcp": 1,
      "citations": 1,
      "thinking": 1
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "mcp": [
      "image-generation",
      "code-interpreter",
      "amap",
      "fire-crawl"
    ]
  },
  "qwen-plus-2025-01-25": {
    "capabilities": {
      "vision": true,
      "document": true,
      "video": true,
      "audio": true,
      "citations": true,
      "thinking": true
    },
    "max_context_length": 131072,
    "max_generation_length": 8192,
    "abilities": {
      "vision": 1,
      "document": 1,
      "video": 1,
      "audio": 1,
      "mcp": 1,
      "citations": 1,
      "thinking": 1
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "mcp": [
      "image-generation",
      "code-interpreter",
      "amap",
      "fire-crawl"
    ]
  },
  "qwq-32b": {
    "capabilities": {
      "vision": false,
      "document": true,
      "video": false,
      "citations": false
    },
    "max_context_length": 131072,
    "max_generation_length": 8192,
    "is_single_round": 0,
    "abilities": {
      "vision": 2,
      "document": 1,
      "video": 2,
      "citations": 2,
      "thinking": 4
    },
    "chat_type": [
      "t2t",
      "artifacts",
      "web_dev",
      "search"
    ]
  },
  "qwen-turbo-2025-02-11": {
    "capabilities": {
      "vision": true,
      "document": true,
      "citations": true,
      "video": true,
      "audio": true,
      "thinking": true
    },
    "max_context_length": 1000000,
    "max_generation_length": 8192,
    "abilities": {
      "vision": 1,
      "document": 1,
      "citations": 1,
      "video": 1,
      "audio": 1,
      "mcp": 1,
      "thinking": 1
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "mcp": [
      "image-generation",
      "code-interpreter",
      "amap",
      "fire-crawl"
    ]
  },
  "qwen2.5-omni-7b": {
    "capabilities": {
      "vision": true,
      "document": true,
      "citations": true,
      "video": true,
      "audio": true
    },
    "max_context_length": 30720,
    "max_generation_length": 2048,
    "abilities": {
      "vision": 1,
      "document": 1,
      "citations": 1,
      "video": 1,
      "audio": 1
    },
    "file_limits": {
      "default_max_size": 20,
      "audio_max_count": 1,
      "doc_max_count": 1,
      "video_max_duration": 40,
      "audio_max_duration": 180,
      "image_max_size": 10,
      "video_max_size": 150,
      "audio_max_size": 100,
      "image_max_count": 5,
      "video_max_count": 1,
      "doc_max_size": 20
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "modality": [
      "text",
      "image",
      "video",
      "audio"
    ]
  },
  "qvq-72b-preview-0310": {
    "capabilities": {
      "vision": true,
      "document": true,
      "video": true,
      "citations": true
    },
    "max_context_length": 131072,
    "max_generation_length": 8192,
    "is_single_round": 1,
    "abilities": {
      "vision": 1,
      "document": 1,
      "video": 1,
      "citations": 1,
      "thinking": 4
    },
    "chat_type": [
      "t2t",
      "artifacts",
      "web_dev",
      "search"
    ],
    "modality": [
      "text",
      "image",
      "video"
    ]
  },
  "qwen2.5-vl-32b-instruct": {
    "capabilities": {
      "vision": true,
      "document": true,
      "video": true,
      "citations": true
    },
    "max_context_length": 131072,
    "max_generation_length": 8192,
    "abilities": {
      "vision": 1,
      "document": 1,
      "video": 1,
      "citations": 1,
      "thinking": 1
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "modality": [
      "text"
    ]
  },
  "gemma-2-9b-it": {
    "capabilities": {
      "vision": true,
      "document": true,
      "video": true,
      "citations": true
    },
    "max_context_length": 131072,
    "max_generation_length": 8192,
    "abilities": {
      "vision": 1,
      "document": 1,
      "video": 1,
      "citations": 1,
      "thinking": 1
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "modality": [
      "text",
      "image",
      "video"
    ]
  },
  "qwen2.5-14b-instruct-1m": {
    "capabilities": {
      "vision": true,
      "document": true,
      "video": true,
      "citations": true
    },
    "max_context_length": 1000000,
    "max_generation_length": 8192,
    "abilities": {
      "vision": 1,
      "document": 1,
      "video": 1,
      "citations": 1,
      "thinking": 1
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "modality": [
      "text"
    ]
  },
  "qwen2.5-coder-32b-instruct": {
    "capabilities": {
      "vision": true,
      "document": true,
      "video": true,
      "citations": true
    },
    "max_context_length": 131072,
    "max_generation_length": 8192,
    "abilities": {
      "vision": 1,
      "document": 1,
      "video": 1,
      "citations": 1,
      "thinking": 1
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "modality": [
      "text"
    ]
  },
  "qwen2.5-72b-instruct": {
    "capabilities": {
      "vision": true,
      "document": true,
      "video": true,
      "citations": true
    },
    "max_context_length": 131072,
    "max_generation_length": 8192,
    "abilities": {
      "vision": 1,
      "document": 1,
      "video": 1,
      "citations": 1,
      "thinking": 1
    },
    "chat_type": [
      "t2t",
      "t2v",
      "t2i",
      "search",
      "artifacts",
      "web_dev",
      "deep_research"
    ],
    "modality": [
      "text"
    ]
  }
}

module.exports = ModelsMap
