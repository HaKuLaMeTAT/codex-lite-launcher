# 独立补丁 / Standalone patches

这些脚本不参与主工具的勾选、安装或回滚，不会自动执行。仅发布源码，不提供修改后的辅助 EXE、截图或个人会话数据。

## 1013 CUA 实验补丁

仅支持应用内部版本 **26.1013.40934** 中已审计的旧式 x64 `@oai/sky/bin/windows/codex-computer-use.exe`。不支持 928、ARM64、Swift 或 `@oai/cua` 中同名的其他 EXE。路径可含 `%40oai` 或 `@oai`，实际文件完整哈希决定支持范围；不依赖安装目录名。

这两项不是解决所有截图问题的通用方案。原来的修改曾减少超时，但未解决截图黑屏。1013 的反汇编、候选 PE、安装/回滚和加载检查不等于真实截图验收。如果应用实际使用 Swift/native-pipe 后端，这两个补丁不会改变它；脚本也不切换后端。

安装前先确认实际运行的辅助进程。1013 已观察到通过原生管道启动 `codex-computer-use-swift.exe` 的情况；仅解析到旧式 helper 路径不代表正在使用它。Swift 后端应跳过这两项补丁，不能为了应用补丁而替换或切换后端。

依赖 Python 3.10+ 和 `pefile`。它们是独立脚本的依赖，主补丁工具仍只需要 Node.js 和 PowerShell。

```powershell
python -m pip install pefile
$helper = 'C:\Apps\Codex\app\resources\cua_node\bin\node_modules\%40oai\sky\bin\windows\codex-computer-use.exe'

# 第一步：光标补丁。prepare 仅在目标旁生成候选与记录，不改变目标。
python .\standalone\cua_cursor_1013.py prepare $helper
# 检查候选后，完全退出 Codex、CLI 和 CUA 辅助进程，再安装。
python .\standalone\cua_cursor_1013.py install $helper

# 第二步：FrameArrived 工作线程补丁，要求光标补丁已安装。
python .\standalone\cua_frame_worker_1013.py prepare $helper
python .\standalone\cua_frame_worker_1013.py install $helper

# 回滚顺序相反，不能跳过工作线程补丁直接回滚光标补丁。
python .\standalone\cua_frame_worker_1013.py restore $helper
python .\standalone\cua_cursor_1013.py restore $helper
```

光标补丁只跳过可选光标接口的查询与设置；工作线程补丁把原截图回调交给 MTA 线程，保留原互斥、委托引用与 ASLR 重定位，并新增异常展开记录。线程或 WinRT 初始化失败时释放引用并清理一次性标志。它们不禁用透明加密、安全软件或捕获保护。

每项分别保留唯一的 `.before-lite-cursor` / `.before-lite-frame-worker` 备份，以及配套候选和 JSON 记录。重复安装或未知文件状态会拒绝覆盖，备份不自动覆盖、删除或跨版本复用。写入保留已有硬链接关系。两个脚本均只接受显式目标路径，且安装/回滚前检查 Codex 与辅助进程已退出。

## 历史图片字段修复

此脚本与应用版本无关，仅修复一份用户明确指定的会话中，一张已有内存 PNG 数据、但历史完成项仍引用本地路径的图片。不会扫描整个会话目录，也不能凭空恢复没有保存的图片。

```powershell
# 图片文件名用于唯一对应原始 response_item 和 item_completed。
node .\standalone\history-image.mjs prepare 'C:\Data\rollout.jsonl' 'codex-clipboard-example.png' 'C:\Data\candidate.jsonl'

# 检查候选后，退出 Codex 与 CLI，再应用；仅写指定会话文件。
node .\standalone\history-image.mjs install 'C:\Data\rollout.jsonl' 'C:\Data\candidate.jsonl'
node .\standalone\history-image.mjs restore 'C:\Data\rollout.jsonl' 'C:\Data\candidate.jsonl'
```

准备时检查图片唯一性、PNG 标识、目标原文和候选路径，保留其他行及换行字节。安装时保存 `.before-lite-image` 备份；应用与回滚均校验配套摘要，有新增会话内容时拒绝覆盖。请保留候选及其 JSON 记录直至完成验收。

## English

These source-only scripts run independently of the main installer. The two experimental CUA patches support only the audited **26.1013.40934 legacy x64 sky helper**, rejecting 928, Swift, ARM64, and other same-named helpers. They do not switch the active backend or promise to fix black screenshots. Python 3.10+ and `pefile` are required only for these scripts.

Check the running helper before installation. Version 1013 has been observed starting `codex-computer-use-swift.exe` through the native pipe; resolving a legacy helper path alone does not establish that it is active. Skip both patches for Swift, and do not replace or switch the backend to make them applicable.

Run cursor `prepare`, inspect its candidate, exit Codex/CLI/helpers, then run cursor `install`. Next run frame-worker `prepare` and `install`. Restore **frame-worker first, cursor second**. Each patch keeps its own fixed backup and manifest, verifies hashes, and refuses unknown states. App updates require fresh adaptation; never copy an old helper over another version.

The Node.js history repair operates on one explicit rollout and image filename. Use `prepare <rollout> <image-name> <candidate>`, then `install <rollout> <candidate>` or `restore <rollout> <candidate>` while Codex is closed. It requires a uniquely matching saved PNG and refuses changed or ambiguous history. Keep the candidate, manifest, and backup for rollback. No private history or images are shipped.
