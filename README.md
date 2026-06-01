# ACP Agent Gateway

通用 TypeScript ACP Coding Agent 调用组件。它提供可导入的 `run()` API 与语言无关的 JSON CLI，不包含业务提示、业务 JSON 解析或业务产物生成逻辑。

当前已验证 OpenCode、Claude 与 Codex ACP adapter。每个 adapter 都通过受控 Agent Registry 解析，调用方不能传入任意启动命令。

## Requirements

- Node.js 24 或更高版本
- 已安装 OpenCode，且 `opencode` 位于 `PATH`
- 使用 Claude 时，已安装 `@agentclientprotocol/claude-agent-acp`，且 `claude-agent-acp` 位于 `PATH`
- 使用 Codex 时，已安装 `@zed-industries/codex-acp`，且 `codex-acp` 位于 `PATH`
- 使用 `strict-read-only` 或 `workspace-write` 时，需要 Linux 和位于 `PATH` 的 Bubblewrap (`bwrap`)

Gateway 不会在业务运行期间下载 adapter 或执行临时 `npx` 安装。

## Install

```bash
npm install
npm run build
```

## Doctor

```bash
node dist/cli.js doctor
```

本地 adapter 安装示例：

```bash
npm install -g @agentclientprotocol/claude-agent-acp
npm install -g @zed-industries/codex-acp
```

## OpenCode Smoke Test

OpenCode 冒烟测试会调用已配置模型，因此不纳入常规测试：

```bash
npm run build
npm run smoke:opencode
```

该命令验证 ACP 初始化、session 创建、prompt 执行与正常退出。如果需要同时强制校验 OpenCode 返回最终文本：

```bash
SMOKE_REQUIRE_TEXT=1 npm run smoke:opencode
```

部分 OpenCode 模型可能只发送 thought chunk 而不发送 `agent_message_chunk`。此时默认冒烟测试会输出兼容性警告。

当前已验证输出兼容性的 OpenCode 冒烟模型为 `opencode-go/qwen3.6-plus`。本地重复验证中仍观察到 OpenCode/provider 间歇性无输出，因此部署环境应通过 `model` 显式选择已验证模型、配置 idle timeout，并处理失败结果。详细结果见 [OpenCode ACP 兼容性报告](./docs/compatibility/opencode-acp-1.15.12.md)。

有状态 TypeScript API 的多轮冒烟测试同样会调用模型：

```bash
npm run build
npm run smoke:opencode:stateful
```

## JSON CLI

创建请求文件：

```json
{
  "apiVersion": "v1",
  "prompt": "Inspect this repository and summarize its purpose.",
  "model": "opencode-go/qwen3.6-plus",
  "permissionPolicy": "best-effort-read-only",
  "timeoutMs": 900000,
  "idleTimeoutMs": 300000
}
```

执行：

```bash
node dist/cli.js run \
  --agent opencode \
  --cwd /absolute/path/to/workspace \
  --input request.json
```

也可以从 stdin 传入请求：

```bash
cat request.json | node dist/cli.js run \
  --agent opencode \
  --cwd /absolute/path/to/workspace
```

stdout 只输出最终 JSON，stderr 输出不含 prompt、Agent 最终文本或文件内容的 JSONL 事件。

## TypeScript API

```ts
import { run } from "@local/acp-agent-gateway";

const result = await run(
  {
    apiVersion: "v1",
    agent: "opencode",
    cwd: "/absolute/path/to/workspace",
    prompt: "Inspect this repository and summarize its purpose.",
    model: "opencode-go/qwen3.6-plus",
    permissionPolicy: "best-effort-read-only",
    timeoutMs: 900_000,
    idleTimeoutMs: 300_000,
  },
  {
    onEvent(event) {
      console.error(event);
    },
  },
);

if (result.status === "failed") {
  throw new Error(`${result.errorCode}: ${result.error}`);
}

console.log(result.text);
```

## Explicit Model Selection

