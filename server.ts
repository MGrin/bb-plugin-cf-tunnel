// bb-plugin-cf-tunnel — reach bb from anywhere over your own Cloudflare
// Tunnel and Access policy, replacing the bb connect relay on getbb.app.
//
//   phone -> Cloudflare edge (Access) -> cloudflared -> host router -> bb server
//
// See docs/superpowers/specs/2026-08-10-cf-tunnel-design.md. The two rules that
// shape everything here:
//
//   1. The bb server has NO authentication of its own. Whoever reaches the
//      origin can spawn agents and run shell commands. So the connector never
//      starts unless both Access applications exist, and the router rejects
//      any request without a valid Access JWT.
//   2. Cloudflare closes idle WebSockets at ~126s (measured). The router pings
//      every 30s; without it an idle terminal on the phone dies silently.
import { execFileSync } from "node:child_process";
import { createCloudflareClient } from "./lib/cloudflare.ts";
import { provision, protectedDomains, acceptedAuds, type ProvisionState } from "./lib/provision.ts";
import { verifyAccessJwt, type JwtClaims } from "./lib/access-jwt.ts";
import { addShare, removeShare, activeShares, shareUrl, type Share } from "./lib/shares.ts";
import { shareHost } from "./lib/routing.ts";
import { startRouter, type RunningRouter } from "./router.ts";
import { runConnector } from "./connector.ts";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      connectorState: z.string(),
      hostname: z.string(),
      url: z.string(),
      provisioned: z.boolean(),
      routerPort: z.number(),
      shares: z.array(z.object({ port: z.number(), url: z.string(), expiresAt: z.number() })),
    }),
  },
  provision: {
    input: z.null(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  unshare: {
    input: z.object({ port: z.number() }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
});

import { reportedState, shouldShowError, type ConnectorState } from "./lib/connector-state.ts";

const STATE_KEY = "provision-state";
const SHARES_KEY = "shares";
const ROUTER_PORT_KEY = "router-port";



/**
 * Which commit is this PROCESS running? (MX-139/MX-141)
 *
 * bb bundles a `path:` plugin FROM SOURCE at reload, so a revision read here — at module
 * load, the same moment — is by construction the code now executing. Nothing else can say:
 * `bb plugin list` prints `running` and the source path but no revision, `bb plugin source`
 * has none to record for a path: source, and dist/ is NOT the loaded artifact (its mtime was
 * measured lying by 15 minutes). So a checkout can sit clean on main, every drift check
 * green, while the process runs something older.
 *
 * Synchronous on purpose: the value must be fixed before anything can observe it, and it is
 * one git call per load. Failure yields rev: null rather than a guess — a tarball install has
 * no git dir, and that must stay distinguishable from a real mismatch so a checker reports
 * UNKNOWN rather than OK. `dirty` rides along because a bundle built from an edited tree
 * matches NO commit, and comparing revisions alone would call that a match.
 */
const BUILD_STAMP: { rev: string | null; dirty: boolean | null; sourceDir: string; loadedAt: string; why: string | null } = (() => {
  const here = import.meta.dirname;
  const loadedAt = new Date().toISOString();
  try {
    const git = (args: string[]): string =>
      execFileSync("git", ["-C", here, ...args], { encoding: "utf8", timeout: 5000 }).trim();
    return {
      rev: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]).length > 0,
      sourceDir: git(["rev-parse", "--show-toplevel"]),
      loadedAt,
      why: null,
    };
  } catch (e) {
    return { rev: null, dirty: null, sourceDir: here, loadedAt, why: e instanceof Error ? e.message : String(e) };
  }
})();

