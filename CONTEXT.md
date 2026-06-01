# ACP Agent Gateway

本上下文描述业务项目如何通过统一边界调用具备代码理解能力的 Agent，同时避免感知不同 Agent 的接入差异。

## Language

**ACP Agent Gateway**:
供业务项目调用 ACP Coding Agent 的通用组件。它统一一次 Agent 运行的输入、输出与权限边界。
_Avoid_: CLI Analyzer、禅道 Analyzer、任意命令执行器

**Business Consumer**:
使用 ACP Agent Gateway 完成自身业务流程的项目。它拥有业务提示、业务结果校验与业务产物。
_Avoid_: Agent、Adapter

**ACP Coding Agent**:
通过 Agent Client Protocol 接收任务并返回运行结果的代码理解 Agent。
_Avoid_: 任意 CLI、LLM API

**Agent Registry**:
ACP Agent Gateway 维护的可调用 ACP Coding Agent 清单。它将稳定的 Agent Name 映射为受控 adapter 配置。
_Avoid_: 请求级启动命令、任意 CLI 白名单

**Agent Name**:
Business Consumer 从 Agent Registry 中选择 ACP Coding Agent 时使用的稳定标识，例如 `claude`、`codex` 或 `opencode`。
_Avoid_: adapter 启动命令、模型名称

**Verified Agent**:
已经通过 ACP Agent Gateway 兼容测试并可用于 Agent Run 的 Agent Registry 条目。
_Avoid_: Reserved Agent、仅检测到可执行文件

**Reserved Agent**:
已纳入 Agent Registry 命名空间但尚未完成兼容测试的 ACP Coding Agent。它不能用于 Agent Run。
_Avoid_: Verified Agent、自动启用

**Workspace**:
ACP Coding Agent 在一个 Managed Session 中可访问的单一绝对工作目录。
_Avoid_: 仓库角色集合、相对工作目录

**Agent Run**:
Business Consumer 通过 ACP Agent Gateway 发起的一次 Agent 任务。
_Avoid_: shell 命令、业务流程

**Run Result**:
ACP Agent Gateway 为完成的 Agent Run 返回的通用结果。它包含 Agent 最终文本和运行元数据，但不解释文本中的业务结构。
_Avoid_: PRD 分析结果、业务 JSON

**Run Event**:
ACP Agent Gateway 在 Agent Run 执行期间发布的通用进度事件。
_Avoid_: Run Result、业务日志

**Stateless Run**:
一次创建、使用独立 ACP session 并释放本地资源的 Agent Run。它不复用先前运行的上下文或进程内状态。
_Avoid_: 多轮对话、共享 session

**Managed Session**:
由 ACP Agent Gateway 标识并管理生命周期的连续 Agent 对话。它可以接收多次任务输入，并在 ACP Coding Agent 支持时跨 Gateway 进程恢复。
_Avoid_: Stateless Run、永久存活进程

**Agent Turn**:
Managed Session 中的一次任务输入及其对应结果。每个 Agent Turn 的 Run Result 只包含本轮最终文本，不包含历史轮次文本。
_Avoid_: 完整对话记录、累计文本

**Session Release**:
释放 Managed Session 的本地 adapter 连接与进程资源。它不承诺关闭 ACP Coding Agent 保存的会话状态。
_Avoid_: Session Close、删除远端 session

**Session Close**:
请求 ACP Coding Agent 关闭 Managed Session 并释放 Agent 侧资源。它依赖 Agent 明确声明 `session/close` 能力。
_Avoid_: Session Release、静默降级

**Session Reference**:
ACP Agent Gateway 返回给 Business Consumer 的会话标识。它用于定位可继续使用的 Managed Session。
_Avoid_: ACP 进程 ID、业务任务 ID

**Session Recovery**:
使用 Session Reference 继续 Managed Session 的显式操作。
_Avoid_: 静默新建 session、自动丢弃历史上下文

**Session Compatibility**:
Session Recovery 前对 Session Reference 与当前请求执行环境的一致性校验。
_Avoid_: 尽力恢复、隐式迁移

**Historical Replay**:
ACP Coding Agent 在加载 Managed Session 时重新发送的历史事件。
_Avoid_: 当前运行进度、丢弃历史记录

**Permission Policy**:
Business Consumer 为 Agent Run 选择的能力边界。
_Avoid_: Agent 提示、业务校验

**Sandbox-backed Permission Policy**:
由操作系统隔离机制强制执行 Workspace 写入边界的 Permission Policy。它允许受控 adapter 状态目录写入，但不把这些目录视为 Workspace。
_Avoid_: best-effort 策略、ACP 权限提示

## Relationships

- 一个 **Business Consumer** 可发起一个或多个 **Agent Run**。
- 一个 **Agent Run** 由一个 **ACP Coding Agent** 执行。
- 一个 **Agent Run** 在一个 **Workspace** 中执行。
- 一个 **Stateless Run** 使用一个独立 **Managed Session**。
- 一个 **Managed Session** 可包含一个或多个顺序执行的 **Agent Turn**。
- 一个 **Managed Session** 可产生一个或多个 **Run Event** 与 **Run Result**。
- **Session Release** 不等同于 **Session Close**。
- **Business Consumer** 可使用 **Session Reference** 发起 **Session Recovery**。
- **Session Recovery** 必须满足 **Session Compatibility**。
- **Historical Replay** 不是当前 **Agent Run** 的实时进度。
- 一个 **Agent Run** 应用一个明确的 **Permission Policy**。
- **Sandbox-backed Permission Policy** 将 adapter 状态目录与 **Workspace** 分开处理。
- **Business Consumer** 通过 **Agent Name** 从 **Agent Registry** 选择 **ACP Coding Agent**。
- **Business Consumer** 拥有业务提示、业务结果校验、业务重试和业务产物。
- **ACP Agent Gateway** 不拥有禅道、PRD 或其他特定业务概念。
- **ACP Agent Gateway** 只调用 **ACP Coding Agent**，不执行任意 CLI。
