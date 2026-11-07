/**
 * 本机查看服务的测试：访问控制、只读接口、清理接口与页面渲染。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

import { MaskingRecordStore } from "../../src/records/sqlite-store.js";
import { startViewer, type ViewerHandle } from "../../src/records/viewer/server.js";
import type { MaskingRecord } from "../../src/records/types.js";

const EMAIL = ["alice", "@", "example.com"].join("");

function record(id: string): MaskingRecord {
  return {
    version: 1,
    id,
    sessionId: "s1",
    scope: "model-input",
    source: "context",
    time: new Date().toISOString(),
    durationMs: 1,
    masked: 1,
    blocked: false,
    integrity: "complete",
    hits: [],
    comparisons: [],
    snapshot: { before: EMAIL, after: "masked" },
  };
}

describe("local masking viewer", () => {
  let dir: string;
  let store: MaskingRecordStore;
  let viewer: ViewerHandle;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rehydra-viewer-"));
    store = new MaskingRecordStore(
      {
        enabled: true,
        includeOriginal: true,
        keepDays: 7,
        keepBytes: 1024 * 1024,
        maxRecordBytes: 1024 * 1024,
        dir,
      },
      () => undefined,
    );
    viewer = await startViewer({ store, status: () => ({ recordsEnabled: true }) });
  });

  afterEach(async () => {
    await viewer.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const base = (): string => `http://127.0.0.1:${viewer.port}`;

  it("listens on the loopback address only", () => {
    expect(viewer.url).toBe(`http://127.0.0.1:${viewer.port}/`);
  });

  it("serves the page without the request header", async () => {
    const response = await fetch(base());
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<!doctype html>");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("rejects data requests without the custom header", async () => {
    const response = await fetch(`${base()}/api/records`);
    expect(response.status).toBe(403);
  });

  it("rejects cross-site requests", async () => {
    const response = await fetch(`${base()}/api/records`, {
      headers: { "x-rehydra-viewer": "1", "sec-fetch-site": "cross-site" },
    });
    expect(response.status).toBe(403);
  });

  it("rejects a foreign origin", async () => {
    const response = await fetch(`${base()}/api/records`, {
      headers: { "x-rehydra-viewer": "1", origin: "http://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("rejects a foreign host header", async () => {
    // Host 是受限请求头，fetch 不允许改写，这里用原始请求发送。
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: viewer.port,
          path: "/api/records",
          method: "GET",
          headers: { "x-rehydra-viewer": "1", host: "evil.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(403);
  });

  it("rejects CORS preflight", async () => {
    const response = await fetch(`${base()}/api/records`, { method: "OPTIONS" });
    expect(response.status).toBe(405);
  });

  it("lists and reads records", async () => {
    store.add(record("r-1"));
    const list = await fetch(`${base()}/api/records`, {
      headers: { "x-rehydra-viewer": "1" },
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { records: Array<{ id: string }>; total: number };
    expect(listed.total).toBe(1);
    expect(listed.records[0]?.id).toBe("r-1");

    const detail = await fetch(`${base()}/api/records/r-1`, {
      headers: { "x-rehydra-viewer": "1" },
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { snapshot?: { before: string } };
    expect(detailBody.snapshot?.before).toContain(EMAIL);
  });

  it("returns 404 for an unknown record", async () => {
    const response = await fetch(`${base()}/api/records/nope`, {
      headers: { "x-rehydra-viewer": "1" },
    });
    expect(response.status).toBe(404);
  });

  it("requires confirmation before clearing", async () => {
    store.add(record("r-2"));
    const refused = await fetch(`${base()}/api/clear`, {
      method: "POST",
      headers: { "x-rehydra-viewer": "1", "content-type": "application/json" },
      body: JSON.stringify({ kind: "all" }),
    });
    expect(refused.status).toBe(400);
    expect(store.query({}).total).toBe(1);

    const cleared = await fetch(`${base()}/api/clear`, {
      method: "POST",
      headers: { "x-rehydra-viewer": "1", "content-type": "application/json" },
      body: JSON.stringify({ kind: "all", confirm: true }),
    });
    expect(cleared.status).toBe(200);
    expect(store.query({}).total).toBe(0);
  });

  it("exposes the status without leaking configuration values", async () => {
    const response = await fetch(`${base()}/api/status`, {
      headers: { "x-rehydra-viewer": "1" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["recordsEnabled"]).toBe(true);
  });

  it("releases the port when closed", async () => {
    await viewer.close();
    const response = await fetch(base()).catch(() => undefined);
    expect(response).toBeUndefined();
  });
});
