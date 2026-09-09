import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fetchJson } from "../src/http.js";

let server: Server;
let port: number;
let hits = 0;
let handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void =
  () => {};

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("http.fetchJson", () => {
  it("returns parsed JSON on 200", async () => {
    hits = 0;
    handler = (_, res) => { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); };
    const j = await fetchJson<{ ok: boolean }>(`http://127.0.0.1:${port}`);
    expect(j.ok).toBe(true);
    expect(hits).toBe(1);
  });

  it("retries on 500 and eventually succeeds", async () => {
    hits = 0;
    handler = (_, res) => {
      if (hits < 3) { res.statusCode = 500; res.end("fail"); }
      else { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); }
    };
    const j = await fetchJson<{ ok: boolean }>(`http://127.0.0.1:${port}`, { retries: 4 });
    expect(j.ok).toBe(true);
    expect(hits).toBe(3);
  });

  it("does NOT retry on 400", async () => {
    hits = 0;
    handler = (_, res) => { res.statusCode = 400; res.end("bad"); };
    await expect(
      fetchJson(`http://127.0.0.1:${port}`, { retries: 3 }),
    ).rejects.toThrow(/400/);
    expect(hits).toBe(1);
  });

  it("gives up after retries on persistent 500", async () => {
    hits = 0;
    handler = (_, res) => { res.statusCode = 500; res.end("still failing"); };
    await expect(
      fetchJson(`http://127.0.0.1:${port}`, { retries: 2 }),
    ).rejects.toThrow(/500/);
    expect(hits).toBe(3);
  });
});
