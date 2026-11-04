# Pi Extension: Claude Code Look

This extension gives [Pi](https://pi.dev) the live status style of Claude Code. It changes only how Pi displays its status, and it does not change prompts, tools, or sessions.

<a id="table-of-contents"></a>
## Table of Contents

- [What You Will See](#what-you-will-see)
- [Requirements](#requirements)
- [Try It Once](#try-it-once)
- [Keep It Enabled](#keep-it-enabled)
- [Remove It](#remove-it)
- [Reading the Token Line](#reading-the-token-line)
- [Known Limits](#known-limits)
- [Development](#development)

## What You Will See

While Pi works, three things change:

```text
Terminal title:   🟢 π - my-project   →   🔴 π - my-project   →   🟢 π - my-project

Working row:      🟢 Running git status

Bottom line:      This round: ↑ ~45.2k ↓ ~1.3k tokens · 12s
```

When Pi finishes, the title returns to `π - my-project`, and the bottom line shows the final figures of that round as `Last round: …` until the next round starts.

[↑ Back to Table of Contents](#table-of-contents)

## Requirements

You need Pi 1.4.0 and a terminal that shows emoji, such as Windows Terminal. The extension has no other runtime requirement, so you do not need `npm install` to use it.

[↑ Back to Table of Contents](#table-of-contents)

## Try It Once

Run this command from any folder, using the path of this project. The extension stays active only for this Pi session:

```powershell
pi -e C:\Users\BLEAC\Documents\claude_projects\coding\outputs\pi_extension_claude_code\src\index.ts
```

[↑ Back to Table of Contents](#table-of-contents)

## Keep It Enabled

This command adds the project to your Pi settings file, `~/.pi/agent/settings.json`. Pi then loads the extension every time it starts:

```powershell
pi install C:\Users\BLEAC\Documents\claude_projects\coding\outputs\pi_extension_claude_code
```

Pi loads the source files directly from this folder. If you move the folder, you must install the extension again.

[↑ Back to Table of Contents](#table-of-contents)

## Remove It

This command removes the extension from your Pi settings and keeps the project files:

```powershell
pi remove C:\Users\BLEAC\Documents\claude_projects\coding\outputs\pi_extension_claude_code
```

[↑ Back to Table of Contents](#table-of-contents)

## Reading the Token Line

A **round** starts when Pi begins working on your prompt, and it ends when Pi has no automatic work left. One round usually contains several model requests, because every tool result leads to another request.

| Symbol | Meaning |
|---|---|
| `↑` | Input tokens of all requests in this round, including cached input. Each request resends the conversation, so this number grows quickly. |
| `↓` | Output tokens of all requests in this round, including reasoning. |
| `(40.0k cached)` | The part of `↑` that the provider served from its cache. |
| `~` | The figure contains an estimate. |
| `· 12s` | Time since the round started. |

The `~` mark exists because many providers report exact usage only when a response ends. During streaming, the extension estimates tokens from the text, and it replaces the estimate with the exact number when the provider reports it. A `~` can remain after you press Escape, because the provider may never report the interrupted response.

Pi's own footer line, directly above the token line, continues to show the totals of the whole session.

[↑ Back to Table of Contents](#table-of-contents)

## Known Limits

- Pi draws its automatic retry and context compaction rows itself, so those rows keep Pi's normal spinner. The title and the token line keep working during them.
- A command that you start yourself with `!` does not count as a round.
- A follow-up message that you queue while Pi works belongs to the running round.
- The legacy Windows console host may show boxes instead of emoji in the title. Windows Terminal shows them correctly.
- The extension is active only in Pi's interactive terminal mode. It does nothing with `pi -p`, `--mode json`, or `--mode rpc`.

[↑ Back to Table of Contents](#table-of-contents)

## Development

These commands run from the project folder and require Node.js 24:

```powershell
npm install        # installs development tools only
npm run typecheck  # checks types against the real Pi declarations
npm test           # runs the unit tests
npm run test:e2e   # runs real Pi in a pseudo-terminal with a scripted model
```

The end-to-end test uses a temporary configuration folder and a fake model. It does not read your credentials, and it does not contact any model service.

The design is described in [specification.md](specification.md), [docs/DTD.md](docs/DTD.md), and [docs/modules/claude-code-look.md](docs/modules/claude-code-look.md).

[↑ Back to Table of Contents](#table-of-contents)
