/**
 * 远端推理服务的端点与响应校验测试。
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInferenceServerClient } from "../../src/ner/inference-server-client.js";
import { createInferenceServerNERModel } from "../../src/ner/inference-server-ner-model.js";

let server: Server | undefined;

async function stubServer(
  handler: (body: unknown) => unknown,
): Promise<string> {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", model_loaded: true, provider: "stub" }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as unknown;
      const payload = handler(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server!.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("inference server endpoint rules", () => {
  it("accepts loopback over http", () => {
    expect(() => createInferenceServerClient({ url: "http://127.0.0.1:8080" })).not.toThrow();
  });

  it("rejects a non-loopback http endpoint", () => {
    expect(() => createInferenceServerClient({ url: "http://example.com" })).toThrow(/https/);
  });

  it("does not leak the response body in the error", async () => {
    server = createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("secret-looking-body");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server!.address() as AddressInfo).port;
    const client = createInferenceServerClient({ url: `http://127.0.0.1:${port}` });

    await expect(client.predict("hello")).rejects.toThrow(/status 500/);
    await expect(client.predict("hello")).rejects.not.toThrow(/secret-looking-body/);
  });
});

describe("inference server response validation", () => {
  async function modelFor(payload: unknown) {
    const url = await stubServer(() => payload);
    const model = createInferenceServerNERModel({ serverUrl: url });
    await model.load();
    return model;
  }

  it("keeps a well-formed entity", async () => {
    const model = await modelFor({
      entities: [{ type: "PERSON", start: 0, end: 5, confidence: 0.9, text: "Alice" }],
      processing_time_ms: 1,
    });
    const result = await model.predict("Alice works here");
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.recognizer).toMatch(/^ner:/);
  });

  it("drops an entity whose span exceeds the text", async () => {
    const model = await modelFor({
      entities: [{ type: "PERSON", start: 0, end: 99, confidence: 0.9, text: "Alice" }],
      processing_time_ms: 1,
    });
    expect((await model.predict("Alice")).spans).toHaveLength(0);
  });

  it("drops an entity whose text does not match the span", async () => {
    const model = await modelFor({
      entities: [{ type: "PERSON", start: 0, end: 5, confidence: 0.9, text: "Bob" }],
      processing_time_ms: 1,
    });
    expect((await model.predict("Alice")).spans).toHaveLength(0);
  });

  it("drops an entity with an out-of-range confidence", async () => {
    const model = await modelFor({
      entities: [{ type: "PERSON", start: 0, end: 5, confidence: 1.5, text: "Alice" }],
      processing_time_ms: 1,
    });
    expect((await model.predict("Alice")).spans).toHaveLength(0);
  });

  it("drops an unmapped entity type", async () => {
    const model = await modelFor({
      entities: [{ type: "SOMETHING_NEW", start: 0, end: 5, confidence: 0.9, text: "Alice" }],
      processing_time_ms: 1,
    });
    expect((await model.predict("Alice")).spans).toHaveLength(0);
  });
});
