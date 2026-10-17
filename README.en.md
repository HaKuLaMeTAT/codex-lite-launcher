# Codex Lite Launcher

[简体中文](README.md) | **English**

Optional performance patches for the Windows Codex desktop app. Reduce hidden-window preloading, batch frequent output and refresh events, and avoid unnecessary background work.

- **Choose your optimizations**: 14 options, all enabled by default, with a configurable inactive-session timeout.
- **Two deployment modes**: patch an existing installation in place or create a separate optimized copy.
- **Rollback support**: in-place upgrades retain paired backups and a record of selected options.
- **Source only**: run locally with Node.js and PowerShell; no npm dependency installation required.

This is an unofficial project with no affiliation with or endorsement from OpenAI. The repository provides tool source code only, not Codex installers, modified EXE/ASAR files, or packaged executables.

## Quick start

### Requirements

| Item | Requirement |
|---|---|
| OS | Windows, with read/write access to the target directory |
| Runtime | Windows PowerShell 5.1 and Node.js 20+ |
| Codex | A complete desktop installation; currently supports **`26.928.20755`** only |
| Resources | Several GB of available memory during generation; disk requirements depend on the mode below |

The supported app version is defined by `VERSION` in [patch.mjs](patch.mjs). Unknown versions are rejected. Deselecting optimizations does not bypass the version check.

### Launch the tool

Clone the repository, or select **Code → Download ZIP** on GitHub and extract the source:

```powershell
git clone https://github.com/HaKuLaMeTAT/codex-lite-launcher.git
cd codex-lite-launcher
.\启动补丁.cmd
```

You can also double-click `启动补丁.cmd` in File Explorer. You do not need to run `npm install`.

The launcher currently uses Chinese labels. Their English meanings are included below:

1. Confirm the detected Codex installation, or click **选择来源** (Select source).
2. Choose **原位升级** (In-place upgrade) or **独立副本** (Separate copy), select your optimizations, and adjust **会话保留** (Session retention) if needed.
3. Click **原位升级** (In-place upgrade) or **生成副本** (Generate copy) directly. The operation validates the source and current options before making changes.
4. **检查来源** (Check source) is optional for previewing compatibility and disk requirements. Changing parameters does not require another manual check.

## Choose a deployment mode

| | In-place upgrade | Separate copy |
|---|---|---|
| App files | Updates the paired EXE and ASAR in the existing installation | Creates a complete optimized app in a new directory, preserving the source installation |
| Launch method | Use your existing launch method | Use `启动优化版.cmd` inside the copy |
| Additional disk space | About 1.02 GiB free for the first upgrade; about 0.51 GiB retained as backups afterward | About 2.2 GiB |
| Undo | Run **原位回滚** (In-place rollback) in the tool | Exit the copy and launch the source installation as usual |

Disk figures come from the currently supported app version. Use the check results for the actual estimate. The tool does not automatically close or launch Codex or change shortcuts.

### In-place upgrade and rollback

After selecting the source and options, fully exit the Codex desktop app and Codex CLI. Keep the patch tool open and click **原位升级** (In-place upgrade). When the tool displays **补丁应用成功** (Patch applied successfully), launch Codex as usual.

The first in-place upgrade processes the EXE and ASAR together and saves one baseline backup pair, suffixed `.before-lite-v5`, plus the option record `codex-lite-install.json`. Within the same Codex app version, later patch upgrades (for example, 0.7.0 → 0.8.0) and option changes reuse this pair. They do not add version-specific backups or overwrite the baseline. Temporary staging space is still required. **Keep these files together. Do not replace only the EXE or only the ASAR.**

To roll back, exit Codex, check the installation again in in-place mode, and click **原位回滚** (In-place rollback). Rollback restores the original baseline backup pair, regardless of the currently selected options; it does not step back through patch versions. To change the optimization set, select and apply it directly, without rolling back first. Existing backups are reused; the tool does not reconstruct an official unmodified installation from them. If replacement fails partway through, keep Codex closed, check again, and roll back.

### Create and use a separate copy

Choose an output directory that does not exist yet and click **生成副本** (Generate copy). The operation checks the source automatically. The default destination is `copies/Codex-optimized` under the tool directory. You can keep using the source installation during generation, but do not update it at the same time.

Once generation finishes, exit other Codex desktop processes and double-click `启动优化版.cmd` inside the copy. This entry point checks the core files against the manifest. To change the optimization set, generate another copy in a new directory; existing directories are not overwritten. Failed generation retains a `.building` directory for inspection. Do not launch the app from it.

**Only the application files are separate. Accounts and settings still use their default locations.** This is not an isolated user-data environment. Run only one Codex desktop version at a time.

## Available optimizations

All options are enabled by default. Both modes use the same patch logic. Deselected options skip their code transformations and corresponding match checks.

