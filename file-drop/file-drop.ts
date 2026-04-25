/**
 * File Drop - Single-file Bun full-stack server
 *
 * Accepts direct file uploads and one-or-more download URLs, then stores the
 * resulting files in the local gitignored downloads directory.
 *
 * Usage:
 *   bun run file-drop/file-drop.ts
 * Then open:
 *   http://localhost:3463
 */

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "fs";
import { isIP } from "net";
import { basename, dirname, extname, join } from "path";
import { lookup as dnsLookup } from "dns/promises";
import { fileURLToPath } from "url";

export type SavedFile = {
  name: string;
  bytes: number;
  source: "upload" | "url";
  url?: string;
};

export type ListedFile = {
  name: string;
  bytes: number;
  modifiedAt: string;
};

export type TreeEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  bytes: number;
  modifiedAt: string;
  children?: TreeEntry[];
};

export type AppOptions = {
  downloadsDir?: string;
  fetchImpl?: typeof fetch;
  lookupImpl?: typeof dnsLookup;
  port?: number;
  host?: string;
  maxRequestBodySize?: number;
};

type AppConfig = {
  downloadsDir: string;
  fetchImpl: typeof fetch;
  lookupImpl: typeof dnsLookup;
  port: number;
  host: string;
  maxRequestBodySize: number;
};

type TaskStatus = "running" | "completed" | "failed";

type TaskProgress = {
  phase: string;
  currentItem: string | null;
  completedBytes: number;
  totalBytes: number | null;
  uploadCompleted: number;
  uploadTotal: number;
  urlCompleted: number;
  urlTotal: number;
};

type IngestTask = {
  id: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  saved: SavedFile[];
  errors: string[];
  progress: TaskProgress;
};

type AppState = {
  tasks: Map<string, IngestTask>;
};

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOWNLOADS_DIR = join(APP_DIR, "downloads");
const DEFAULT_PORT = 3463;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.FILE_DROP_FETCH_TIMEOUT_MS || 30000);
const DEFAULT_MAX_FILE_BYTES = Number(process.env.FILE_DROP_MAX_FILE_BYTES || (8 * 1024 * 1024 * 1024));
const DEFAULT_MAX_REQUEST_BODY_BYTES = Number(process.env.FILE_DROP_MAX_REQUEST_BODY_BYTES || DEFAULT_MAX_FILE_BYTES);

function nowIso(): string {
  return new Date().toISOString();
}

function cloneTask(task: IngestTask): IngestTask {
  return JSON.parse(JSON.stringify(task)) as IngestTask;
}

function updateTask(task: IngestTask, mutate: (task: IngestTask) => void): void {
  mutate(task);
  task.updatedAt = nowIso();
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function ensureDownloadsDir(downloadsDir: string): void {
  mkdirSync(downloadsDir, { recursive: true });
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "-")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned || "download.bin";
}

function uniqueFilename(downloadsDir: string, desiredName: string): string {
  const ext = extname(desiredName);
  const stem = desiredName.slice(0, desiredName.length - ext.length) || desiredName;
  let candidate = desiredName;
  let counter = 2;
  while (existsSync(join(downloadsDir, candidate))) {
    candidate = `${stem}-${counter}${ext}`;
    counter += 1;
  }
  return candidate;
}

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;

  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const quotedMatch = header.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) return quotedMatch[1];

  const bareMatch = header.match(/filename=([^;]+)/i);
  if (bareMatch?.[1]) return bareMatch[1].trim();

  return null;
}

function inferFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const lastPathPart = basename(decodeURIComponent(parsed.pathname));
    if (lastPathPart && lastPathPart !== "/") return lastPathPart;
  } catch {
    // handled elsewhere; fallback below
  }
  return "download.bin";
}

export function parseUrlList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isPrivateIpAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  const family = isIP(normalized);
  if (family === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }

  if (family === 6) {
    return normalized === "::1"
      || normalized === "::"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe80:")
      || normalized.startsWith("::ffff:127.")
      || normalized.startsWith("::ffff:10.")
      || normalized.startsWith("::ffff:192.168.")
      || /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(normalized);
  }

  return false;
}

