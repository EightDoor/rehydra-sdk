/**
 * 本机脱敏查看服务。
 *
 * 只监听 `127.0.0.1`，不使用登录态：无凭证的本机页面意味着任何能访问这台机器的
 * 进程都能读到记录原文，因此访问控制靠浏览器同源约束（Host / Origin 校验与自定义
 * 请求头），并明确只提供只读查询与需要二次确认的清理接口。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import { VIEWER_HTML } from "./page.js";
import { detectorLabel } from "../types.js";
import type { MaskingRecordStore } from "../sqlite-store.js";

/** 查看服务配置。 */
export interface ViewerOptions {
  store: MaskingRecordStore;
  /** 状态信息，由扩展提供。 */
  status: () => Record<string, unknown>;
  /** 监听地址，默认 `127.0.0.1`。 */
  host?: string;
  /** 监听端口，默认 0（由系统分配）。 */
  port?: number;
  /** 页面读取记录时携带的自定义请求头，跨站请求无法伪造。 */
  requestHeader?: string;
}

/** 已启动的查看服务。 */
export interface ViewerHandle {
  /** 访问地址，例如 `http://127.0.0.1:53211/`。 */
  url: string;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_REQUEST_HEADER = "x-rehydra-viewer";

/** 允许的 Host 形式：`127.0.0.1:port` 或 `localhost:port`。 */
function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `127.0.0.1`,
    `localhost`,
  ]);
  return allowed.has(host);
}

/** Origin 必须是本服务的来源。 */
function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` ||
    origin === "http://127.0.0.1" ||
    origin === "http://localhost"
  );
}

/** 读取请求体，带体积上限。 */
async function readBody(request: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** 启动查看服务；失败时抛出，由调用方告警。 */
export async function startViewer(options: ViewerOptions): Promise<ViewerHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestHeader = options.requestHeader ?? DEFAULT_REQUEST_HEADER;

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end("internal error");
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const port = (server.address() as AddressInfo | null)?.port ?? 0;
    // Host 校验：挡掉指向本机的 DNS 重绑定。
    if (!hostAllowed(request.headers.host, port)) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("forbidden");
      return;
    }
    // 跨站请求：拒绝预检，且要求同源自定义请求头。
    if (request.method === "OPTIONS") {
      response.writeHead(405, { "content-type": "text/plain" });
      response.end("method not allowed");
      return;
    }
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("forbidden");
      return;
    }
    if (!originAllowed(request.headers.origin, port)) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("forbidden");
      return;
    }

    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      "referrer-policy": "no-referrer",
    };

    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      response.end(VIEWER_HTML);
      return;
    }

    // 数据与清理接口要求自定义请求头：跨站表单与普通 <img> 无法带上它。
    if (request.headers[requestHeader] !== "1") {
      response.writeHead(403, { ...headers, "content-type": "text/plain" });
      response.end("forbidden");
      return;
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      sendJson(response, 200, headers, options.status());
      return;
    }

    if (url.pathname === "/api/sessions" && request.method === "GET") {
      sendJson(response, 200, headers, { sessions: options.store.sessions() });
      return;
    }

    if (url.pathname === "/api/records" && request.method === "GET") {
      const result = options.store.query({
        limit: Number(url.searchParams.get("limit") ?? "50"),
        offset: Number(url.searchParams.get("offset") ?? "0"),
        sessionId: url.searchParams.get("sessionId") ?? undefined,
        source: url.searchParams.get("source") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        type: url.searchParams.get("type") ?? undefined,
      });
      sendJson(response, 200, headers, result);
      return;
    }

    if (url.pathname.startsWith("/api/records/") && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/records/".length));
      const record = options.store.get(id);
      if (record === null) {
        sendJson(response, 404, headers, { error: "not found" });
        return;
      }
      // 检测器显示名在响应里补上，落盘记录仍只存稳定标识。
      sendJson(response, 200, headers, {
        ...record,
        hits: record.hits.map((hit) => ({ ...hit, label: detectorLabel(hit.detector) })),
      });
      return;
    }

    if (url.pathname === "/api/clear" && request.method === "POST") {
      let body: { kind?: string; sessionId?: string; confirm?: boolean };
      try {
        body = JSON.parse(await readBody(request)) as typeof body;
      } catch {
        sendJson(response, 400, headers, { error: "invalid body" });
        return;
      }
      // 页面已做二次确认；服务端再校验一次，避免直接发请求误删。
      if (body.confirm !== true) {
        sendJson(response, 400, headers, { error: "confirmation required" });
        return;
      }
      const kind = body.kind === "all" ? "all" : "session";
      const deleted = options.store.clear(kind, body.sessionId);
      sendJson(response, 200, headers, { deleted });
      return;
    }

    response.writeHead(404, { ...headers, "content-type": "text/plain" });
    response.end("not found");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}/`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** 发送 JSON 响应。 */
function sendJson(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  response.end(payload);
}
