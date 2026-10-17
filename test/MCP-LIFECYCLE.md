# MCP 生命周期实验 / MCP lifecycle experiment

此实验验证工具进程的启动与释放机制。`lazy-mcp-host.mjs` 是**未接入安装器**的受限协议原型，不能作为通用 MCP 代理部署。v0.10.0 的 `app-tools-shared-host` 是另一个专用实现：复用已有桌面工具处理器，不启动 stdio 工作进程。

This experiment verifies process startup and cleanup. The lazy host is **not an installer option** or a general-purpose MCP proxy. The separate v0.10.0 `app-tools-shared-host` implementation reuses desktop handlers without starting stdio workers.

## 共享应用工具通道 / Shared app-tools channel

仅运行生产共享通道的真实后端测试，不执行下面的通用懒启动实验：

Run only the production channel against the real backend:

```powershell
node test/mcp-lifecycle-probe.mjs 'D:\path\to\Codex\app\resources\codex.exe' --shared-only

# 可选：当前桌面的真实只读调用 / Optional real desktop read-only calls
$env:CODEX_TEST_APP_PIPE = '1'
node test/mcp-lifecycle-probe.mjs 'D:\path\to\Codex\app\resources\codex.exe' --shared-only
Remove-Item Env:CODEX_TEST_APP_PIPE
```

真实桌面测试需要 `CODEX_APP_TOOLS_PIPE_PATH`、`CODEX_THREAD_ID` 和管道访问权限。报告应包含 `shared-native-metadata` 及 `shared-real-desktop`：两个会话的元数据、55 个工具发现及两次只读项目清单调用通过。此路径没有 stdio 工作进程；它没有修改正式安装，也未验证安装后的完整桌面流程。

Real desktop calls require `CODEX_APP_TOOLS_PIPE_PATH`, `CODEX_THREAD_ID`, and pipe access. Look for `shared-native-metadata` and `shared-real-desktop`: two-session metadata checks, 55 discoverable tools, and two read-only project-list calls. No stdio workers are started. This does not modify the installation or validate the complete patched desktop workflow.

## 运行 / Run

需要 Node.js 20+ 和本机 Codex 安装中的 `codex.exe`：

```powershell
node test/mcp-lifecycle-probe.mjs 'D:\path\to\Codex\app\resources\codex.exe'
```

测试使用临时目录下独立的 `CODEX_HOME`、本地测试模型地址和真实 app-server，不发送模型回合，不复制账户凭证，不修改正式安装或用户配置。测试在临时环境安装一个本地测试插件。网络代理指向不可用的本机端口，仅允许回环地址直连。报告及诊断日志保留在命令输出的临时目录中；退出码非零表示实验失败。

The test uses an isolated temporary `CODEX_HOME`, a local model URL, and the real app-server. It sends no model turns, copies no account credentials, and does not modify the live installation or user configuration. It installs a local fixture plugin only inside the temporary home. The printed temporary directory contains the report and diagnostics. A nonzero exit code means failure.

有状态会话卸载测试通常需要约 60 秒；探针最多等待 75 秒。这个时限用于验证已测后端行为，不是跨版本协议保证。

The stateful-session cleanup test usually takes about 60 seconds and has a 75-second deadline. This is an observation about the tested backend, not a cross-version protocol guarantee.

可选：从 Codex 提供命名管道环境的终端运行时，额外测试真实应用工具服务。仅读取工具目录与项目清单：

Optionally, from an environment containing the app-provided pipe, test the real app-tools service. This only reads its catalog and project list:

```powershell
$env:CODEX_TEST_APP_TOOLS = 'C:\path\to\codex-app-tools\server.mjs'
node test/mcp-lifecycle-probe.mjs 'D:\path\to\Codex\app\resources\codex.exe'
Remove-Item Env:CODEX_TEST_APP_TOOLS
```

