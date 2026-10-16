# Codex Lite Launcher · Codex 轻启

**简体中文** | [English](README.en.md)

为 Windows Codex 桌面应用提供可选的性能优化：减少隐藏窗口预加载，合并高频输出和刷新，降低不必要的后台开销。

- **自由选择**：11 项优化默认全选，可分别取消。
- **两种模式**：原位升级现有安装，或生成独立优化副本。
- **可回滚**：原位升级保留配套备份和选项记录。
- **源码交付**：通过 Node.js 和 PowerShell 运行，无需安装 npm 依赖。

这是非官方项目，与 OpenAI 无隶属或背书关系。仓库仅提供工具源码，不分发 Codex 安装包、修改后的 EXE/ASAR 或打包程序。

## 快速开始

### 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | Windows，具备目标目录的读写权限 |
| 运行环境 | Windows PowerShell 5.1、Node.js 20+ |
| Codex | 完整桌面安装；当前仅适配 **`26.928.20755`** |
| 资源 | 构建时需数 GB 可用内存；磁盘需求见下方模式对比 |

应用版本以 [patch.mjs](patch.mjs) 中的 `VERSION` 为准。未知版本会停止处理；取消某些优化不会绕过版本检查。

### 启动工具

克隆仓库，或通过 GitHub 的 **Code → Download ZIP** 下载源码并解压：

```powershell
git clone https://github.com/HaKuLaMeTAT/codex-lite-launcher.git
cd codex-lite-launcher
.\启动补丁.cmd
```

也可以在资源管理器中双击 `启动补丁.cmd`，无需执行 `npm install`。

1. 确认自动识别的 Codex 安装位置，必要时点击“选择来源”。
2. 选择“原位升级”或“独立副本”，勾选需要的优化。
3. 点击“检查来源”。修改路径或勾选后，需要重新检查。
4. 按对应模式的步骤完成操作。

## 选择使用方式

| | 原位升级 | 独立副本 |
|---|---|---|
| 应用文件 | 更新现有安装的配套 EXE 和 ASAR | 在新目录生成完整优化版，保留来源安装 |
| 启动方式 | 沿用原来的启动方式 | 使用副本中的 `启动优化版.cmd` |
| 额外磁盘需求 | 首次约需 1.02 GiB 可用空间，完成后约保留 0.51 GiB 备份 | 约 2.2 GiB |
| 撤回方式 | 在工具中执行“原位回滚” | 退出副本，按原方式启动来源安装 |

磁盘数字来自当前适配版本，实际需求以检查结果为准。工具不会自动关闭或启动 Codex，也不修改快捷方式。

### 原位升级与回滚

检查通过后，完全退出 Codex 桌面应用和 Codex CLI，保留补丁窗口，点击“原位升级”。完成后按原方式启动 Codex。

升级会配套处理 EXE 和 ASAR，并保存 `.before-lite-v5` 备份及 `codex-lite-install.json` 选项记录。**请一并保留这些文件，不要只替换单个 EXE 或 ASAR。**

需要回滚时，退出 Codex，在原位模式重新检查并点击“原位回滚”。回滚恢复本次升级前的文件，不受界面当前勾选影响。若要更换优化组合，先回滚，再重新勾选、检查和升级。替换中途失败时，保持 Codex 关闭，重新检查后执行回滚。

### 生成与使用独立副本

选择一个尚不存在的输出目录，检查通过后点击“生成副本”。默认位置为工具目录下的 `copies/Codex-optimized`。生成期间可以继续使用来源安装，但不要同时更新它。

完成后，先退出其他 Codex 桌面进程，再双击副本中的 `启动优化版.cmd`。入口会核对核心文件与清单是否一致。更换优化组合时，使用另一个新目录生成副本；工具不覆盖已有目录。生成失败时会保留 `.building` 目录供检查，不应从中启动应用。

**副本独立的是应用文件，账户与设置仍使用默认位置。** 它不是用户数据隔离环境，同一时刻只运行一个 Codex 桌面版本。

## 可选优化

所有选项默认启用，两种模式使用相同的优化逻辑。未勾选项不参与代码变换及对应匹配点检查。

| 优化 | 作用与取舍 |
|---|---|
| 宠物浮层按需创建 | 取消提前创建，保留正常打开路径；首次打开可能稍慢 |
| 快捷窗口按需创建 | 取消 Home/Thread 窗口预加载；首次快捷键打开可能稍慢 |
| 分离窗口按需创建 | 取消备用窗口预加载；首次分离可能稍慢 |
| 购买页面按需加载 | 关闭购买页预热，保留显式购买入口 |
| 充值页面按需加载 | 关闭充值页预热，保留显式充值入口 |
| 合并应用菜单刷新 | 首次立即刷新，连续变化按约 250 ms 合并；会话同步仍逐次执行 |
| 合并终端输出 | 空闲后的首块立即交付，其余按约 8 ms 合并；大块提前交付，退出前刷新尾部，不丢弃输出 |
| 命令输出精确更新 | 缩小最新完整回合中已知命令项的更新范围；不满足条件时保留原更新路径 |
| 合并已完成动画的文字节点 | 合并已完成淡入动画的连续普通文本，保留链接、装饰及正在动画中的片段 |
| 复用代码语言识别结果 | 减少自动识别的重复计算，内容变化和停流后校正；显式语言不变，定时器清理随该项启停 |
| 合并 MCP 工具列表刷新 | 首个就绪事件立即处理，200 ms 内的重复事件补一次尾部刷新；失败、授权等其他处理保持不变 |

