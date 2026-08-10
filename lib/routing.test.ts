import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRoute, shareHost, splitHostname } from "./routing.ts";

const base = { hostname: "bb.example.com", sharedPorts: [3000] };

test("bb hostname routes to the bb server", () => {
  assert.deepEqual(resolveRoute({ ...base, host: "bb.example.com" }), { kind: "bb" });
});

test("hostname with port suffix still routes to bb", () => {
  assert.deepEqual(resolveRoute({ ...base, host: "bb.example.com:443" }), { kind: "bb" });
});

test("host matching is case insensitive", () => {
  assert.deepEqual(resolveRoute({ ...base, host: "BB.Example.COM" }), { kind: "bb" });
});

test("allow-listed share host routes to that port", () => {
  assert.deepEqual(resolveRoute({ ...base, host: "bb-p3000.example.com" }), {
    kind: "port",
    port: 3000,
  });
});

test("port not on the allow-list is rejected", () => {
  assert.deepEqual(resolveRoute({ ...base, host: "bb-p22.example.com" }), { kind: "reject" });
});

test("the OLD deep scheme is rejected — it has no TLS certificate anyway", () => {
  assert.deepEqual(resolveRoute({ ...base, host: "p3000.bb.example.com" }), { kind: "reject" });
});

test("a sibling site in the same zone is never routed", () => {
  for (const h of ["app.example.com", "hass.example.com", "example.com", "www.example.com"]) {
    assert.deepEqual(resolveRoute({ ...base, host: h }), { kind: "reject" }, h);
  }
});

test("unknown host is rejected", () => {
  assert.deepEqual(resolveRoute({ ...base, host: "evil.example.com" }), { kind: "reject" });
});

test("malformed port label is rejected", () => {
  assert.deepEqual(resolveRoute({ ...base, host: "bb-pabc.example.com" }), { kind: "reject" });
});

test("a prefix that merely starts with the label is rejected", () => {
  assert.deepEqual(resolveRoute({ ...base, host: "bbx-p3000.example.com" }), { kind: "reject" });
});

test("a deeper label under the share host is rejected", () => {
  assert.deepEqual(resolveRoute({ ...base, host: "x.bb-p3000.example.com" }), { kind: "reject" });
});

test("out-of-range port is rejected even if numeric", () => {
  assert.deepEqual(
    resolveRoute({ hostname: "bb.example.com", sharedPorts: [99999], host: "bb-p99999.example.com" }),
    { kind: "reject" },
  );
});

test("missing host is rejected", () => {
  assert.deepEqual(resolveRoute({ ...base, host: "" }), { kind: "reject" });
});

test("splitHostname separates the label from the zone", () => {
  assert.deepEqual(splitHostname("bb.example.com"), { label: "bb", zone: "example.com" });
  assert.equal(splitHostname("nodots"), null);
  assert.equal(splitHostname(".example.com"), null);
});

test("shareHost builds a one-level name Universal SSL can cover", () => {
  assert.equal(shareHost(3000, "bb.example.com"), "bb-p3000.example.com");
  // One dot only: anything deeper has no certificate.
  assert.equal((shareHost(3000, "bb.example.com") ?? "").split(".").length, 3);
});
