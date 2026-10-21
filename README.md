# deepseek-bridge

把 chat.deepseek.com 网页端变成 OpenAI 兼容的本地 API。

## 客户端接入

OpenAI 兼容接口：`http://127.0.0.1:7638/v1`（API Key 任意；启动带 `--token` 时填该 token）。

opencode / VS Code（Continue 等）的配置见 **[docs/clients.md](docs/clients.md)**。

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

To type check:

```bash
bun check
```

## 会话复用

同一段对话会复用网页端同一个会话（后续只发送增量），减少网页历史中的新建会话数量。记录保存在 `./.cache/dsbridge-sessions.json`。

- `--max-sessions <n>`：最多保留桥创建的会话数，默认 `16`，超出按最近使用淘汰；`0` 表示不限制
- `--no-session-reuse`：关闭复用（每轮都新建会话）

## 工具调用

支持 OpenAI 的 `tools`、`tool_choice`、`parallel_tool_calls` 与 `role:"tool"` 消息，客户端可直接开启 Tool Calling。工具调用由网页模型按桥注入的协议输出，再由桥转换为标准 `tool_calls`；同时兼容模型偶尔输出的 DeepSeek 原生 DSML 标记。工具定义变化会自动新建网页会话。配置与限制见 **[docs/clients.md](docs/clients.md#3-工具调用)**。

This project was created using `bun init` in bun v1.4.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
