<!-- agents-md ceiling: 65 lines -->
# AGENTS.md — bb-plugin-cf-tunnel

A bb plugin that reaches a bb instance over the owner's own Cloudflare Tunnel and Access
policy. **[`README.md`](README.md) is the user-facing document** — the architecture
diagram, the security model, how to mint the API token, and the three Cloudflare facts
that shaped the design (Universal SSL is one level deep; Cloudflare closes an idle
WebSocket at 125.9s; `GET /user/tokens/verify` rejects a valid account-owned token). It is
accurate; read it before changing behaviour rather than re-deriving any of that here.

## Commands, all verified 2026-09-09

```sh
npm install          # 8 packages, ~12s
npm test             # node --test over lib/*.test.ts — 78 tests, 0 fail, 245ms
bb plugin build .    # -> dist/{server,app}.js + .meta.json + app.css, rc=0
```

**`npm run typecheck` is BROKEN and has been all along**: there is no `tsconfig.json` in
this repo, so `tsc --noEmit` gets no files, prints its own `--help` and exits 1. Measured
2026-09-09. It is not a red you caused; either add a `tsconfig.json` or drop the script,
in its own PR. Until then `npm test` is the whole local gate.

## The gate

`npm test` **and** the `Managed install` GitHub Actions workflow
(`.github/workflows/managed-install.yml`), which is the one that catches the failure a
clone cannot:

> bb's managed git install resolves **runtime dependencies only** —
> `npm install --omit=dev --omit=optional --ignore-scripts` — and then runs
> `bb plugin build`. A module imported at runtime but parked in `devDependencies`
> therefore builds fine in your working copy and fails for **every** real user.

So: anything `server.ts`, `router.ts`, `connector.ts`, `app.tsx` or `lib/**` imports at
runtime belongs in `dependencies`, never `devDependencies`. The workflow reproduces the
managed sequence and asserts all six artifacts are non-empty; a PR that goes red there is
not installable, whatever `npm test` says.

## Layout

| path | what it is |
|---|---|
| `lib/*.ts` | every decision the plugin makes, with the clock, `fetch` and JWT verification injected |
| `lib/*.test.ts` | the suite, colocated with its subject, offline by construction |
| `server.ts`, `router.ts`, `connector.ts`, `app.tsx` | thin adapters — bb wiring, HTTP, the `cloudflared` child process, the panel |

## Conventions that differ from the defaults

- **Tests are `node --test --experimental-strip-types`, not vitest or jest**, run against
  the TypeScript sources with no build step. A new suite must be `lib/<name>.test.ts` or
  the `npm test` glob does not see it.
- **Nothing in the suite touches the network or needs a Cloudflare account.** Keep it that
  way: inject the dependency rather than reaching for the real one, which is why every
  `lib` module takes its clock and `fetch` as arguments.
- **The router must fail closed.** It listens on loopback, so an unauthenticated path
  there is an unauthenticated path from any local process. Every request is verified
  against the team's Access keys unconditionally — do not add a "when Access is enabled"
  branch.

**Nothing about who may merge, how agents are spawned, or how the maintainer's
machine handles secrets belongs in this file, and none of it is stated here.**
Those are properties of a working environment, not of this project; if you are
contributing, your own conventions apply and nothing in this repo depends on
the maintainer's.
