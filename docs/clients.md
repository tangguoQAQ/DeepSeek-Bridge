# 客户端快速接入（opencode / VS Code）

DeepSeek Bridge 在本机提供 OpenAI 兼容接口。先启动桥（保持浏览器窗口打开）：

```powershell
bun start
```

## 0. 通用信息

| 项目 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:7638/v1` |
| API Key | 启动未带 `--token` 时任意非空字符串；带了 `--token` 则填该 token |
| 健康检查 | `http://127.0.0.1:7638/healthz`（`"status":"READY"` 才可用） |

模型：

| 模型 ID | 思考 | 联网 |
|---|---|---|
| `deepseek-chat` | 否 | 否 |
| `deepseek-reasoner` | 是 | 否 |
| `deepseek-search` | 否 | 是 |
| `deepseek-reasoner-search` | 是 | 是 |

---

## 1. opencode（V2）

配置文件位置（二选一）：

- 全局：`C:\Users\<用户名>\.config\opencode\opencode.jsonc`
- 项目：仓库根目录 `opencode.jsonc`（已有文件就只合并 `providers` 部分）

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "dsbridge/deepseek-chat",
  "providers": {
    "dsbridge": {
      "name": "DeepSeek Bridge",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:7638/v1",
        "apiKey": "dummy"
      },
      "models": {
        "deepseek-chat": {
          "name": "DeepSeek Chat (Bridge)",
          "capabilities": { "tools": false, "input": ["text"], "output": ["text"] },
          "limit": { "context": 128000, "output": 16000 }
        },
        "deepseek-reasoner": {
          "name": "DeepSeek Reasoner (Bridge)",
          "capabilities": { "tools": false, "input": ["text"], "output": ["text"] },
          "compatibility": { "reasoningField": "reasoning_content" },
          "limit": { "context": 128000, "output": 16000 }
        },
        "deepseek-search": {
          "name": "DeepSeek Search (Bridge)",
          "capabilities": { "tools": false, "input": ["text"], "output": ["text"] },
          "limit": { "context": 128000, "output": 16000 }
        },
        "deepseek-reasoner-search": {
          "name": "DeepSeek Reasoner Search (Bridge)",
          "capabilities": { "tools": false, "input": ["text"], "output": ["text"] },
          "compatibility": { "reasoningField": "reasoning_content" },
          "limit": { "context": 128000, "output": 16000 }
        }
      }
    }
  }
}
```

说明：

- `apiKey` 填 `"dummy"` 即可；如果启动桥时用了 `--token`，改成指定的 token。
- `compatibility.reasoningField` 让 reasoner 的 `reasoning_content` 正常显示。
- `limit` 是保守估算值，可按需调大/调小。

---

## 2. VS Code

1. 命令面板（`Ctrl+Shift+P`）→ **Chat: Manage Language Models** → **Add Models** → **Custom Endpoint**。
   - 也可以直接编辑配置文件（不存在就新建）：
     - 稳定版：`C:\Users\<用户名>\AppData\Roaming\Code\User\chatLanguageModels.json`
     - Insiders：`C:\Users\<用户名>\AppData\Roaming\Code - Insiders\User\chatLanguageModels.json`
2. 写入（四个模型可只留你需要的）：

```json
[
  {
    "name": "DeepSeek Bridge",
    "vendor": "customendpoint",
    "apiKey": "dummy",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "deepseek-chat",
        "name": "DeepSeek Chat (Bridge)",
        "url": "http://127.0.0.1:7638/v1/chat/completions",
        "toolCalling": false,
        "vision": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      },
      {
        "id": "deepseek-reasoner",
        "name": "DeepSeek Reasoner (Bridge)",
        "url": "http://127.0.0.1:7638/v1/chat/completions",
        "toolCalling": false,
        "vision": false,
        "thinking": true,
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      },
      {
        "id": "deepseek-search",
        "name": "DeepSeek Search (Bridge)",
        "url": "http://127.0.0.1:7638/v1/chat/completions",
        "toolCalling": false,
        "vision": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      },
      {
        "id": "deepseek-reasoner-search",
        "name": "DeepSeek Reasoner Search (Bridge)",
        "url": "http://127.0.0.1:7638/v1/chat/completions",
        "toolCalling": false,
        "vision": false,
        "thinking": true,
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      }
    ]
  }
]
```

---

## 3. 常见错误

| 报错 | 原因与处理 |
|---|---|
| `400 DeepSeekBridge does not support tools` | 客户端在发工具定义 → 关掉 Tool Calling，或换聊天型客户端 |
| `400 Bad type of message content: image_url` | 不支持图片 → 去掉图片 |
| `401 Not signed in / Session expired` | 到浏览器窗口重新登录 DeepSeek |
| `503 Bridge not ready` | 浏览器还在启动/等登录，稍后重试 |
| `429 Request queue is full` | 请求太频繁 → 降低频率、关自动补全 |
| `504 First-token / Idle / Total timeout` | 网页端响应超时（60s 首 token、60s 静默、10min 总时长） |

## 4. 验证连接

```powershell
curl.exe http://127.0.0.1:7638/healthz
curl.exe -N http://127.0.0.1:7638/v1/chat/completions -H "Content-Type: application/json" -d '{\"model\":\"deepseek-chat\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'
```
