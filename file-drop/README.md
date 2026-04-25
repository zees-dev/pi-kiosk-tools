# File Drop

Single-file Bun full-stack server for quickly dropping files into a local downloads directory.

## Features

- Upload one or more local files from the browser
- Paste one or more download URLs (one per line)
- Browse files and nested directories in the downloads folder from the web UI
- Delete files or directories from the web UI
- Saves everything into `./downloads/`
- Blocks localhost/private-network URL fetches
- Applies fetch timeout and file-size limits for safer unattended use
- No external dependencies
- Single Bun script: `file-drop.ts`

## Run

```bash
bun run file-drop/file-drop.ts
```

Then open:

```text
http://localhost:3463
```

## Test

```bash
bun test file-drop/file-drop.test.ts
```

## Storage

Downloaded/uploaded files are stored in:

```text
/home/pi/pi-kiosk-tools/file-drop/downloads
```

This directory is gitignored by `file-drop/.gitignore`.
