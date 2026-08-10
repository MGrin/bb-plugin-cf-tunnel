import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAccessJwt } from "./access-jwt.ts";

const NOW = 1_000_000;
const AUD = "app-aud-123";
const good = { aud: [AUD], exp: NOW / 1000 + 3600, email: "you@example.com" };
const ok = async () => good;

test("a valid token passes and yields the email", async () => {
  const r = await verifyAccessJwt({ token: "t", audiences: [AUD], now: NOW, verifySignature: ok });
  assert.deepEqual(r, { ok: true, email: "you@example.com" });
});

test("a MISSING token fails closed", async () => {
  const r = await verifyAccessJwt({ token: undefined, audiences: [AUD], now: NOW, verifySignature: ok });
  assert.equal(r.ok, false);
});

test("an empty token fails closed", async () => {
  const r = await verifyAccessJwt({ token: "", audiences: [AUD], now: NOW, verifySignature: ok });
  assert.equal(r.ok, false);
});

test("a bad signature fails closed", async () => {
  const r = await verifyAccessJwt({ token: "t", audiences: [AUD], now: NOW, verifySignature: async () => null });
  assert.equal(r.ok, false);
});

test("an expired token fails", async () => {
  const expired = async () => ({ ...good, exp: NOW / 1000 - 1 });
  const r = await verifyAccessJwt({ token: "t", audiences: [AUD], now: NOW, verifySignature: expired });
  assert.equal(r.ok, false);
});

test("a wrong audience fails", async () => {
  const other = async () => ({ ...good, aud: ["someone-else"] });
  const r = await verifyAccessJwt({ token: "t", audiences: [AUD], now: NOW, verifySignature: other });
  assert.equal(r.ok, false);
});

test("a verifier that throws fails closed rather than propagating", async () => {
  const boom = async () => {
    throw new Error("jwks unreachable");
  };
  const r = await verifyAccessJwt({ token: "t", audiences: [AUD], now: NOW, verifySignature: boom });
  assert.equal(r.ok, false);
});

test("an empty audience configuration cannot be satisfied", async () => {
  const r = await verifyAccessJwt({ token: "t", audiences: [], now: NOW, verifySignature: ok });
  assert.equal(r.ok, false);
});

test("a token for the WILDCARD app is accepted alongside the apex app", async () => {
  const APEX = "aud-apex";
  const WILD = "aud-wild";
  const wildToken = async () => ({ aud: [WILD], exp: NOW / 1000 + 3600, email: "you@example.com" });
  const r = await verifyAccessJwt({
    token: "t", audiences: [APEX, WILD], now: NOW, verifySignature: wildToken,
  });
  assert.equal(r.ok, true);
});

test("a token for neither configured app is rejected", async () => {
  const stranger = async () => ({ aud: ["aud-someone-else"], exp: NOW / 1000 + 3600 });
  const r = await verifyAccessJwt({
    token: "t", audiences: ["aud-apex", "aud-wild"], now: NOW, verifySignature: stranger,
  });
  assert.equal(r.ok, false);
});

test("a list of empty audiences is treated as unconfigured, not as a wildcard", async () => {
  const r = await verifyAccessJwt({ token: "t", audiences: ["", ""], now: NOW, verifySignature: ok });
  assert.equal(r.ok, false);
});
