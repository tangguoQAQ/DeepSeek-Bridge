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
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 128000, "output": 16000 }
        },
        "deepseek-reasoner": {
          "name": "DeepSeek Reasoner (Bridge)",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "compatibility": { "reasoningField": "reasoning_content" },
          "limit": { "context": 128000, "output": 16000 }
        },
        "deepseek-search": {
          "name": "DeepSeek Search (Bridge)",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 128000, "output": 16000 }
        },
        "deepseek-reasoner-search": {
          "name": "DeepSeek Reasoner Search (Bridge)",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
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
- 已支持工具调用，`capabilities.tools` 设为 `true`。

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
        "toolCalling": true,
        "vision": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      },
      {
        "id": "deepseek-reasoner",
        "name": "DeepSeek Reasoner (Bridge)",
        "url": "http://127.0.0.1:7638/v1/chat/completions",
        "toolCalling": true,
        "vision": false,
        "thinking": true,
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      },
      {
        "id": "deepseek-search",
        "name": "DeepSeek Search (Bridge)",
        "url": "http://127.0.0.1:7638/v1/chat/completions",
        "toolCalling": true,
        "vision": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      },
      {
        "id": "deepseek-reasoner-search",
        "name": "DeepSeek Reasoner Search (Bridge)",
        "url": "http://127.0.0.1:7638/v1/chat/completions",
        "toolCalling": true,
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

## 3. 工具调用

桥支持 OpenAI 的 `tools`、`tool_choice`（`auto` / `none` / `required` / 指定函数）、`parallel_tool_calls` 和 `role:"tool"` 消息。客户端把 Tool Calling 打开即可。

网页模型没有原生 function calling，桥会：

- 在 prompt 顶部注入工具协议，要求模型在回复末尾输出 `<tool_calls>` JSON 块
- 兼容 DeepSeek 原生 DSML 标记（如 `<｜DSML｜tool_calls>`），自动转换为标准 `tool_calls`
- 解析后转换为标准 `tool_calls`，并返回 `finish_reason:"tool_calls"`
- 工具结果作为增量消息回传，继续复用同一个网页会话
- 输出格式不合法时保留原文，按普通文本返回（`finish_reason:"stop"`）

注意：

- `tool_choice:"none"` 时本轮不向网页模型暴露工具，按普通对话回答
- 工具定义变化会自动使用新的网页会话，避免旧协议污染
- 单轮最多接受 8 个工具调用；`strict` 字段仅透传，不强制校验参数 schema

---

## 4. 常见错误

| 报错 | 原因与处理 |
|---|---|
| `400 tools.N.function...` | 工具定义不合法 → 检查 name、parameters 是否为 JSON Schema 对象 |
| `400 tool_choice ... requires at least one tool` | `required` 但没有提供工具 → 补 `tools` 或改成 `auto` |
| `400 messages.N.tool_call_id is required` | `role:"tool"` 消息缺少 `tool_call_id` → 使用返回的调用 id |
| `400 Bad type of message content: image_url` | 不支持图片 → 去掉图片 |
| `401 Not signed in / Session expired` | 到浏览器窗口重新登录 DeepSeek |
| `503 Bridge not ready` | 浏览器还在启动/等登录，稍后重试 |
| `429 Request queue is full` | 请求太频繁 → 降低频率、关自动补全 |
| `504 First-token / Idle / Total timeout` | 网页端响应超时（60s 首 token、60s 静默、10min 总时长） |

## 5. 验证连接

```powershell
curl.exe http://127.0.0.1:7638/healthz
curl.exe -N http://127.0.0.1:7638/v1/chat/completions -H "Content-Type: application/json" -d '{\"model\":\"deepseek-chat\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'
```
