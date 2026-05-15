# INSTALL

How to install and run `teamagent-memory` v0.2.0-rc.1 locally.

## Prerequisites

- **Node 20+** (`node --version`).
- **Git Bash** on Windows, or any POSIX shell on macOS / Linux. The plugin
  itself runs everywhere Claude Code does; the bash CLI wrapper
  (`bin/teamagent`) requires `bash`. On Windows PowerShell, use
  `node bin/teamagent.cjs ...` directly.
- **Disk**: ~150 MB for `@xenova/transformers` + ONNX runtime binaries; an
  additional **~125 MB** the first time `multilingual-e5-small` weights
  download from HuggingFace into `~/.cache/huggingface/`.

## Recommended: install via the Claude Code marketplace

In a Claude Code session:

```
/plugin marketplace add libz-renlab-ai/Matrix-Plugin-memory
/plugin install teamagent-memory@matrix-plugin-memory
```

Claude Code handles `npm install` for you. First Stop hook in any session
will trigger the model download (one-time, then cached).

## Local development install

```bash
git clone https://github.com/libz-renlab-ai/Matrix-Plugin-memory
cd Matrix-Plugin-memory/plugins/teamagent-memory
npm install            # see China network note below
```

Then point Claude Code at the worktree directly:

```bash
claude --plugin-dir plugins/teamagent-memory --debug
```

### China network note

The default npm registry sometimes fails (ECONNRESET) when fetching
`onnxruntime-node` prebuilt binaries from GitHub CDN behind the GFW. Use
npmmirror:

```bash
npm install --registry=https://registry.npmmirror.com
```

Or set it persistently for this project:

```bash
echo 'registry=https://registry.npmmirror.com' > .npmrc
```

(Do **not** commit `.npmrc` to upstream — it's a China-specific override.)

### HuggingFace model

The first `embedText` call downloads
`Xenova/multilingual-e5-small` (~125 MB) into `~/.cache/huggingface/`.
Subsequent runs are offline. On slow networks the first call can take
**3–10 minutes**. Hooks are designed to tolerate this — they fall back to
fast-path-only matching until the model is ready.

To pre-warm the model (optional):

```bash
cd plugins/teamagent-memory
node -e "(async () => { const { embedText } = require('./hooks/lib/embed.cjs'); await embedText('warmup'); console.log('model ready'); })()"
```

## Verify

```bash
cd plugins/teamagent-memory
npm test        # 128 tests in 24 files; ~30s after model cached, ~5min cold
node bin/teamagent.cjs doctor
# expected output:
#   knowledge  <repo>/.teamagent/knowledge.db  schema=2  ok
#   global     ~/.teamagent/global.db          schema=2  ok
#   events     ~/.teamagent/events.db          schema=1  ok
```

## Storage paths

| Path | Content |
|---|---|
| `<repo>/.teamagent/knowledge.db` | Project rules (add to repo `.gitignore`) |
| `~/.teamagent/global.db` | Cross-project user rules |
| `~/.teamagent/events.db` | Hook event audit log |
| `~/.cache/huggingface/` | ONNX model weights (managed by `@xenova/transformers`) |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot find module '@xenova/transformers'` | Skipped `npm install` | `cd plugins/teamagent-memory && npm install` |
| `prebuild-install` ECONNRESET | China network → GitHub CDN | Add `--registry=https://registry.npmmirror.com` |
| First match takes 30+ seconds | Model downloading | Pre-warm (see above) or wait once |
| `bin/teamagent: command not found` on PowerShell | Bash shebang doesn't resolve | Use `node bin/teamagent.cjs ...` |
| Hook not firing | `${CLAUDE_PLUGIN_ROOT}` not expanded | Confirm `claude --debug` discovers `hooks/hooks.json`; check Node 20+ |
| `Vitest cannot be imported in a CommonJS module` | Old test file with `require("vitest")` | Use the project's `vitest.config.js` (`globals: true`); don't `require("vitest")` |
| Schema mismatch after upgrade | Manual edit / partial run | `mv ~/.teamagent/global.db ~/.teamagent/global.db.bak` and re-open session |

## Uninstall

```bash
# In a Claude Code session:
/plugin uninstall teamagent-memory@matrix-plugin-memory

# To purge local data:
rm -rf ~/.teamagent
rm -rf .teamagent     # per repo
```
