import { test } from "node:test";
import assert from "node:assert/strict";
import { reportedState, shouldShowError } from "./connector-state.ts";

test("no token stored is the only thing that may be called not-provisioned", () => {
  assert.equal(reportedState({ provisioned: false, observed: "unknown" }), "not-provisioned");
  assert.equal(reportedState({ provisioned: false, observed: "down" }), "not-provisioned");
});

// The regression that caused the outage: provisioned for weeks, connector unable
// to start, and status told everyone to run `provision`.
test("provisioned but never measured reports unknown, NOT not-provisioned", () => {
  assert.equal(reportedState({ provisioned: true, observed: "not-provisioned" }), "unknown");
});

test("a measured state is passed through untouched", () => {
  for (const s of ["connected", "starting", "down", "unknown"] as const) {
    assert.equal(reportedState({ provisioned: true, observed: s }), s);
  }
});

test("the error line explains a bad state and never decorates a good one", () => {
  assert.equal(shouldShowError({ reported: "down", error: "cloudflared not found" }), true);
  assert.equal(shouldShowError({ reported: "unknown", error: "boom" }), true);
  assert.equal(shouldShowError({ reported: "connected", error: "stale error" }), false);
  assert.equal(shouldShowError({ reported: "down", error: null }), false);
});