async function validateDownloadUrl(parsedUrl: URL, lookupImpl: typeof dnsLookup): Promise<string | null> {
  const hostname = parsedUrl.hostname.trim().toLowerCase();
  if (!hostname) return `Invalid URL: ${parsedUrl.toString()}`;
  if (hostname === "localhost" || hostname.endsWith(".local")) {
    return `Blocked private or local URL: ${parsedUrl.toString()}`;
  }
  if (isPrivateIpAddress(hostname)) {
    return `Blocked private or local URL: ${parsedUrl.toString()}`;
  }

  try {
    const results = await lookupImpl(hostname, { all: true, verbatim: true });
    if (!results.length) {
      return `Failed to resolve ${parsedUrl.toString()}`;
    }
    if (results.some((entry) => isPrivateIpAddress(entry.address))) {
      return `Blocked private or local URL: ${parsedUrl.toString()}`;
    }
  } catch {
    return `Failed to resolve ${parsedUrl.toString()}`;
  }

  return null;
}

async function fetchWithValidatedRedirects(
  startUrl: URL,
  fetchImpl: typeof fetch,
  lookupImpl: typeof dnsLookup,
): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = new URL(startUrl.toString());

  for (let redirects = 0; redirects < 5; redirects += 1) {
    const response = await fetchImpl(currentUrl.toString(), {
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
      redirect: "manual",
    });

    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: currentUrl };
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Redirect missing location header: ${currentUrl.toString()}`);
    }

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
      throw new Error(`Unsupported URL protocol for ${nextUrl.toString()}`);
    }

    const validationError = await validateDownloadUrl(nextUrl, lookupImpl);
    if (validationError) {
      throw new Error(validationError);
    }

    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects for ${startUrl.toString()}`);
}

async function writeResponseToFile(
  response: Response,
  targetPath: string,
  onProgress?: (completedBytes: number, totalBytes: number | null) => void,
): Promise<number> {
  const tempPath = `${targetPath}.part`;
  const reader = response.body?.getReader();
  if (!reader) {
    await Bun.write(targetPath, "");
    onProgress?.(0, 0);
    return 0;
  }

  let totalBytes = 0;
  const contentLengthHeader = Number(response.headers.get("content-length") || 0);
  const declaredTotal = Number.isFinite(contentLengthHeader) && contentLengthHeader > 0 ? contentLengthHeader : null;
  const fd = openSync(tempPath, "w");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > DEFAULT_MAX_FILE_BYTES) {
        throw new Error(`File exceeds ${DEFAULT_MAX_FILE_BYTES} bytes limit`);
      }
      writeSync(fd, value);
      onProgress?.(totalBytes, declaredTotal);
    }
  } catch (error) {
    closeSync(fd);
    rmSync(tempPath, { force: true });
    throw error;
  }

  closeSync(fd);
  renameSync(tempPath, targetPath);
  onProgress?.(totalBytes, declaredTotal ?? totalBytes);
  return totalBytes;
}

function listFiles(downloadsDir: string): ListedFile[] {
  ensureDownloadsDir(downloadsDir);
  return readdirSync(downloadsDir)
    .map((name) => {
      const fullPath = join(downloadsDir, name);
      const stat = statSync(fullPath);
      return {
        name,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
      };
    })
    .filter((entry) => Number.isFinite(entry.bytes))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ mtimeMs: _mtimeMs, ...entry }) => entry);
}

function sanitizeRelativePath(input: string): string | null {
  const trimmed = input.trim().replace(/\\/g, "/");
  if (!trimmed) return null;
  if (trimmed.startsWith("/") || trimmed.includes("\0")) return null;

  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  return segments.join("/");
}

function resolveDownloadsPath(downloadsDir: string, relativePath: string): string | null {
  const safeRelativePath = sanitizeRelativePath(relativePath);
  if (!safeRelativePath) return null;

  const segments = safeRelativePath.split("/");
  let currentPath = downloadsDir;
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    try {
      const stat = lstatSync(currentPath);
      if (stat.isSymbolicLink()) return null;
    } catch {
      return currentPath;
    }
  }

  const normalizedRoot = downloadsDir.endsWith("/") ? downloadsDir : `${downloadsDir}/`;
  if (!currentPath.startsWith(normalizedRoot)) return null;
  return currentPath;
}