目录读取需要 `CODEX_APP_TOOLS_PIPE_PATH`。真实调用还需要当前会话的 `CODEX_THREAD_ID`；没有该变量时只测目录读取。完整真实调用结果须包含 `real-app-tools-lazy-call`，不能只看退出码。

Catalog access requires `CODEX_APP_TOOLS_PIPE_PATH`. Real calls also require the current `CODEX_THREAD_ID`; without it, only catalog access is tested. Look for `real-app-tools-lazy-call` to confirm the actual call/restart test ran.

## 已验证的边界 / Verified boundaries

2026-10-17，测试后端：`codex-cli 0.159.0`，来自桌面应用 `26.928.20755`。

| 测试 / Test | 结果 / Result |
|---|---|
| 启动前 `enabled=false` | 不启动服务，但直接调用失败；不会自动按需恢复 / No worker, but calls fail instead of starting it |
| `disabled_tools` | 服务仍提前启动 / Hides or disables calls without preventing startup |
| `disabledPluginIds` | 已启动连接继续存在；本次验证生命周期，不验证后续模型的工具选择 / Existing connection survives; model-side selection was not tested |
| 带 `threadId` 和 `serverName` 的目录查询 | 复用该会话连接 / Reuses the thread connection |
| 只有 `threadId` 的完整目录查询 | 额外启动一个短时实例；不是永久泄漏证据 / Starts an additional temporary instance, not evidence of a permanent leak |
| 原型的目录查询 | 不启动目标服务进程，包括完整目录刷新 / Does not start the target worker |
| 并发首次调用 | 只启动一个进程 / Starts one worker |
| 无状态服务空闲回收 | 正常关闭 stdin、退出码 0；下次调用可重启 / Graceful stdin close and restart on the next call |
| 长时间调用 | 不受空闲回收打断 / In-flight calls survive idle reclamation |
| 有状态服务 | 空闲后保留计数状态；不同会话的进程和状态隔离 / State survives idle time and is isolated between sessions |
| 取消订阅 | 本机约 60 秒后收到 HTTP DELETE，仅释放对应会话 / HTTP DELETE arrives after about 60 seconds and releases that session only |
| 真实应用工具服务 | 55 个工具可发现；两次只读项目清单调用分别按需启动，空闲后均正常退出 / 55 tools discoverable; two read-only project-list calls each start a worker on demand and exit cleanly |

实验将无状态空闲阈值缩短为 300 ms，以覆盖时间边界；这不是正式补丁的默认设置。原型宿主与测试驱动共用一个进程，只统计它管理的目标服务进程。结果不代表正式桌面的总进程数或内存收益。

The 300 ms stateless idle deadline is for testing, not a production default. The prototype host runs inside the test driver; worker counts are not desktop-wide process or memory measurements.

## 通用懒启动原型的接入要求 / Generic lazy-host integration requirements

- 工具目录必须在不启动全部服务的条件下可用，并绑定当前服务版本、配置、账户和权限；当前原型由测试代码预先提供目录。真实服务实验会先短时启动一次服务读取目录，这一步不计为按需启动收益。
- 宿主应复用桌面进程或现有共享服务。每个工具再增加一个常驻代理进程，不能实现减少进程的目标。
- 保留审批设置、调用元数据、取消、服务端请求、通知和目录更新语义。原型只覆盖 tools-only 请求，不支持完整 MCP 协议，不可直接交付用户启用。
- 只有经过审计的无状态服务适合独立空闲回收。CUA、REPL 保留到会话卸载；代码审查服务存在私有审查任务管理逻辑，不能直接归为无状态服务。
- 在真实桌面验证升级、首次调用、审批、会话切换、断连恢复和退出清理，再加入可选优化目录。

Production integration needs a version- and context-correct catalog without eager worker startup, a shared host that avoids adding per-tool proxy processes, and preserved approval, cancellation, metadata, notification, and server-request behavior. CUA and REPL must retain state until session unload. Code review manages ongoing review tasks and must not be assumed stateless. Desktop integration and acceptance remain outstanding.