模型选择属于每次 `run` 请求的一部分。调用方应显式传入 `model`，不要依赖 OpenCode 本机默认配置。

- `agent` 决定使用哪个 ACP adapter。第一阶段仅启用 `opencode`。
- `model` 决定 OpenCode session 使用哪个模型。
- Gateway 会先读取 Agent 声明的模型列表，再通过 ACP `setSessionConfigOption` 选择模型。
- 省略 `model` 仍然允许执行，但会使用 OpenCode 默认模型。当前不建议这样使用。
- 当前已验证输出兼容性的模型是 `opencode-go/qwen3.6-plus`。调用方仍需处理 `idle_timeout`，因为 OpenCode/provider 可能间歇性无输出。

如果模型不存在，或者 Agent 未提供模型切换能力，Gateway 返回：

```json
{
  "apiVersion": "v1",
  "status": "failed",
  "errorCode": "unsupported_model",
  "error": "Unsupported model: example-model",
  "durationMs": 0
}
```

## Stateful TypeScript Sessions

TypeScript 调用方可以在同一进程内创建 Managed Session，并顺序执行多个 Agent Turn：

```ts
import { createSession } from "@local/acp-agent-gateway";

const session = await createSession({
  apiVersion: "v1",
  agent: "opencode",
  cwd: "/absolute/path/to/workspace",
  model: "opencode-go/qwen3.6-plus",
  permissionPolicy: "best-effort-read-only",
});

try {
  const first = await session.prompt({
    prompt: "Inspect the repository and summarize its purpose.",
    timeoutMs: 900_000,
    idleTimeoutMs: 300_000,
  });

  const second = await session.prompt({
    prompt: "Based on the previous analysis, list the main risks.",
    timeoutMs: 900_000,
    idleTimeoutMs: 300_000,
  });

  console.log(first);
  console.log(second);
} finally {
  await session.release();
}
```

- 每个 `prompt()` 结果只包含当前 Agent Turn 的文本，不累计历史结果。
- 同一个 Managed Session 一次只允许一个进行中的 Agent Turn。
- `release()` 释放本地 adapter 连接和进程资源，不承诺关闭 Agent 侧保存的 session。
- `close()` 通过 ACP `session/close` 请求 Agent 释放 session，随后释放本地资源。Agent 未声明该能力时返回 `unsupported_session_close`。
- Phase 2A 的有状态能力仅适用于同一 Node.js 进程。JSON CLI 仍只提供 `doctor` 和无状态 `run`。跨进程恢复属于 Phase 3。

## Permission Policies

- `best-effort-read-only`: 默认。允许 ACP 权限请求中的 `read`、`search` 和 `think`。
- `best-effort-workspace-write`: 用于 Agent 修改代码。
- `strict-read-only`: Linux Bubblewrap 强制 Workspace 与根文件系统只读。
- `workspace-write`: Linux Bubblewrap 强制仅 Workspace 和受控 adapter 状态目录可写。
- `approve-all`: 显式接受更宽权限。
- `deny-all`: 拒绝全部 ACP 权限请求。

`best-effort-*` 不是操作系统安全边界。ACP Agent 可以执行未向 Client 请求权限的工具。Linux 上应优先使用 sandbox-backed 策略。sandbox-backed 策略仍保留 provider 网络访问，并允许 Agent Registry 中受控声明的 adapter 运行时状态目录写入。

## Design

- [Context glossary](./CONTEXT.md)
- [Phased implementation plan](./docs/plans/0001-acp-agent-gateway-phased-implementation.md)
- [Linux Bubblewrap compatibility](./docs/compatibility/linux-bubblewrap.md)
- [OpenCode ACP compatibility](./docs/compatibility/opencode-acp-1.15.12.md)
- [Claude ACP compatibility](./docs/compatibility/claude-agent-acp-0.39.0.md)
- [Codex ACP compatibility](./docs/compatibility/codex-acp-0.15.0.md)