完整选项标识见 [options.json](options.json)。全不选表示不新增优化：对干净安装执行原位操作时不替换文件、不新增备份；副本模式仍复制运行文件。

为了自由选择全部优化，建议使用未经修改的来源安装。对于已有补丁，工具只处理能够验证的状态；无法还原的已有优化不能通过取消勾选移除。

## 性能观察

一次早期按需加载优化的采样结果如下。测试日期为 2026-10-16，Codex 版本为 `26.928.20755`，机器有 8 个逻辑处理器、约 16 GiB 内存。统计范围仅为 `ChatGPT.exe` 桌面进程组，不包含后端和工具子进程。

| 指标 | 优化前 | 优化后 | 差异 |
|---|---:|---:|---:|
| 桌面进程数 | 13 | 10 | −3 |
| 渲染进程数 | 6 | 3 | −3 |
| 桌面进程私有内存合计 | 1,827.1 MiB | 1,185.5 MiB | −641.6 MiB（35.1%） |
| 主进程私有内存 | 372.3 MiB | 386.7 MiB | +14.4 MiB |
| 采样区间平均 CPU | 2.70% | 0.87% | −1.83 个百分点 |

**这是历史观察，不是受控基准或收益承诺。** 优化前采样约 61 秒、应用已运行约 11–12 分钟；优化后采样约 30 秒、应用已运行约 4–5 分钟。两次会话、操作和窗口状态未统一，不能把全部差异归因于补丁。CPU 以整机总能力为 100%，内存采用私有内存口径。

这些数字不代表任意选项组合的收益，也不包含后续输出、高亮及刷新优化的独立性能对照。项目不宣称修复长期内存泄漏。仓库只发布脱敏汇总，不包含原始个人采样日志。

## 兼容性与更新

- 使用 AST 定位修改点，并检查应用身份、版本、结构和摘要；不依赖固定字节偏移，但仍需逐版本适配。
- ASAR 仅修改所选优化涉及的模块、摘要和必要偏移；EXE 同步更新对应的 ASAR 头部校验值，不关闭完整性校验开关。
- 修改 EXE 后不能保留原始 Authenticode 签名有效性，本工具不重签名。生成清单用于一致性检查，不是数字签名。
- 暂不支持含链接的来源，也不保证与其他第三方补丁组合兼容。
- 工具不会自动提权；脚本入口仅设置当前 PowerShell 进程的执行策略，不修改全局策略。

项目不改造 Codex 的应用内更新机制，也不自动适配新版。Codex 更新后应重新确认支持范围：原位优化可能被更新覆盖，独立副本则需要从受支持的来源重新生成。不要将旧备份覆盖到不同版本。

## 命令行与开发

以下均为示例路径，请替换成自己的安装位置。`inspect` 只读检查；执行原位 `apply` 或 `restore` 前须完全退出 Codex 桌面和 CLI。

```powershell
# 原位：检查、应用、回滚
node .\inplace.mjs inspect 'C:\Apps\Codex\app\resources\app.asar'
node .\inplace.mjs apply 'C:\Apps\Codex\app\resources\app.asar'
node .\inplace.mjs restore 'C:\Apps\Codex\app\resources\app.asar'

# 副本：检查、生成、校验
node .\copy.mjs inspect 'C:\Apps\Codex\app\resources\app.asar'
node .\copy.mjs create 'C:\Apps\Codex\app\resources\app.asar' 'C:\Apps\Codex-optimized'
node .\copy.mjs verify 'C:\Apps\Codex-optimized'
```

省略 `--options` 时全选。检查、应用和生成命令可指定逗号分隔的选项标识；`--options=none` 表示全不选。回滚与副本校验不接收选项参数。

```powershell
# 仅选择菜单刷新合并与终端输出合并
node .\inplace.mjs inspect 'C:\Apps\Codex\app\resources\app.asar' --options=menu,batched-pty-output
node .\inplace.mjs apply 'C:\Apps\Codex\app\resources\app.asar' --options=menu,batched-pty-output

# 运行自动化测试
npm test

# 可选：加入真实安装包的只读验证；未设置时该项跳过
$env:CODEX_TEST_ASAR = 'C:\Apps\Codex\app\resources\app.asar'
npm test
```

选项名称和依赖关系维护在 [options.json](options.json)，核心变换见 [patch.mjs](patch.mjs) 和 [runtime-patches.mjs](runtime-patches.mjs)。已完成的验证和未覆盖范围见 [VALIDATION.md](VALIDATION.md)（中文）。语法、结构及启动检查不能代替完整桌面功能验收。

## 来源与许可

部分变换规则改编自 [Codex++](https://github.com/b-nnett/codex-plusplus)，参考提交 `13d0c2421cc4258565710910ca8dfe60344c027e` 的 `Sources/CodexPPCore/Resources/startup-adapter.js`。

本项目采用 [MIT License](LICENSE)。第三方声明见 [Codex++ 许可证](vendor/CODEXPP-LICENSE) 和 [Acorn 许可证](vendor/ACORN-LICENSE)。