function buildTreeEntries(rootDir: string, currentDir = rootDir, parentPath = ""): TreeEntry[] {
  return readdirSync(currentDir)
    .flatMap((name) => {
      const fullPath = join(currentDir, name);
      const relativePath = parentPath ? `${parentPath}/${name}` : name;
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        return [];
      }

      const entry: TreeEntry = {
        name,
        path: relativePath,
        type: stat.isDirectory() ? "directory" : "file",
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };

      if (stat.isDirectory()) {
        entry.children = buildTreeEntries(rootDir, fullPath, relativePath);
      }

      return [{ ...entry, mtimeMs: stat.mtimeMs } as TreeEntry & { mtimeMs: number }];
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    })
    .map(({ mtimeMs: _mtimeMs, ...entry }) => entry);
}

function listTree(downloadsDir: string): TreeEntry[] {
  ensureDownloadsDir(downloadsDir);
  return buildTreeEntries(downloadsDir);
}

async function saveUploadedFiles(
  downloadsDir: string,
  files: File[],
  onProgress?: (update: { completed: number; total: number; currentItem: string }) => void,
): Promise<{ saved: SavedFile[]; errors: string[] }> {
  const saved: SavedFile[] = [];
  const errors: string[] = [];

  for (const [index, file] of files.entries()) {
    if (file.size > DEFAULT_MAX_FILE_BYTES) {
      errors.push(`Upload exceeds ${DEFAULT_MAX_FILE_BYTES} bytes limit: ${file.name}`);
      continue;
    }

    const desiredName = sanitizeFilename(file.name || "upload.bin");
    const finalName = uniqueFilename(downloadsDir, desiredName);
    const targetPath = join(downloadsDir, finalName);
    await Bun.write(targetPath, file);
    saved.push({
      name: finalName,
      bytes: file.size,
      source: "upload",
    });
    onProgress?.({ completed: index + 1, total: files.length, currentItem: finalName });
  }

  return { saved, errors };
}

async function saveUrlDownloads(
  downloadsDir: string,
  urls: string[],
  fetchImpl: typeof fetch,
  lookupImpl: typeof dnsLookup,
  onProgress?: (update: {
    completed: number;
    total: number;
    currentItem: string;
    completedBytes: number;
    totalBytes: number | null;
    phase: string;
  }) => void,
): Promise<{ saved: SavedFile[]; errors: string[] }> {
  const saved: SavedFile[] = [];
  const errors: string[] = [];

  for (const [index, url] of urls.entries()) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      errors.push(`Invalid URL: ${url}`);
      continue;
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      errors.push(`Unsupported URL protocol for ${url}`);
      continue;
    }

    const validationError = await validateDownloadUrl(parsedUrl, lookupImpl);
    if (validationError) {
      errors.push(validationError);
      continue;
    }

    onProgress?.({
      completed: index,
      total: urls.length,
      currentItem: url,
      completedBytes: 0,
      totalBytes: null,
      phase: `Downloading ${url}`,
    });

    let response: Response;
    try {
      ({ response } = await fetchWithValidatedRedirects(parsedUrl, fetchImpl, lookupImpl));
    } catch (error: any) {
      errors.push(error?.message || `Failed to fetch ${url}: request error`);
      continue;
    }

    if (!response.ok) {
      errors.push(`Failed to fetch ${url}: HTTP ${response.status}`);
      continue;
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > DEFAULT_MAX_FILE_BYTES) {
      errors.push(`Download exceeds ${DEFAULT_MAX_FILE_BYTES} bytes limit: ${url}`);
      continue;
    }

    const preferredName = parseContentDispositionFilename(response.headers.get("content-disposition"))
      || inferFilenameFromUrl(url);
    const finalName = uniqueFilename(downloadsDir, sanitizeFilename(preferredName));
    const targetPath = join(downloadsDir, finalName);

    try {
      const bytes = await writeResponseToFile(response, targetPath, (completedBytes, totalBytes) => {
        onProgress?.({
          completed: index,
          total: urls.length,
          currentItem: finalName,
          completedBytes,
          totalBytes,
          phase: `Downloading ${finalName}`,
        });
      });
      saved.push({
        name: finalName,
        bytes,
        source: "url",
        url,
      });
      onProgress?.({
        completed: index + 1,
        total: urls.length,
        currentItem: finalName,
        completedBytes: bytes,
        totalBytes: bytes,
        phase: `Downloaded ${finalName}`,
      });
    } catch (error: any) {
      errors.push(`Failed to save ${url}: ${error?.message || "write error"}`);
    }
  }

  return { saved, errors };
}

