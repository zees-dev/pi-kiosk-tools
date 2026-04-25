import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { createApp, parseUrlList, startServer } from "./file-drop";

const tempDirs: string[] = [];
const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];

async function waitForTask(app: ReturnType<typeof createApp>, taskId: string, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await app.fetch(new Request(`http://localhost/api/tasks/${taskId}`));
    const payload = await response.json();
    if (payload.task?.status === "completed" || payload.task?.status === "failed") {
      return payload.task;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "file-drop-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (servers.length) {
    const server = servers.pop();
    server?.stop(true);
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { force: true, recursive: true });
  }
});

describe("parseUrlList", () => {
  it("accepts one URL per line and trims whitespace", () => {
    expect(parseUrlList(" https://example.com/a.iso\n\nhttps://example.com/b.rvz ")).toEqual([
      "https://example.com/a.iso",
      "https://example.com/b.rvz",
    ]);
  });
});

describe("file-drop app", () => {
  it("serves the upload form with inline activity indicator", async () => {
    const downloadsDir = makeTempDir();
    const app = createApp({ downloadsDir });

    const response = await app.fetch(new Request("http://localhost/"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Upload files");
    expect(body).toContain('name="files"');
    expect(body).toContain('name="urls"');
    expect(body).toContain("Downloads browser");
    expect(body).toContain("Downloads folder is empty.");
    expect(body).not.toContain("<h2>Upload progress</h2>");
    expect(body).toContain('id="uploadActivity"');
    expect(body).toContain('id="uploadProgressBar"');
    expect(body).toContain('id="uploadProgressLabel"');
    expect(body).toContain('id="uploadProgressDetail"');
    expect(body).toContain("uploadActivity.hidden = false");
    expect(body).toContain("uploadProgressBar.style.width");
    expect(body).toContain("upload.onprogress");
  });

  it("serves inline UI script that parses successfully", async () => {
    const downloadsDir = makeTempDir();
    const app = createApp({ downloadsDir });

    const response = await app.fetch(new Request("http://localhost/"));
    const body = await response.text();
    const script = body.match(/<script>([\s\S]*)<\/script>/)?.[1];

    expect(script).toBeString();
    expect(() => new Function(script!)).not.toThrow();
    expect(script).toContain("function setProgress(label, detail = '', percent = null)");
    expect(script).toContain("function clearProgress()");
    expect(script).toContain("detailParts.join(' • ')");
    expect(script).toContain("statusBox.textContent = lines.join('\\n')");
    expect(script).toContain("payload.errors?.join('\\n')");
  });

  it("lists files and directories in the downloads tree", async () => {
    const downloadsDir = makeTempDir();
    mkdirSync(join(downloadsDir, "mods", "tracks"), { recursive: true });
    writeFileSync(join(downloadsDir, "mods", "tracks", "course.txt"), "track-data");
    writeFileSync(join(downloadsDir, "root.txt"), "root-file");
    const app = createApp({ downloadsDir });

    const response = await app.fetch(new Request("http://localhost/api/tree"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0].type).toBe("directory");
    expect(payload.entries[0].path).toBe("mods");
    expect(payload.entries[0].children[0].path).toBe("mods/tracks");
    expect(payload.entries[0].children[0].children[0].path).toBe("mods/tracks/course.txt");
    expect(payload.entries[1].type).toBe("file");
    expect(payload.entries[1].path).toBe("root.txt");
  });

  it("ignores symlinks in the downloads tree and refuses serving them", async () => {
    const downloadsDir = makeTempDir();
    const outsideDir = makeTempDir();
    writeFileSync(join(outsideDir, "secret.txt"), "top-secret");
    symlinkSync(join(outsideDir, "secret.txt"), join(downloadsDir, "escape.txt"));
    const app = createApp({ downloadsDir });

    const treeResponse = await app.fetch(new Request("http://localhost/api/tree"));
    const treePayload = await treeResponse.json();
    const downloadResponse = await app.fetch(new Request("http://localhost/downloads/escape.txt"));
    const downloadPayload = await downloadResponse.json();

    expect(treeResponse.status).toBe(200);
    expect(treePayload.entries).toHaveLength(0);
    expect(downloadResponse.status).toBe(400);
    expect(downloadPayload.error).toContain("Invalid");
  });

  it("deletes files and directories from the downloads tree", async () => {
    const downloadsDir = makeTempDir();
    mkdirSync(join(downloadsDir, "mods"), { recursive: true });
    writeFileSync(join(downloadsDir, "mods", "course.txt"), "track-data");
    writeFileSync(join(downloadsDir, "notes.txt"), "hello");
    const app = createApp({ downloadsDir });

    const deleteFile = await app.fetch(new Request("http://localhost/api/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes.txt" }),
    }));
    const deleteDir = await app.fetch(new Request("http://localhost/api/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "mods" }),
    }));

    expect(deleteFile.status).toBe(200);
    expect(deleteDir.status).toBe(200);
    expect(existsSync(join(downloadsDir, "notes.txt"))).toBe(false);
    expect(existsSync(join(downloadsDir, "mods"))).toBe(false);
  });

  it("rejects delete requests outside the downloads directory", async () => {
    const downloadsDir = makeTempDir();
    const app = createApp({ downloadsDir });

    const response = await app.fetch(new Request("http://localhost/api/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "../escape" }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toContain("Invalid");
  });

  it("returns 400 for malformed download paths", async () => {
    const downloadsDir = makeTempDir();
    const app = createApp({ downloadsDir });

    const response = await app.fetch(new Request("http://localhost/downloads/%E0"));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toContain("Invalid");
  });

  it("stores uploaded files in the configured downloads directory", async () => {
    const downloadsDir = makeTempDir();
    const app = createApp({ downloadsDir });
    const form = new FormData();
    form.append("files", new File(["hello retrobox"], "notes.txt", { type: "text/plain" }));

    const response = await app.fetch(new Request("http://localhost/api/ingest", {
      method: "POST",
      body: form,
    }));
    const payload = await response.json();
    const task = await waitForTask(app, payload.taskId);

    expect(response.status).toBe(202);
    expect(payload.taskId).toBeString();
    expect(task.status).toBe("completed");
    expect(task.saved).toHaveLength(1);
    expect(task.saved[0].source).toBe("upload");
    expect(task.saved[0].name).toBe("notes.txt");
    expect(readFileSync(join(downloadsDir, "notes.txt"), "utf8")).toBe("hello retrobox");
  });

  it("blocks localhost and private-network download URLs", async () => {
    const downloadsDir = makeTempDir();
    const app = createApp({
      downloadsDir,
      lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
      fetchImpl: async () => new Response("should not be fetched", { status: 200 }),
    });

    const form = new FormData();
    form.append("urls", "http://internal.test/secret.txt");

    const response = await app.fetch(new Request("http://localhost/api/ingest", {
      method: "POST",
      body: form,
    }));
    const payload = await response.json();
    const task = await waitForTask(app, payload.taskId);

    expect(response.status).toBe(202);
    expect(task.saved).toHaveLength(0);
    expect(task.errors[0]).toContain("Blocked private or local URL");
    expect(task.status).toBe("failed");
  });

  it("blocks redirects to localhost and private-network targets", async () => {
    const downloadsDir = makeTempDir();
    const app = createApp({
      downloadsDir,
      lookupImpl: async (hostname) => {
        if (hostname === "example.com") return [{ address: "93.184.216.34", family: 4 }];
        return [{ address: "127.0.0.1", family: 4 }];
      },
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === "https://example.com/redirect") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/secret.txt" },
          });
        }
        return new Response("should-not-be-fetched", { status: 200 });
      },
    });

    const form = new FormData();
    form.append("urls", "https://example.com/redirect");

    const response = await app.fetch(new Request("http://localhost/api/ingest", {
      method: "POST",
      body: form,
    }));
    const payload = await response.json();
    const task = await waitForTask(app, payload.taskId);

    expect(response.status).toBe(202);
    expect(task.saved).toHaveLength(0);
    expect(task.errors[0]).toContain("Blocked private or local URL");
    expect(task.status).toBe("failed");
  });

  it("reports download progress for URL tasks", async () => {
    const downloadsDir = makeTempDir();
    const app = createApp({
      downloadsDir,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => {
        let sent = 0;
        const chunks = ["hello", "-", "world"];
        return new Response(new ReadableStream({
          async pull(controller) {
            if (sent >= chunks.length) {
              controller.close();
              return;
            }
            await Bun.sleep(15);
            controller.enqueue(new TextEncoder().encode(chunks[sent]));
            sent += 1;
          },
        }), {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-length": "11",
            "content-disposition": 'attachment; filename="progress.txt"',
          },
        });
      },
    });

    const form = new FormData();
    form.append("urls", "https://example.com/progress.txt");

    const startResponse = await app.fetch(new Request("http://localhost/api/ingest", {
      method: "POST",
      body: form,
    }));
    const startPayload = await startResponse.json();
    await Bun.sleep(20);
    const progressResponse = await app.fetch(new Request(`http://localhost/api/tasks/${startPayload.taskId}`));
    const progressPayload = await progressResponse.json();
    const completedTask = await waitForTask(app, startPayload.taskId);

    expect(startResponse.status).toBe(202);
    expect(progressPayload.task.status).toBe("running");
    expect(progressPayload.task.progress.phase).toContain("Downloading");
    expect(progressPayload.task.progress.completedBytes).toBeGreaterThan(0);
    expect(progressPayload.task.progress.totalBytes).toBe(11);
    expect(completedTask.status).toBe("completed");
    expect(readFileSync(join(downloadsDir, "progress.txt"), "utf8")).toBe("hello-world");
  });

  it("downloads files from provided URLs into the configured downloads directory", async () => {
    const downloadsDir = makeTempDir();
    const app = createApp({
      downloadsDir,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === "https://example.com/mods/custom-track-pack.zip") {
          return new Response("zip-content", {
            status: 200,
            headers: {
              "content-type": "application/zip",
              "content-disposition": 'attachment; filename="custom-track-pack.zip"',
            },
          });
        }
        return new Response("missing", { status: 404 });
      },
    });

    const form = new FormData();
    form.append("urls", "https://example.com/mods/custom-track-pack.zip");

    const response = await app.fetch(new Request("http://localhost/api/ingest", {
      method: "POST",
      body: form,
    }));
    const payload = await response.json();
    const task = await waitForTask(app, payload.taskId);

    expect(response.status).toBe(202);
    expect(task.saved).toHaveLength(1);
    expect(task.saved[0].source).toBe("url");
    expect(task.saved[0].name).toBe("custom-track-pack.zip");
    expect(readFileSync(join(downloadsDir, "custom-track-pack.zip"), "utf8")).toBe("zip-content");
  });

  it("enforces configurable request body limits when serving uploads", async () => {
    const downloadsDir = makeTempDir();
    const uploadPath = join(downloadsDir, "body-limit-test.bin");
    writeFileSync(uploadPath, Buffer.alloc(2048, 7));

    const portProbe = Bun.serve({
      port: 0,
      fetch() {
        return new Response("probe");
      },
    });
    const port = portProbe.port;
    portProbe.stop(true);

    const server = startServer({
      downloadsDir,
      host: "127.0.0.1",
      port,
      maxRequestBodySize: 1024,
    });
    servers.push(server);

    const form = new FormData();
    form.append("files", Bun.file(uploadPath), "body-limit-test.rar");

    const response = await fetch(`http://127.0.0.1:${server.port}/api/ingest`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(413);
  });
});
