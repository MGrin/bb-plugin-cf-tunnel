import { test } from "node:test";
import assert from "node:assert/strict";
import { addShare, removeShare, activeShares, activePorts, shareUrl } from "./shares.ts";

const T0 = 1_000_000;

test("adding a share sets expiry from the injected clock", () => {
  assert.deepEqual(addShare([], { port: 3000, ttlMs: 60_000, now: T0 }), [
    { port: 3000, expiresAt: T0 + 60_000 },
  ]);
});

test("adding the same port replaces rather than duplicates", () => {
  const a = addShare([], { port: 3000, ttlMs: 60_000, now: T0 });
  const b = addShare(a, { port: 3000, ttlMs: 120_000, now: T0 });
  assert.equal(b.length, 1);
  assert.equal(b[0]?.expiresAt, T0 + 120_000);
});

test("a name is kept when given and absent when not", () => {
  const withName = addShare([], { port: 3000, ttlMs: 1, now: T0, name: "dev" });
  assert.equal(withName[0]?.name, "dev");
  const without = addShare([], { port: 3000, ttlMs: 1, now: T0 });
  assert.equal("name" in (without[0] ?? {}), false);
});

test("an expired share is not active", () => {
  const s = addShare([], { port: 3000, ttlMs: 60_000, now: T0 });
  assert.equal(activeShares(s, T0 + 59_999).length, 1);
  assert.equal(activeShares(s, T0 + 60_001).length, 0);
});

test("expiry is evaluated at read time, not by a sweeper", () => {
  const s = addShare([], { port: 3000, ttlMs: 1, now: T0 });
  assert.deepEqual(activePorts(s, T0 + 10_000), []);
});

test("activePorts returns only unexpired ports", () => {
  let s = addShare([], { port: 3000, ttlMs: 60_000, now: T0 });
  s = addShare(s, { port: 4000, ttlMs: 1, now: T0 });
  assert.deepEqual(activePorts(s, T0 + 100), [3000]);
});

test("removing a share drops it", () => {
  const s = addShare([], { port: 3000, ttlMs: 60_000, now: T0 });
  assert.deepEqual(removeShare(s, 3000), []);
});

test("removing an absent port is a no-op", () => {
  assert.deepEqual(removeShare([], 3000), []);
});

test("share URL is derived from the port and hostname", () => {
  assert.equal(shareUrl(3000, "bb.example.com"), "https://bb-p3000.example.com");
});
