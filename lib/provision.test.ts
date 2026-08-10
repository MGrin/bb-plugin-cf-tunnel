import { test } from "node:test";
import assert from "node:assert/strict";
import { provision, protectedDomains, acceptedAuds } from "./provision.ts";
import type { CloudflareClient } from "./cloudflare.ts";

function fakeClient(calls: string[], over: Partial<CloudflareClient> = {}): CloudflareClient {
  return {
    verifyToken: async () => true,
    findTunnel: async () => null,
    createTunnel: async () => {
      calls.push("createTunnel");
      return { id: "tid" };
    },
    getTunnelToken: async () => {
      calls.push("getTunnelToken");
      return "ctok";
    },
    putTunnelConfig: async () => {
      calls.push("putTunnelConfig");
    },
    findDnsRecord: async () => null,
    createDnsRecord: async (n: string) => {
      calls.push(`createDns:${n}`);
    },
    findAccessApp: async () => null,
    createAccessApp: async (a: { domain: string }) => {
      calls.push(`createAccessApp:${a.domain}`);
      return { id: `aid:${a.domain}`, aud: `aud:${a.domain}` };
    },
    createAccessPolicy: async () => {
      calls.push("createAccessPolicy");
    },
    ...over,
  };
}

const base = {
  hostname: "bb.example.com",
  routerPort: 8790,
  sessionDuration: "720h",
  emails: ["you@example.com"],
};

test("a fresh provision creates every resource in order", async () => {
  const calls: string[] = [];
  const saved: unknown[] = [];
  const out = await provision({
    ...base,
    client: fakeClient(calls),
    state: {},
    saveState: async (s) => {
      saved.push({ ...s });
    },
  });
  assert.equal(out.tunnelId, "tid");
  assert.equal(out.connectorToken, "ctok");
  assert.deepEqual(calls, [
    "createTunnel",
    "getTunnelToken",
    "putTunnelConfig",
    "createDns:bb.example.com",
    "createAccessApp:bb.example.com",
    "createAccessPolicy",
  ]);
  assert.ok(saved.length >= 3, "state must be saved incrementally, not once at the end");
});

test("a fully provisioned account creates nothing new", async () => {
  const calls: string[] = [];
  const client = fakeClient(calls, {
    findTunnel: async () => ({ id: "tid" }),
    findDnsRecord: async () => ({ id: "d" }),
    findAccessApp: async () => ({ id: "aid", aud: "aud1" }),
  });
  await provision({
    ...base,
    client,
    state: {
      tunnelId: "tid",
      connectorToken: "ctok",
      apps: { "bb.example.com": { id: "a1", aud: "aud1" } },
    },
    saveState: async () => {},
  });
  assert.deepEqual(
    calls.filter((c) => c.startsWith("create")),
    [],
  );
});

test("a half-provisioned account resumes without duplicating the tunnel", async () => {
  const calls: string[] = [];
  const client = fakeClient(calls, { findTunnel: async () => ({ id: "tid" }) });
  await provision({
    ...base,
    client,
    state: { tunnelId: "tid", connectorToken: "ctok" },
    saveState: async () => {},
  });
  assert.ok(!calls.includes("createTunnel"), calls.join(","));
  assert.ok(calls.includes("createAccessApp:bb.example.com"), calls.join(","));
});

test("an existing tunnel of the same name is adopted, not recreated", async () => {
  const calls: string[] = [];
  const client = fakeClient(calls, { findTunnel: async () => ({ id: "existing" }) });
  const out = await provision({ ...base, client, state: {}, saveState: async () => {} });
  assert.equal(out.tunnelId, "existing");
  assert.ok(!calls.includes("createTunnel"), calls.join(","));
});

test("an adopted Access app does not get a second policy", async () => {
  const calls: string[] = [];
  const client = fakeClient(calls, { findAccessApp: async () => ({ id: "aid", aud: "aud1" }) });
  await provision({ ...base, client, state: {}, saveState: async () => {} });
  assert.ok(!calls.includes("createAccessPolicy"), calls.join(","));
});

test("the ingress origin points at the router port", async () => {
  let origin = "";
  const calls: string[] = [];
  const client = fakeClient(calls, {
    putTunnelConfig: async (_id: string, o: string) => {
      origin = o;
    },
  });
  await provision({ ...base, client, state: {}, saveState: async () => {} });
  assert.equal(origin, "http://127.0.0.1:8790");
});

test("only the apex DNS record is created up front", async () => {
  const calls: string[] = [];
  await provision({ ...base, client: fakeClient(calls), state: {}, saveState: async () => {} });
  assert.ok(calls.includes("createDns:bb.example.com"), calls.join(","));
  // A wildcard here would have to be *.example.com, which would shadow every
  // other site in the zone.
  assert.ok(!calls.some((c) => c.startsWith("createDns:*")), calls.join(","));
});

test("the apex gets its own Access app", async () => {
  const calls: string[] = [];
  const out = await provision({ ...base, client: fakeClient(calls), state: {}, saveState: async () => {} });
  assert.deepEqual(Object.keys(out.apps), ["bb.example.com"]);
  assert.deepEqual(acceptedAuds(out), ["aud:bb.example.com"]);
});

test("protectedDomains never widens beyond the configured hostname", () => {
  assert.deepEqual(protectedDomains("bb.example.com"), ["bb.example.com"]);
  // These must never appear: either would put the whole zone behind Access.
  assert.ok(!protectedDomains("bb.example.com").includes("example.com"));
  assert.ok(!protectedDomains("bb.example.com").includes("*.example.com"));
});

test("acceptedAuds is derived from owned apps, so a pruned app cannot linger", () => {
  assert.deepEqual(acceptedAuds({}), []);
  assert.deepEqual(
    acceptedAuds({ apps: { "bb.example.com": { id: "a", aud: "x" }, "bb-p1.example.com": { id: "b", aud: "y" } } }),
    ["x", "y"],
  );
});
