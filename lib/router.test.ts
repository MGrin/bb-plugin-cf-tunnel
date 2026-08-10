import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { startRouter, KEEPALIVE_MS } from "../router.ts";

async function origin(): Promise<{ url: string; port: number; close: () => void }> {
  const s = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(`origin:${req.headers.host}`);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, port, close: () => s.close() };
}

// NOT fetch(): `Host` is a forbidden header name, so undici silently drops it
// and every request would arrive as 127.0.0.1:<port>. That made the 404 tests
// pass for the wrong reason. node:http lets us set Host for real, and avoids
// undici's keep-alive pool holding the server open at shutdown.
function req(
  port: number,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", headers: { host, ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

const allow = async () => ({ ok: true as const, email: "you@example.com" });

async function router(over: Record<string, unknown> = {}) {
  const o = await origin();
  const r = await startRouter({
    desiredPort: 0,
    hostname: "bb.example.com",
    bbOrigin: o.url,
    getShares: () => [],
    now: () => 0,
    checkAccess: allow,
    ...over,
  } as never);
  return { r, o, stop: async () => { await r.close(); o.close(); } };
}

test("a request with no Access JWT is rejected with 403", async () => {
  const { r, stop } = await router({
    checkAccess: async (t: string | undefined) =>
      t ? { ok: true, email: "e" } : { ok: false, reason: "missing" },
  });
  const res = await req(r.port, "bb.example.com");
  try {
    assert.equal(res.status, 403);
  } finally {
    await stop();
  }
});

test("an authenticated request for the bb host reaches the origin", async () => {
  const { r, stop } = await router();
  const res = await req(r.port, "bb.example.com", { "cf-access-jwt-assertion": "t" });
  try {
    assert.equal(res.status, 200);
  } finally {
    await stop();
  }
});

test("the Host header is forwarded unmodified so bb's origin guard passes", async () => {
  const { r, stop } = await router();
  const res = await req(r.port, "bb.example.com", { "cf-access-jwt-assertion": "t" });
  try {
    assert.equal(res.body, "origin:bb.example.com");
  } finally {
    await stop();
  }
});

test("an unknown host is 404 even when authenticated", async () => {
  const { r, stop } = await router();
  const res = await req(r.port, "evil.example.com", { "cf-access-jwt-assertion": "t" });
  try {
    assert.equal(res.status, 404);
  } finally {
    await stop();
  }
});

test("a non-allow-listed port host is 404, never a connection to it", async () => {
  const { r, stop } = await router();
  const res = await req(r.port, "bb-p22.example.com", { "cf-access-jwt-assertion": "t" });
  try {
    assert.equal(res.status, 404);
  } finally {
    await stop();
  }
});

test("an allow-listed port reaches that local port", async () => {
  const target = await origin();
  const { r, stop } = await router({
    getShares: () => [{ port: target.port, expiresAt: Number.MAX_SAFE_INTEGER }],
  });
  const res = await req(r.port, `bb-p${target.port}.example.com`, { "cf-access-jwt-assertion": "t" });
  try {
    assert.equal(res.status, 200);
  } finally {
    await stop();
  }
  target.close();
});

test("an expired share stops routing without any sweeper running", async () => {
  const target = await origin();
  const { r, stop } = await router({
    getShares: () => [{ port: target.port, expiresAt: 100 }],
    now: () => 101,
  });
  const res = await req(r.port, `bb-p${target.port}.example.com`, { "cf-access-jwt-assertion": "t" });
  try {
    assert.equal(res.status, 404);
  } finally {
    await stop();
  }
  target.close();
});

test("a shared port that is not listening yields 502, not a hang", async () => {
  const dead = await origin();
  const port = dead.port;
  dead.close();
  const { r, stop } = await router({
    getShares: () => [{ port, expiresAt: Number.MAX_SAFE_INTEGER }],
  });
  const res = await req(r.port, `bb-p${port}.example.com`, { "cf-access-jwt-assertion": "t" });
  try {
    assert.equal(res.status, 502);
  } finally {
    await stop();
  }
});

test("the keepalive interval is 30s, under Cloudflare's measured 125.9s cutoff", () => {
  assert.equal(KEEPALIVE_MS, 30_000);
  assert.ok(KEEPALIVE_MS < 125_900, "keepalive must fire well before the edge closes the socket");
});

test("an unauthenticated WebSocket upgrade is refused", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const upPort = (wss.address() as { port: number }).port;

  const { r, stop } = await router({
    bbOrigin: `http://127.0.0.1:${upPort}`,
    checkAccess: async () => ({ ok: false, reason: "missing" }),
  });

  const { WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}/ws`, { headers: { host: "bb.example.com" } });
  const outcome = await new Promise<string>((resolve) => {
    ws.on("open", () => resolve("opened"));
    ws.on("error", () => resolve("refused"));
    ws.on("close", () => resolve("refused"));
  });
  assert.equal(outcome, "refused");
  await stop();
  wss.close();
});