function renderEntriesMarkup(entries: TreeEntry[]): string {
  if (!entries.length) {
    return '<div class="muted">Downloads folder is empty.</div>';
  }

  const renderList = (items: TreeEntry[]) => '<ul class="tree-list">' + items.map((entry) => {
    const label = entry.type === "directory" ? "📁" : "📄";
    const pathHref = entry.path.split("/").map(encodeURIComponent).join("/");
    const name = entry.name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const link = entry.type === "file"
      ? `<a class="entry-name" href="/downloads/${pathHref}">${name}</a>`
      : `<span class="entry-name">${name}</span>`;
    const meta = `<span class="tree-meta">${entry.bytes.toLocaleString("en-NZ")} bytes — ${new Date(entry.modifiedAt).toLocaleString("en-NZ")}</span>`;
    const deleteButton = `<button class="delete-btn" type="button" data-path="${entry.path.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">Delete</button>`;
    const children = entry.children?.length ? renderList(entry.children) : "";
    return `<li><div class="tree-entry"><span>${label}</span>${link}${meta}${deleteButton}</div>${children}</li>`;
  }).join("") + "</ul>";

  return renderList(entries);
}

function renderPage(downloadsDir: string): string {
  const escapedDir = downloadsDir.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const initialTreeMarkup = renderEntriesMarkup(listTree(downloadsDir));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>File Drop</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      font-family: Inter, system-ui, sans-serif;
      background: #111827;
      color: #f9fafb;
      min-height: 100vh;
    }
    main {
      max-width: 860px;
      margin: 0 auto;
      padding: 32px 20px 60px;
    }
    .card {
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.22);
      margin-bottom: 20px;
    }
    h1, h2 { margin-top: 0; }
    p { color: #d1d5db; }
    label {
      display: block;
      font-weight: 700;
      margin: 16px 0 8px;
    }
    input[type="file"], textarea {
      width: 100%;
      box-sizing: border-box;
      border-radius: 10px;
      border: 1px solid #4b5563;
      background: #111827;
      color: #f9fafb;
      padding: 12px;
    }
    textarea { min-height: 140px; resize: vertical; }
    button {
      border: 0;
      border-radius: 999px;
      background: #2563eb;
      color: white;
      font-size: 16px;
      font-weight: 700;
      padding: 12px 18px;
      cursor: pointer;
      margin-top: 16px;
    }
    button:disabled { opacity: 0.65; cursor: wait; }
    .muted { color: #9ca3af; }
    .upload-activity {
      margin-top: 18px;
      padding: 14px;
      border-radius: 12px;
      border: 1px solid #374151;
      background: #0f172a;
    }
    .upload-activity-row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .upload-spinner {
      width: 14px;
      height: 14px;
      margin-top: 3px;
      border-radius: 999px;
      border: 2px solid rgba(147, 197, 253, 0.25);
      border-top-color: #93c5fd;
      animation: spin 0.9s linear infinite;
      flex: 0 0 auto;
    }
    .upload-progress-copy {
      flex: 1;
      min-width: 0;
    }
    .upload-progress-label {
      font-weight: 700;
      color: #f9fafb;
    }
    .upload-progress-detail {
      margin-top: 4px;
      font-size: 14px;
      white-space: pre-wrap;
    }
    .upload-progress-track {
      margin-top: 12px;
      width: 100%;
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
      background: rgba(59, 130, 246, 0.18);
    }
    .upload-progress-bar {
      height: 100%;
      width: 0%;
      border-radius: inherit;
      background: linear-gradient(90deg, #2563eb, #60a5fa);
      transition: width 0.2s ease;
    }
    .upload-activity[data-mode="indeterminate"] .upload-progress-bar {
      width: 35%;
      animation: indeterminate-slide 1.2s ease-in-out infinite;
    }
    .upload-activity[data-mode="determinate"] .upload-progress-bar {
      animation: none;
    }
    #status {
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, monospace;
      background: #0f172a;
      border-radius: 10px;
      padding: 12px;
      min-height: 52px;
    }
    ul { margin: 0; padding-left: 20px; }
    li { margin: 6px 0; }
    .tree-list, .tree-list ul {
      list-style: none;
      margin: 0;
      padding-left: 18px;
    }
    .tree-list {
      padding-left: 0;
    }
    .tree-entry {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin: 6px 0;
    }
    .tree-meta {
      color: #9ca3af;
      font-size: 13px;
    }
    .delete-btn {
      background: #dc2626;
      margin-top: 0;
      padding: 6px 12px;
      font-size: 13px;
    }
    .delete-btn:disabled {
      cursor: wait;
    }
    .entry-name {
      font-weight: 600;
    }
    code {
      background: #0f172a;
      padding: 2px 6px;
      border-radius: 6px;
    }
    a { color: #93c5fd; }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @keyframes indeterminate-slide {
      0% { transform: translateX(-120%); }
      50% { transform: translateX(40%); }
      100% { transform: translateX(220%); }
    }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>Upload files</h1>
      <p>Upload one or more local files and/or provide one download URL per line. Everything is saved into <code>${escapedDir}</code>.</p>
      <form id="ingestForm">
        <label for="files">Files</label>
        <input id="files" name="files" type="file" multiple />

        <label for="urls">Download URLs</label>
        <textarea id="urls" name="urls" placeholder="https://example.com/file.iso\nhttps://example.com/another.rvz"></textarea>

        <button id="submitButton" type="submit">Save into downloads/</button>

        <div id="uploadActivity" class="upload-activity" data-mode="indeterminate" hidden>
          <div class="upload-activity-row">
            <span class="upload-spinner" aria-hidden="true"></span>
            <div class="upload-progress-copy">
              <div id="uploadProgressLabel" class="upload-progress-label">Preparing upload…</div>
              <div id="uploadProgressDetail" class="upload-progress-detail muted"></div>
            </div>
          </div>
          <div class="upload-progress-track" aria-hidden="true">
            <div id="uploadProgressBar" class="upload-progress-bar"></div>
          </div>
        </div>
      </form>
    </section>

    <section class="card">
      <h2>Status</h2>
      <div id="status">Ready.</div>
    </section>

    <section class="card">
      <h2>Downloads browser</h2>
      <p class="muted">Browse files and directories under the downloads folder. Delete entries you no longer want.</p>
      <div id="treeContainer">${initialTreeMarkup}</div>
    </section>
  </main>

  <script>
    const form = document.getElementById('ingestForm');
    const button = document.getElementById('submitButton');
    const statusBox = document.getElementById('status');
    const uploadActivity = document.getElementById('uploadActivity');
    const uploadProgressLabel = document.getElementById('uploadProgressLabel');
    const uploadProgressDetail = document.getElementById('uploadProgressDetail');
    const uploadProgressBar = document.getElementById('uploadProgressBar');
    const treeContainer = document.getElementById('treeContainer');
    let activeTaskPoll = null;

    function formatBytes(bytes) {
      return new Intl.NumberFormat().format(bytes) + ' bytes';
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function renderEntries(entries) {
      if (!entries.length) {
        return '<div class="muted">Downloads folder is empty.</div>';
      }

      const renderList = (items) => '<ul class="tree-list">' + items.map((entry) => {
        const label = entry.type === 'directory' ? '📁' : '📄';
        const link = entry.type === 'file'
          ? '<a class="entry-name" href="/downloads/' + entry.path.split('/').map(encodeURIComponent).join('/') + '">' + escapeHtml(entry.name) + '</a>'
          : '<span class="entry-name">' + escapeHtml(entry.name) + '</span>';
        const meta = '<span class="tree-meta">' + escapeHtml(formatBytes(entry.bytes)) + ' — ' + escapeHtml(new Date(entry.modifiedAt).toLocaleString()) + '</span>';
        const deleteButton = '<button class="delete-btn" type="button" data-path="' + escapeHtml(entry.path) + '">Delete</button>';
        const children = entry.children?.length ? renderList(entry.children) : '';
        return '<li><div class="tree-entry"><span>' + label + '</span>' + link + meta + deleteButton + '</div>' + children + '</li>';
      }).join('') + '</ul>';

      return renderList(entries);
    }

    function setProgress(label, detail = '', percent = null) {
      uploadActivity.hidden = false;
      uploadProgressLabel.textContent = label;
      uploadProgressDetail.textContent = detail;
      if (typeof percent === 'number' && Number.isFinite(percent)) {
        uploadActivity.dataset.mode = 'determinate';
        uploadProgressBar.style.width = Math.max(2, Math.min(100, percent)) + '%';
      } else {
        uploadActivity.dataset.mode = 'indeterminate';
        uploadProgressBar.style.width = '35%';
      }
    }

    function clearProgress() {
      uploadActivity.hidden = true;
      uploadActivity.dataset.mode = 'indeterminate';
      uploadProgressLabel.textContent = 'Preparing upload…';
      uploadProgressDetail.textContent = '';
      uploadProgressBar.style.width = '0%';
    }

    async function refreshTree() {
      const response = await fetch('/api/tree');
      const payload = await response.json();
      treeContainer.innerHTML = renderEntries(payload.entries || []);
    }

    function stopTaskPolling() {
      if (activeTaskPoll) {
        clearInterval(activeTaskPoll);
        activeTaskPoll = null;
      }
    }

    async function pollTask(taskId) {
      stopTaskPolling();
      const update = async () => {
        const response = await fetch('/api/tasks/' + encodeURIComponent(taskId));
        const payload = await response.json();
        const task = payload.task;
        if (!task) {
          setProgress('Task not found.');
          stopTaskPolling();
          return;
        }

        const progress = task.progress || {};
        const phase = progress.phase || task.status;
        const detailParts = [];
        if (progress.totalBytes) {
          detailParts.push(formatBytes(progress.completedBytes || 0) + ' / ' + formatBytes(progress.totalBytes));
        } else if (progress.completedBytes) {
          detailParts.push(formatBytes(progress.completedBytes));
        }
        detailParts.push('Uploads ' + (progress.uploadCompleted || 0) + '/' + (progress.uploadTotal || 0));
        detailParts.push('URLs ' + (progress.urlCompleted || 0) + '/' + (progress.urlTotal || 0));
        if (progress.currentItem) detailParts.push('Current: ' + progress.currentItem);
        let percent = null;
        if (typeof progress.totalBytes === 'number' && progress.totalBytes > 0) {
          percent = Math.round(((progress.completedBytes || 0) / progress.totalBytes) * 100);
        } else if (typeof progress.uploadTotal === 'number' && progress.uploadTotal > 0) {
          percent = Math.round(((progress.uploadCompleted || 0) / progress.uploadTotal) * 100);
        } else if (typeof progress.urlTotal === 'number' && progress.urlTotal > 0) {
          percent = Math.round(((progress.urlCompleted || 0) / progress.urlTotal) * 100);
        }
        if (task.status === 'completed') percent = 100;
        setProgress(phase, detailParts.join(' • '), percent);

        if (task.status === 'completed' || task.status === 'failed') {
          stopTaskPolling();
          const lines = [];
          if (task.saved?.length) {
            lines.push('Saved:');
            for (const entry of task.saved) {
              lines.push('- ' + entry.name + ' (' + entry.source + ', ' + entry.bytes + ' bytes)');
            }
          }
          if (task.errors?.length) {
            if (lines.length) lines.push('');
            lines.push('Errors:');
            for (const error of task.errors) lines.push('- ' + error);
          }
          if (!lines.length) lines.push(task.status === 'completed' ? 'Completed.' : 'Task failed.');
          statusBox.textContent = lines.join('\\n');
          clearProgress();
          await refreshTree();
        }
      };

      await update();
      activeTaskPoll = setInterval(() => {
        update().catch((error) => {
          setProgress('Progress update failed', error?.message || String(error));
          stopTaskPolling();
        });
      }, 500);
    }

    async function deleteEntry(path, buttonEl) {
      buttonEl.disabled = true;
      statusBox.textContent = 'Deleting ' + path + '…';
      try {
        const response = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        const payload = await response.json();
        statusBox.textContent = response.ok ? ('Deleted: ' + payload.deletedPath) : (payload.error || 'Delete failed');
        if (response.ok) {
          await refreshTree();
        }
      } catch (error) {
        statusBox.textContent = 'Delete failed: ' + (error?.message || error);
      } finally {
        buttonEl.disabled = false;
      }
    }

    treeContainer.addEventListener('click', async (event) => {
      const buttonEl = event.target.closest('.delete-btn');
      if (!buttonEl) return;
      await deleteEntry(buttonEl.dataset.path, buttonEl);
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      statusBox.textContent = 'Starting upload…';
      setProgress('Preparing upload…', 'Waiting for the browser to send files to the server…');
      stopTaskPolling();

      try {
        const formData = new FormData(form);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/ingest');
        xhr.responseType = 'json';

        xhr.upload.onprogress = (progressEvent) => {
          if (progressEvent.lengthComputable) {
            const percent = Math.round((progressEvent.loaded / progressEvent.total) * 100);
            setProgress('Uploading to server…', percent + '% • ' + formatBytes(progressEvent.loaded) + ' / ' + formatBytes(progressEvent.total), percent);
          } else {
            setProgress('Uploading to server…', formatBytes(progressEvent.loaded));
          }
        };

        xhr.onload = async () => {
          button.disabled = false;
          const payload = xhr.response || JSON.parse(xhr.responseText || '{}');
          if (xhr.status < 200 || xhr.status >= 300) {
            statusBox.textContent = payload.error || payload.errors?.join('\\n') || 'Request failed';
            clearProgress();
            return;
          }
          statusBox.textContent = 'Upload received by server. Processing…';
          if (payload.taskId) {
            setProgress('Upload received by server', 'Processing files in downloads…');
            await pollTask(payload.taskId);
          } else {
            clearProgress();
          }
          form.reset();
        };

        xhr.onerror = () => {
          button.disabled = false;
          statusBox.textContent = 'Request failed.';
          clearProgress();
        };

        xhr.send(formData);
      } catch (error) {
        button.disabled = false;
        statusBox.textContent = 'Request failed: ' + (error?.message || error);
        clearProgress();
      }
    });

    clearProgress();
  </script>
</body>
</html>`;
}

async function processIngestTask(
  task: IngestTask,
  files: File[],
  urls: string[],
  config: AppConfig,
): Promise<void> {
  try {
    if (files.length) {
      updateTask(task, (draft) => {
        draft.progress.phase = "Saving uploaded files";
        draft.progress.currentItem = null;
      });
      const uploadResult = await saveUploadedFiles(config.downloadsDir, files, ({ completed, total, currentItem }) => {
        updateTask(task, (draft) => {
          draft.progress.phase = "Saving uploaded files";
          draft.progress.currentItem = currentItem;
          draft.progress.uploadCompleted = completed;
          draft.progress.uploadTotal = total;
        });
      });
      updateTask(task, (draft) => {
        draft.saved.push(...uploadResult.saved);
        draft.errors.push(...uploadResult.errors);
      });
    }

    if (urls.length) {
      updateTask(task, (draft) => {
        draft.progress.phase = "Starting URL downloads";
        draft.progress.currentItem = null;
      });
      const urlResult = await saveUrlDownloads(config.downloadsDir, urls, config.fetchImpl, config.lookupImpl, ({ completed, total, currentItem, completedBytes, totalBytes, phase }) => {
        updateTask(task, (draft) => {
          draft.progress.phase = phase;
          draft.progress.currentItem = currentItem;
          draft.progress.completedBytes = completedBytes;
          draft.progress.totalBytes = totalBytes;
          draft.progress.urlCompleted = completed;
          draft.progress.urlTotal = total;
        });
      });
      updateTask(task, (draft) => {
        draft.saved.push(...urlResult.saved);
        draft.errors.push(...urlResult.errors);
      });
    }

    updateTask(task, (draft) => {
      draft.status = draft.errors.length && !draft.saved.length ? "failed" : "completed";
      draft.progress.phase = draft.status === "completed" ? "Completed" : "Failed";
      draft.progress.currentItem = null;
      draft.progress.completedBytes = 0;
      draft.progress.totalBytes = null;
      draft.progress.uploadCompleted = files.length;
      draft.progress.uploadTotal = files.length;
      draft.progress.urlCompleted = urls.length;
      draft.progress.urlTotal = urls.length;
    });
  } catch (error: any) {
    updateTask(task, (draft) => {
      draft.status = "failed";
      draft.errors.push(error?.message || "Task failed unexpectedly.");
      draft.progress.phase = "Failed";
      draft.progress.currentItem = null;
      draft.progress.completedBytes = 0;
      draft.progress.totalBytes = null;
    });
  }
}

async function handleIngestRequest(request: Request, config: AppConfig, state: AppState): Promise<Response> {
  ensureDownloadsDir(config.downloadsDir);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "Expected multipart/form-data request body." }, 400);
  }

  const files = formData
    .getAll("files")
    .filter((value): value is File => value instanceof File && value.size > 0);
  const urls = parseUrlList(String(formData.get("urls") ?? ""));

  if (!files.length && !urls.length) {
    return json({ error: "Provide at least one file upload or download URL." }, 400);
  }

  const task: IngestTask = {
    id: crypto.randomUUID(),
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    saved: [],
    errors: [],
    progress: {
      phase: "Queued",
      currentItem: null,
      completedBytes: 0,
      totalBytes: null,
      uploadCompleted: 0,
      uploadTotal: files.length,
      urlCompleted: 0,
      urlTotal: urls.length,
    },
  };

  state.tasks.set(task.id, task);
  void processIngestTask(task, files, urls, config);

  return json({ taskId: task.id }, 202);
}

function handleTaskRequest(taskId: string, state: AppState): Response {
  const task = state.tasks.get(taskId);
  if (!task) {
    return json({ error: "Task not found." }, 404);
  }
  return json({ task: cloneTask(task) });
}

async function handleDeleteRequest(request: Request, config: AppConfig): Promise<Response> {
  let body: { path?: string };
  try {
    body = await request.json() as { path?: string };
  } catch {
    return json({ error: "Expected JSON request body." }, 400);
  }

  const relativePath = typeof body.path === "string" ? body.path : "";
  const fullPath = resolveDownloadsPath(config.downloadsDir, relativePath);
  if (!fullPath) {
    return json({ error: "Invalid downloads path." }, 400);
  }
  if (!existsSync(fullPath)) {
    return json({ error: "Not found." }, 404);
  }

  rmSync(fullPath, { force: true, recursive: true });
  return json({ ok: true, deletedPath: sanitizeRelativePath(relativePath) });
}

function serveDownload(requestUrl: URL, config: AppConfig): Response {
  ensureDownloadsDir(config.downloadsDir);

  let requestedName: string;
  try {
    requestedName = decodeURIComponent(requestUrl.pathname.slice("/downloads/".length));
  } catch {
    return json({ error: "Invalid file name." }, 400);
  }

  const fullPath = resolveDownloadsPath(config.downloadsDir, requestedName);
  if (!fullPath) {
    return json({ error: "Invalid file name." }, 400);
  }
  if (!existsSync(fullPath)) {
    return json({ error: "Not found." }, 404);
  }

  const stat = statSync(fullPath);
  if (!stat.isFile()) {
    return json({ error: "Not a file." }, 400);
  }

  const downloadName = basename(fullPath);
  return new Response(Bun.file(fullPath), {
    headers: {
      "content-disposition": `attachment; filename="${downloadName.replace(/"/g, "")}"`,
    },
  });
}

