import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUDFLARED_FALLBACK_DIRS, resolveCloudflaredPath } from "../connector.ts";

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
  assert.equal(
    resolveCloudflaredPath({ pathEnv: "/a:/b", exists: () => true, fallbackDirs: [] }),
    "/a/cloudflared",
  );
});

test("skips empty PATH segments", () => {
  assert.equal(
    resolveCloudflaredPath({ pathEnv: "::/opt/bin:", exists: (x) => x === "/opt/bin/cloudflared" }),
    "/opt/bin/cloudflared",
  );
});

test("an empty PATH yields null rather than a bare relative path", () => {
  // fallbackDirs cleared so this still tests PATH PARSING and nothing else — with
  // the real fallbacks an empty PATH legitimately resolves, which is the point of
  // them.
  assert.equal(
    resolveCloudflaredPath({ pathEnv: "", exists: () => true, fallbackDirs: [] }),
    null,
  );
});

// A GUI-launched bb gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), which has
// no Homebrew. This was a real outage: the connector could not find an installed
// cloudflared, threw, and the tunnel stayed down until bb was started from a shell.
test("finds cloudflared in a fallback dir when PATH does not have it", () => {
  assert.equal(
    resolveCloudflaredPath({
      pathEnv: "/usr/bin:/bin:/usr/sbin:/sbin",
      exists: (x) => x === "/opt/homebrew/bin/cloudflared",
    }),
    "/opt/homebrew/bin/cloudflared",
  );
});

test("PATH still wins over the fallbacks", () => {
  assert.equal(
    resolveCloudflaredPath({ pathEnv: "/custom/bin", exists: () => true }),
    "/custom/bin/cloudflared",
  );
});

test("still null when it is installed nowhere we know", () => {
  assert.equal(
    resolveCloudflaredPath({ pathEnv: "/usr/bin", exists: () => false, fallbackDirs: ["/nope"] }),
    null,
  );
});

test("the shipped fallback list covers both Homebrew prefixes", () => {
  assert.ok(CLOUDFLARED_FALLBACK_DIRS.includes("/opt/homebrew/bin"));
  assert.ok(CLOUDFLARED_FALLBACK_DIRS.includes("/usr/local/bin"));
});