| Optimization | Behavior and trade-off |
|---|---|
| Create the pet overlay on demand | Removes early creation while preserving normal opening; the first opening may be slower |
| Create hotkey windows on demand | Removes Home/Thread window preloading; the first hotkey invocation may be slower |
| Create detached windows on demand | Removes spare-window preloading; the first detach operation may be slower |
| Load the purchase page on demand | Disables purchase-page prewarming while retaining the explicit purchase entry point |
| Load the credit top-up page on demand | Disables top-up-page prewarming while retaining the explicit top-up entry point |
| Batch app menu refreshes | Refreshes immediately once, then batches continuous changes over about 250 ms; session synchronization still runs for each change |
| Batch terminal output | Delivers the first chunk after idle immediately, then batches over about 8 ms; flushes large batches early and pending output before exit, without dropping output |
| Target command-output updates | Narrows updates for known command items in the latest fully loaded turn; uses the original update path when conditions are not met |
| Merge text nodes after animation | Merges consecutive plain-text fragments after fade-in completes; preserves links, decorations, and fragments still animating |
| Reuse code-language detection | Reduces repeated automatic detection, with corrections as content changes and after streaming stops; explicit languages remain unchanged, and timer cleanup is enabled with this option |
| Batch MCP tool-list refreshes | Handles the first ready event immediately and adds one trailing refresh for repeats within 200 ms; failure, authorization, and other handling remain unchanged |
| Launch app tools directly with Node | Bypasses the CMD wrapper for local Windows app tools while preserving permissions, environment, and tools; leaves WSL unchanged |
| Unsubscribe inactive sessions after a timeout | Defaults to 5 minutes; accepts 1–180 minutes and retains the original release checks; reopening may recreate tools |
| Share the app-tools channel | Local Windows `codex_app` connections use the existing desktop main process, removing per-session Node/CMD adapters while retaining the original handlers and approval configuration |

When you switch away, the hidden page releases its active-session lease while its content can remain cached. Returning reacquires the lease. The inactivity timer no longer waits for the roughly 10-minute page cache to expire first.

With the session option enabled, **会话保留** (Session retention) accepts **integer minutes from 1 to 180, defaulting to 5**. Deselect the option to keep the original 3-hour policy. On startup, the GUI reads the timeout from the selected installation record; an explicit `-InactiveMinutes` argument takes precedence. Change the value and apply directly without manually checking again. Exit Codex, apply the patch, and restart for it to take effect.

The timeout is saved alongside the selected options in the installation record or copy manifest. Repeated upgrades reuse the same baseline backups; rollback validates the recorded settings independently of the current UI value. The original capacity rule of up to 10 inactive sessions remains, so this timeout is not a minimum retention guarantee. Running sessions, active views, and other subscribers retain their original protection.

The shared channel applies only to standard local Windows app-tools configurations. Each list or call reads the current desktop catalog and dispatches through the original handlers. The existing backend connects to a loopback-only HTTP endpoint with a random credential; the app's existing synchronization flow updates the local plugin configuration. WSL, remote-executor exports, and custom launch arguments retain their original paths. When both app-tools options are selected, the shared channel takes precedence for standard local configurations.

CUA, REPL, and code-review services do not use the shared channel. This does not make every MCP server start on first use. The default timeout remains 5 minutes; increasing it can reduce session recreation while retaining other tools for longer.

