import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCloudflaredPath } from "../connector.ts";

test("finds cloudflared on PATH", () => {
  assert.equal(
    resolveCloudflaredPath({
      pathEnv: "/usr/bin:/opt/homebrew/bin",
      exists: (x) => x === "/opt/homebrew/bin/cloudflared",
    }),
    "/opt/homebrew/bin/cloudflared",
  );
});

test("returns null when cloudflared is absent", () => {
  assert.equal(resolveCloudflaredPath({ pathEnv: "/usr/bin", exists: () => false }), null);
});

test("prefers the earliest PATH entry", () => {
  assert.equal(resolveCloudflaredPath({ pathEnv: "/a:/b", exists: () => true }), "/a/cloudflared");
});

test("skips empty PATH segments", () => {
  assert.equal(
    resolveCloudflaredPath({ pathEnv: "::/opt/bin:", exists: (x) => x === "/opt/bin/cloudflared" }),
    "/opt/bin/cloudflared",
  );
});

test("an empty PATH yields null rather than a bare relative path", () => {
  assert.equal(resolveCloudflaredPath({ pathEnv: "", exists: () => true }), null);
});
