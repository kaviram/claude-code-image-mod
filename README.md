# image-mod

A Claude Code mod (plugin of function hooks) that gives Claude an image
generation tool and a gallery pane, backed by either **OpenAI** or
**Replicate**. Pick the provider and model in the pane, paste an API key there
if your shell has none, and scroll through everything that was generated.

## What you get

- **`generate_image` tool** that Claude calls like any other tool. It takes a
  prompt, optional provider/model/size/aspect ratio/count/quality, optional
  reference images (edits), and saves PNG/JPG files to disk. The result is the
  list of file paths, so Claude can open them with Read and send them to you.
- **Images pane** (`/images`): provider picker, model picker (OpenAI:
  `gpt-image-1`, `dall-e-3`; Replicate: Flux, Ideogram, Recraft, Imagen,
  Seedream, SD 3.5, or any custom `owner/name`), key entry per provider,
  output folder, and a scrollable gallery of thumbnails with Open / Copy path /
  Remove buttons and Newer / Older paging.
- **`/image <prompt>`** slash command for a one-off generation with the current
  defaults, no model turn needed.

## Keys

Lookup order per provider:

1. `OPENAI_API_KEY` / `REPLICATE_API_TOKEN` in the environment Claude Code was
   started from.
2. A key pasted into the pane. These are kept in the plugin's own store (a JSON
   file under your Claude Code directory) so they survive restarts. Use
   **Forget** in the pane to remove one.

Only one key is needed. A provider without a key is shown as "(no key)", and a
tool call that leaves `provider` unset falls back to whichever provider has a
key. A call that names a keyless provider explicitly is refused with a message
naming the one that works.

Keys never enter the transcript: the pane handler stores them inside the
plugin, HTTP calls carry them in headers, and `curl` receives them through the
environment rather than the command line.

## Install

Hot reload during a session: load the `plugin-authoring` skill in Claude Code,
write the mod into the session's dev-mods folder, and accept the "Enable hot
reloading" prompt.

Or load it directly:

```bash
claude --plugin-dir /path/to/claude-code-image-mod
```

## Files

- `.claude-plugin/plugin.json` – manifest, points at the type contract
- `hooks/hooks.json` – names the hooks module
- `hooks/register.tsx` – the module: tool, commands, pane, providers
- `types/index.d.ts` – the `$.state` contract (settings, key status, gallery)

Host requirements: macOS `sips` for thumbnails and dimensions, `curl`,
`base64`, `sh`.

## Type-checking

Run `/plugin-types` in Claude Code to write the engine's declarations into
`.claude/types`, then:

```bash
bunx tsc -p tsconfig.json
```