**Unsubscribing does not guarantee immediate tool-process exit.** The backend still controls actual cleanup. The [official SessionEnd documentation](https://learn.chatgpt.com/docs/hooks#sessionend) describes an idle cleanup period of about 30 minutes without connected clients; this is not a measured exit deadline for the installed binary. After cleanup, reopening a session may need to recreate tools, and in-memory state such as REPL variables is not guaranteed to survive. The tool does not forcibly kill processes or delete conversation history. This option does not defer tool startup until its first invocation.

See [options.json](options.json) for option IDs. Selecting none adds no optimizations: in-place mode leaves a clean installation unchanged and creates no backups; copy mode still copies the runtime files.

Use an unmodified source installation for full control over every option. Previously patched installations are accepted only when their state can be verified. An existing optimization that cannot be reversed cannot be removed by deselecting it.

## Performance observations

The following sample was taken during early on-demand loading optimization work on 2026-10-16, using Codex `26.928.20755`, 8 logical processors, and approximately 16 GiB of RAM. It covers only the `ChatGPT.exe` desktop process group, excluding backend and tool subprocesses.

| Metric | Before | After | Difference |
|---|---:|---:|---:|
| Desktop processes | 13 | 10 | −3 |
| Renderer processes | 6 | 3 | −3 |
| Total desktop private memory | 1,827.1 MiB | 1,185.5 MiB | −641.6 MiB (35.1%) |
| Main-process private memory | 372.3 MiB | 386.7 MiB | +14.4 MiB |
| Average CPU during sampling | 2.70% | 0.87% | −1.83 percentage points |

**These are historical observations, not a controlled benchmark or a performance guarantee.** The before sample lasted about 61 seconds after 11–12 minutes of app uptime; the after sample lasted about 30 seconds after 4–5 minutes of uptime. Sessions, activity, and window states were not controlled, so the full difference cannot be attributed to the patches. CPU is normalized to total machine capacity at 100%; memory figures use private memory.

These figures do not represent every option combination or independently measure the later output, highlighting, refresh, and session-unsubscribe optimizations. The project does not claim to fix long-term memory leaks. Only an anonymized summary is published, not raw personal sampling logs.

In isolated tests on 2026-10-17, the original app-tools chain used `cmd.exe + node.exe + conhost.exe`; direct Node launch used `node.exe + conhost.exe`, saving one process. The shared channel then passed caller-metadata checks across two sessions using the real `codex-cli 0.159.0` backend. It discovered 55 tools from the running desktop and completed two read-only project-list calls without starting stdio adapter workers. These results are not desktop-wide process measurements. Full desktop behavior, approval interactions, memory, and CPU benefits after installation still need measurement.

## Compatibility and updates

- Uses AST-based matching and checks app identity, version, structure, and hashes. It does not depend on fixed byte offsets, but each app version still needs explicit adaptation.
- ASAR changes are limited to modules affected by selected optimizations, their hashes, and necessary offsets. The EXE receives the corresponding ASAR header hash update; integrity checking is not disabled.
- Modifying the EXE invalidates its original Authenticode signature. The tool does not re-sign it. Generated manifests provide consistency checks, not digital signatures.
- Sources containing filesystem links are not currently supported. Compatibility with other third-party patches is not guaranteed.
- The tool does not elevate privileges automatically. Script entry points set execution policy only for the current PowerShell process, not globally.

The project does not modify Codex's in-app update mechanism or automatically adapt to new versions. Recheck support after a Codex update: updates may overwrite in-place optimizations, and separate copies need to be regenerated from a supported source. Do not restore old backups over a different app version.

## Command line and development

Replace these example paths with your installation location. `inspect` is read-only. Fully exit the Codex desktop app and CLI before running in-place `apply` or `restore`.

```powershell
# In place: inspect, apply, and restore
node .\inplace.mjs inspect 'C:\Apps\Codex\app\resources\app.asar'
node .\inplace.mjs apply 'C:\Apps\Codex\app\resources\app.asar'
node .\inplace.mjs restore 'C:\Apps\Codex\app\resources\app.asar'

# Separate copy: inspect, create, and verify
node .\copy.mjs inspect 'C:\Apps\Codex\app\resources\app.asar'
node .\copy.mjs create 'C:\Apps\Codex\app\resources\app.asar' 'C:\Apps\Codex-optimized'
node .\copy.mjs verify 'C:\Apps\Codex-optimized'
```

Omitting `--options` selects all optimizations. Inspection, application, and generation commands accept comma-separated option IDs; `--options=none` selects none. Rollback and copy verification do not accept option arguments.

Inspection, application, and generation also accept `--inactive-minutes=15`, defaulting to 5 when omitted. It changes the session policy only when `inactive-thread-unsubscribe` is selected. To set the GUI's initial value, run `powershell -File .\launcher.ps1 -InactiveMinutes 15`.

```powershell
# Select only menu refresh batching and terminal output batching
node .\inplace.mjs inspect 'C:\Apps\Codex\app\resources\app.asar' --options=menu,batched-pty-output
node .\inplace.mjs apply 'C:\Apps\Codex\app\resources\app.asar' --options=menu,batched-pty-output

# Select all optimizations and retain inactive sessions for 15 minutes
node .\inplace.mjs apply 'C:\Apps\Codex\app\resources\app.asar' --inactive-minutes=15

# Run automated tests
npm test

# Optional: include read-only checks against a real installation;
# this test is skipped when the variable is not set
$env:CODEX_TEST_ASAR = 'C:\Apps\Codex\app\resources\app.asar'
npm test
```

Option names and dependencies are maintained in [options.json](options.json). Core transformations live in [patch.mjs](patch.mjs) and [runtime-patches.mjs](runtime-patches.mjs). See [VALIDATION.md](VALIDATION.md) (Chinese) for completed checks and remaining coverage gaps. Syntax, structural, and startup checks do not replace full desktop feature acceptance testing.

## Credits and license

Some transformation rules are adapted from [Codex++](https://github.com/b-nnett/codex-plusplus), based on `Sources/CodexPPCore/Resources/startup-adapter.js` at commit `13d0c2421cc4258565710910ca8dfe60344c027e`.

This project is licensed under the [MIT License](LICENSE). Third-party notices are available in the [Codex++ license](vendor/CODEXPP-LICENSE) and [Acorn license](vendor/ACORN-LICENSE).