async function handleRequest(request: Request, config: AppConfig, state: AppState): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    return html(renderPage(config.downloadsDir));
  }

  if (request.method === "GET" && url.pathname === "/api/files") {
    return json({ files: listFiles(config.downloadsDir) });
  }

  if (request.method === "GET" && url.pathname === "/api/tree") {
    return json({ entries: listTree(config.downloadsDir) });
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/tasks/")) {
    return handleTaskRequest(url.pathname.slice("/api/tasks/".length), state);
  }

  if (request.method === "POST" && url.pathname === "/api/ingest") {
    return handleIngestRequest(request, config, state);
  }

  if (request.method === "POST" && url.pathname === "/api/delete") {
    return handleDeleteRequest(request, config);
  }

  if (request.method === "GET" && url.pathname.startsWith("/downloads/")) {
    return serveDownload(url, config);
  }

  return json({ error: "Not found." }, 404);
}

export function createApp(options: AppOptions = {}) {
  const config: AppConfig = {
    downloadsDir: options.downloadsDir || DEFAULT_DOWNLOADS_DIR,
    fetchImpl: options.fetchImpl || fetch,
    lookupImpl: options.lookupImpl || dnsLookup,
    port: options.port ?? DEFAULT_PORT,
    host: options.host ?? DEFAULT_HOST,
    maxRequestBodySize: options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
  };
  const state: AppState = {
    tasks: new Map(),
  };

  ensureDownloadsDir(config.downloadsDir);

  return {
    config,
    state,
    fetch(request: Request): Promise<Response> {
      return handleRequest(request, config, state);
    },
  };
}

export function startServer(options: AppOptions = {}) {
  const app = createApp(options);
  const server = Bun.serve({
    hostname: app.config.host,
    port: app.config.port,
    maxRequestBodySize: app.config.maxRequestBodySize,
    fetch: app.fetch,
  });

  console.log(`[file-drop] listening on http://${server.hostname}:${server.port}`);
  console.log(`[file-drop] downloads dir: ${app.config.downloadsDir}`);
  return server;
}

if (import.meta.main) {
  startServer();
}
