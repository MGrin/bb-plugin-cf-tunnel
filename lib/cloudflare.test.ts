import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloudflareClient } from "./cloudflare.ts";

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return (async (url: string | URL, init?: RequestInit) =>
    new Response(JSON.stringify(handler(String(url), init)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const base = { token: "tok", accountId: "acct", zoneId: "zone" };

test("verifyToken uses the ACCOUNT path, not /user/tokens/verify", async () => {
  let seen = "";
  const c = createCloudflareClient({
    ...base,
    fetchImpl: stubFetch((u) => {
      seen = u;
      return { success: true, result: {} };
    }),
  });
  assert.equal(await c.verifyToken(), true);
  assert.ok(seen.includes("/accounts/acct/tokens/verify"), seen);
  assert.ok(!seen.includes("/user/tokens/verify"), seen);
});

test("verifyToken reports false rather than throwing on rejection", async () => {
  const c = createCloudflareClient({
    ...base,
    fetchImpl: stubFetch(() => ({ success: false, errors: [{ message: "Invalid API Token" }] })),
  });
  assert.equal(await c.verifyToken(), false);
});

test("createTunnel sends config_src cloudflare and returns the id", async () => {
  let body: unknown;
  const c = createCloudflareClient({
    ...base,
    fetchImpl: stubFetch((_u, init) => {
      body = JSON.parse(String(init?.body));
      return { success: true, result: { id: "tid" } };
    }),
  });
  assert.deepEqual(await c.createTunnel("bb-tunnel"), { id: "tid" });
  assert.deepEqual(body, { name: "bb-tunnel", config_src: "cloudflare" });
});

test("getTunnelToken reads result as a bare string", async () => {
  const c = createCloudflareClient({
    ...base,
    fetchImpl: stubFetch(() => ({ success: true, result: "connector-token" })),
  });
  assert.equal(await c.getTunnelToken("tid"), "connector-token");
});

test("createDnsRecord asks for a proxied CNAME", async () => {
  let body: Record<string, unknown> = {};
  const c = createCloudflareClient({
    ...base,
    fetchImpl: stubFetch((_u, init) => {
      body = JSON.parse(String(init?.body));
      return { success: true, result: {} };
    }),
  });
  await c.createDnsRecord("bb.example.com", "tid.cfargotunnel.com");
  assert.equal(body.type, "CNAME");
  assert.equal(body.proxied, true);
  assert.equal(body.content, "tid.cfargotunnel.com");
});

test("createAccessPolicy omits login_method", async () => {
  let body: Record<string, unknown> = {};
  const c = createCloudflareClient({
    ...base,
    fetchImpl: stubFetch((_u, init) => {
      body = JSON.parse(String(init?.body));
      return { success: true, result: {} };
    }),
  });
  await c.createAccessPolicy("app", ["you@example.com"]);
  assert.ok(!("login_method" in body), JSON.stringify(body));
  assert.deepEqual(body.include, [{ email: { email: "you@example.com" } }]);
});

test("an API error is thrown with the Cloudflare message", async () => {
  const c = createCloudflareClient({
    ...base,
    fetchImpl: stubFetch(() => ({ success: false, errors: [{ message: "Authentication error" }] })),
  });
  await assert.rejects(() => c.createTunnel("x"), /Authentication error/u);
});

test("findTunnel ignores a deleted tunnel of the same name", async () => {
  const c = createCloudflareClient({
    ...base,
    fetchImpl: stubFetch(() => ({
      success: true,
      result: [{ id: "old", name: "bb-tunnel", deleted_at: "2026-01-01T00:00:00Z" }],
    })),
  });
  assert.equal(await c.findTunnel("bb-tunnel"), null);
});

test("findAccessApp matches on domain and returns the aud", async () => {
  const c = createCloudflareClient({
    ...base,
    fetchImpl: stubFetch(() => ({
      success: true,
      result: [
        { id: "other", domain: "elsewhere.example.com", aud: "a1" },
        { id: "aid", domain: "bb.example.com", aud: "a2" },
      ],
    })),
  });
  assert.deepEqual(await c.findAccessApp("bb.example.com"), { id: "aid", aud: "a2" });
});