export default async function plugin(bb: BbPluginApi) {
  // `secret: true` lands in a 0600 file under <dataDir>/plugins/<id>/secrets/,
  // never in bb.db and never sent to the frontend. That matters if you back up
  // or sync bb.db anywhere: a plain setting would put a live Cloudflare token
  // wherever that backup goes.
  const settings = bb.settings.define({
    apiToken: {
      type: "string",
      label: "Cloudflare API token",
      description: "From your password manager",
      secret: true,
    },
    accountId: { type: "string", label: "Cloudflare account id", default: "" },
    zoneId: { type: "string", label: "Cloudflare zone id", default: "" },
    hostname: { type: "string", label: "Hostname", description: "e.g. bb.example.com", default: "" },
    teamDomain: {
      type: "string",
      label: "Access team domain",
      description: "e.g. yourteam.cloudflareaccess.com",
      default: "",
    },
    allowedEmails: { type: "string", label: "Allowed emails", description: "comma-separated", default: "" },
    sessionDuration: { type: "string", label: "Access session duration", default: "720h" },
    shareTtlHours: { type: "string", label: "Default share TTL (hours)", default: "24" },
  });

  const cfg = await settings.get();
  if (!cfg.apiToken || !cfg.accountId || !cfg.zoneId || !cfg.hostname) {
    bb.status.needsConfiguration(
      "Set apiToken, accountId, zoneId and hostname (bb plugin config cf-tunnel), then `bb plugin reload cf-tunnel`",
    );
    return;
  }

  const client = createCloudflareClient({
    token: cfg.apiToken,
    accountId: cfg.accountId,
    zoneId: cfg.zoneId,
    fetchImpl: fetch,
  });

  // ---------------------------------------------------------------- state ---

  const loadState = async (): Promise<Partial<ProvisionState>> =>
    (await bb.storage.kv.get<Partial<ProvisionState>>(STATE_KEY)) ?? {};
  const saveState = async (s: Partial<ProvisionState>) => {
    await bb.storage.kv.set(STATE_KEY, s);
  };
  const loadShares = async (): Promise<Share[]> =>
    (await bb.storage.kv.get<Share[]>(SHARES_KEY)) ?? [];
  const saveShares = async (s: Share[]) => {
    await bb.storage.kv.set(SHARES_KEY, s);
  };

  // The router port is persisted, not ephemeral: the tunnel's single ingress
  // rule points at it, so a new port on every restart would break the tunnel.
  const routerPort =
    (await bb.storage.kv.get<number>(ROUTER_PORT_KEY)) ??
    (await (async () => {
      const p = 8790;
      await bb.storage.kv.set(ROUTER_PORT_KEY, p);
      return p;
    })());

  let shares = await loadShares();
  // "unknown" until something MEASURES it. The old initial value was
  // "not-provisioned", which is not a neutral default — it is a specific claim
  // that tells the reader to run `bb cf-tunnel provision`. When the connector
  // failed for an unrelated reason (it could not find cloudflared on launchd's
  // PATH) that label sent mgrin, and an agent, to run provision repeatedly
  // against a tunnel that had been fully provisioned for weeks.
  let connectorState: ConnectorState = "unknown";
  let connectorError: string | null = null;
  let router: RunningRouter | null = null;

  // ------------------------------------------------------------ JWT check ---

  // Cloudflare publishes the team's signing keys here. Verification is done
  // with the platform's own WebCrypto so the plugin ships no crypto library.
  let jwks: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
  async function teamKeys(): Promise<JsonWebKey[]> {
    if (jwks !== null && Date.now() - jwks.fetchedAt < 3_600_000) return jwks.keys;
    const res = await fetch(`https://${cfg.teamDomain}/cdn-cgi/access/certs`);
    const body = (await res.json()) as { keys: JsonWebKey[] };
    jwks = { keys: body.keys ?? [], fetchedAt: Date.now() };
    return jwks.keys;
  }

  function b64url(s: string): Uint8Array {
    return Buffer.from(s.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
  }

  async function verifySignature(token: string): Promise<JwtClaims | null> {
    const [h, p, s] = token.split(".");
    if (h === undefined || p === undefined || s === undefined) return null;
    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = b64url(s);
    for (const jwk of await teamKeys()) {
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          jwk,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data)) {
          const claims = JSON.parse(Buffer.from(b64url(p)).toString("utf8")) as {
            aud?: string | string[];
            exp?: number;
            email?: string;
          };
          return {
            aud: Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [],
            exp: claims.exp ?? 0,
            ...(claims.email !== undefined ? { email: claims.email } : {}),
          };
        }
      } catch {
        // Wrong key for this token; try the next one.
      }
    }
    return null;
  }

  const checkAccess = async (token: string | undefined) => {
    const st = await loadState();
    return verifyAccessJwt({
      token,
      audiences: acceptedAuds(st),
      now: Date.now(),
      verifySignature,
    });
  };

  // ------------------------------------------------------------ provision ---

  async function doProvision(): Promise<ProvisionState> {
    if (!(await client.verifyToken())) {
      throw new Error("Cloudflare token rejected — check it has Tunnel:Edit and Access:Edit");
    }
    const emails = cfg.allowedEmails.split(",").map((e) => e.trim()).filter(Boolean);
    if (emails.length === 0) throw new Error("allowedEmails is empty — refusing to create an open policy");

    return provision({
      client,
      state: await loadState(),
      hostname: cfg.hostname,
      routerPort,
      sessionDuration: cfg.sessionDuration,
      emails,
      saveState,
    });
  }

  // A share host is one level deep (bb-p3000.example.com) so Cloudflare's
  // Universal SSL certificate covers it; p3000.bb.example.com is two levels deep
  // and has no certificate at all, which fails the TLS handshake before Access
  // is consulted. Each share therefore needs its OWN DNS record and Access app,
  // created here and torn down on unshare. A wildcard would have to be
  // *.example.com, which would swallow every other site in the zone.
  async function ensureShareHost(port: number): Promise<string> {
    const st = await loadState();
    if (st.tunnelId === undefined) throw new Error("not provisioned — run `bb cf-tunnel provision`");
    const host = shareHost(port, cfg.hostname);
    if (host === null) throw new Error(`cannot derive a share host from ${cfg.hostname}`);

    if ((await client.findDnsRecord(host)) === null) {
      await client.createDnsRecord(host, `${st.tunnelId}.cfargotunnel.com`);
    }

    let app = await client.findAccessApp(host);
    if (app === null) {
      const emails = cfg.allowedEmails.split(",").map((e) => e.trim()).filter(Boolean);
      if (emails.length === 0) throw new Error("allowedEmails is empty — refusing to publish an open share");
      app = await client.createAccessApp({
        name: `bb share ${port} (${host})`,
        domain: host,
        sessionDuration: cfg.sessionDuration,
      });
      await client.createAccessPolicy(app.id, emails);
    }

    // The router must accept this app's audience too, or the share 403s.
    const next = await loadState();
    next.apps = { ...(next.apps ?? {}), [host]: { id: app.id, aud: app.aud } };
    await saveState(next);
    return host;
  }

  async function removeShareHost(port: number): Promise<void> {
    const host = shareHost(port, cfg.hostname);
    if (host === null) return;
    const st = await loadState();

    // Fall back to looking the app up by domain when local state does not know
    // it. State can be lost or migrated, and an Access app we forget about is
    // an orphan sitting on the account forever — the DNS record disappears and
    // the protection outlives the thing it protected.
    const owned = st.apps?.[host] ?? (await client.findAccessApp(host).catch(() => null));
    if (owned !== null && owned !== undefined) {
      await client.deleteAccessApp(owned.id).catch(() => undefined);
      const { [host]: _dropped, ...rest } = st.apps ?? {};
      st.apps = rest;
    }
    const rec = await client.findDnsRecord(host);
    if (rec !== null) await client.deleteDnsRecord(rec.id).catch(() => undefined);
    await saveState(st);
  }

  /** The apex Access app must exist, or we do not serve. */
  async function accessHealthy(): Promise<boolean> {
    for (const domain of protectedDomains(cfg.hostname)) {
      if ((await client.findAccessApp(domain)) === null) return false;
    }
    return true;
  }

  // -------------------------------------------------------------- services ---

  bb.background.service("router", {
    async start(signal) {
      router = await startRouter({
        desiredPort: routerPort,
        hostname: cfg.hostname,
        bbOrigin: bb.server.loopbackBaseUrl,
        getShares: () => shares,
        now: () => Date.now(),
        checkAccess,
      });
      bb.log.info(`host router listening on 127.0.0.1:${router.port}`);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await router.close();
      router = null;
    },
  });

  bb.background.service("connector", {
    async start(signal) {
      // Any throw out of start() is why the tunnel is not up, so it is the one
      // thing status must be able to show. Without this the reader sees a state
      // word and no reason, and the reason was the whole answer.
      const fail = (state: ConnectorState, msg: string): never => {
        connectorState = state;
        connectorError = msg;
        throw new Error(msg);
      };
      const st = await loadState();
      if (st.connectorToken === undefined) {
        fail("not-provisioned", "not provisioned — run `bb cf-tunnel provision`");
      }
      if (!(await accessHealthy())) {
        fail("down", "Access application missing — refusing to serve bb unprotected");
      }
      connectorError = null;
      try {
      await runConnector({
        connectorToken: st.connectorToken,
        signal,
        log: (m) => bb.log.info(m),
        onState: (s) => {
          connectorState = s;
        },
      });
      } catch (e) {
        connectorError = e instanceof Error ? e.message : String(e);
        connectorState = "down";
        throw e;
      }
    },
  });

  bb.background.schedule("access-health", "0 * * * *", async () => {
    const st = await loadState();
    if (st.connectorToken === undefined) return;
    if (!(await accessHealthy())) {
      bb.log.error("Access application missing — bb may be exposed; stopping is required");
      connectorState = "down";
    }
  });

  // ------------------------------------------------------------------ CLI ---

  bb.cli.register({
    name: "cf-tunnel",
    summary: "Your own Cloudflare Tunnel for reaching bb remotely",
    commands: [
      { name: "status", summary: "Tunnel state, URL and shared ports", usage: "bb cf-tunnel status" },
      { name: "provision", summary: "Create/converge tunnel, DNS and Access", usage: "bb cf-tunnel provision" },
      { name: "share", summary: "Expose a local port", usage: "bb cf-tunnel share <port> [--ttl <hours>]" },
      { name: "unshare", summary: "Stop exposing a local port", usage: "bb cf-tunnel unshare <port>" },
      {
        name: "build",
        summary: "Which commit this RUNNING process was loaded from (not the checkout)",
        usage: "bb cf-tunnel build [--json]",
      },
    ],
    async run(argv) {
      const [cmd, arg] = argv;

      // Answered FIRST, ahead of `provision` (which creates tunnel/DNS/Access) and `share`
      // (which EXPOSES a local port to the internet): "what is running" must stay answerable
      // when the thing running is broken, and must never have a side effect of its own.
      if (cmd === "build") {
        if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(BUILD_STAMP) };
        const dirty = BUILD_STAMP.dirty === null ? "" : BUILD_STAMP.dirty ? " +dirty" : "";
        const why = BUILD_STAMP.why ? `  (${BUILD_STAMP.why})` : "";
        return {
          exitCode: 0,
          stdout: `loaded ${BUILD_STAMP.rev ?? "unknown"}${dirty} from ${BUILD_STAMP.sourceDir} at ${BUILD_STAMP.loadedAt}${why}`,
        };
      }

      if (cmd === "provision") {
        const st = await doProvision();
        return {
          exitCode: 0,
          stdout: `provisioned tunnel ${st.tunnelId}\nhttps://${cfg.hostname}\nAccess apps: ${Object.keys(st.apps).join(", ")}`,
        };
      }

      if (cmd === "share") {
        const port = Number(arg);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return { exitCode: 1, stdout: "usage: bb cf-tunnel share <port> [--ttl <hours>]" };
        }
        const ttlIdx = argv.indexOf("--ttl");
        const hours = ttlIdx >= 0 ? Number(argv[ttlIdx + 1]) : Number(cfg.shareTtlHours);
        // Publish the host BEFORE recording the share: if Cloudflare refuses,
        // we must not end up advertising a URL that resolves to nothing.
        await ensureShareHost(port);
        shares = addShare(shares, {
          port,
          ttlMs: (Number.isFinite(hours) ? hours : 24) * 3_600_000,
          now: Date.now(),
        });
        await saveShares(shares);
        // Only the URL on stdout: the share-server-links skill consumes this.
        return { exitCode: 0, stdout: shareUrl(port, cfg.hostname) };
      }

      if (cmd === "unshare") {
        const port = Number(arg);
        shares = removeShare(shares, port);
        await saveShares(shares);
        await removeShareHost(port);
        return { exitCode: 0, stdout: `unshared ${port}` };
      }

      const st = await loadState();
      const live = activeShares(shares, Date.now());
      // Provisioning is a fact about stored state, so read it from there rather
      // than from a flag a failed service may never have set. A token present
      // with the connector down is NOT "not-provisioned" — it is provisioned and
      // broken, and those need different actions from the reader.
      const reported = reportedState({
        provisioned: st.connectorToken !== undefined,
        observed: connectorState,
      });
      const live2 = live;
      const lines = [
        `state:    ${reported}`,
        `url:      https://${cfg.hostname}`,
        `tunnel:   ${st.tunnelId ?? "(not provisioned)"}`,
        `router:   127.0.0.1:${routerPort}`,
        `protected: ${protectedDomains(cfg.hostname).join(", ")}`,
        ...(shouldShowError({ reported, error: connectorError })
          ? [`error:    ${connectorError}`]
          : []),
        live2.length === 0
          ? "shares:   (none)"
          : `shares:\n${live2
              .map((s) => `  ${shareUrl(s.port, cfg.hostname)}  expires in ${Math.round((s.expiresAt - Date.now()) / 60000)}m`)
              .join("\n")}`,
      ];
      return { exitCode: 0, stdout: lines.join("\n") };
    },
  });

  // ------------------------------------------------------------------ RPC ---

  bb.rpc.register(rpcContract, {
    async provision() {
      try {
        const st = await doProvision();
        return { ok: true, message: `tunnel ${st.tunnelId}` };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },

    async unshare({ port }) {
      try {
        shares = removeShare(shares, port);
        await saveShares(shares);
        await removeShareHost(port);
        return { ok: true, message: `unshared ${port}` };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },

    async status() {
      const st = await loadState();
      return {
        connectorState,
        hostname: cfg.hostname,
        url: `https://${cfg.hostname}`,
        provisioned: st.tunnelId !== undefined,
        routerPort,
        shares: activeShares(shares, Date.now()).map((sh) => ({
          port: sh.port,
          url: shareUrl(sh.port, cfg.hostname),
          expiresAt: sh.expiresAt,
        })),
      };
    },
  });
}
