// The local host-header router the tunnel points at.
//
// cloudflared maps a hostname to a STATIC service, so it cannot turn
// p3000.bb.example.com into 127.0.0.1:3000 by itself, and re-pushing tunnel
// config on every share would be slow and rate-limited. Hence one catch-all
// ingress rule to this process, which resolves the Host header itself.
//
// Two invariants:
//
//   1. Every request is gated on a valid Access JWT — unconditionally, not
//      "when we think Access is on". The edge already checked, but this
//      process listens on loopback, so without the check any local process
//      could bypass authentication by setting a Host header.
//   2. Proxied WebSockets get a ping every KEEPALIVE_MS. Measured 2026-08-10:
//      an idle WebSocket through a Cloudflare tunnel is closed at 125.9s with
//      code 1006. Ping frames are answered by browsers automatically and never
//      surfaced to page JS, so bb's frontend cannot observe them.
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { resolveRoute } from "./lib/routing.ts";
import { activePorts, type Share } from "./lib/shares.ts";
import type { VerifyResult } from "./lib/access-jwt.ts";

export const KEEPALIVE_MS = 30_000;

export interface RouterArgs {
  desiredPort: number;
  hostname: string;
  bbOrigin: string;
  getShares: () => Share[];
  now: () => number;
  checkAccess: (token: string | undefined) => Promise<VerifyResult>;
}

export interface RunningRouter {
  port: number;
  close(): Promise<void>;
}

function targetFor(args: RouterArgs, host: string): string | null {
  const route = resolveRoute({
    host,
    hostname: args.hostname,
    sharedPorts: activePorts(args.getShares(), args.now()),
  });
  if (route.kind === "bb") return args.bbOrigin;
  if (route.kind === "port") return `http://127.0.0.1:${route.port}`;
  return null;
}

export async function startRouter(args: RouterArgs): Promise<RunningRouter> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const assertion = req.headers["cf-access-jwt-assertion"];
      const token = Array.isArray(assertion) ? assertion[0] : assertion;
      const verdict = await args.checkAccess(token);
      if (!verdict.ok) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden");
        return;
      }

      const target = targetFor(args, req.headers.host ?? "");
      if (target === null) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("no route");
        return;
      }

      // Headers pass through unmodified on purpose: cloudflared preserves the
      // original Host, which is exactly what bb's browser-request-guard reads
      // to build its trusted-origin set. Rewriting it breaks the app.
      const upstream = new URL(req.url ?? "/", target);
      const proxied = http.request(
        upstream,
        { method: req.method, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      proxied.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end("upstream unavailable");
      });
      req.pipe(proxied);
    })();
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      const assertion = req.headers["cf-access-jwt-assertion"];
      const token = Array.isArray(assertion) ? assertion[0] : assertion;
      const verdict = await args.checkAccess(token);
      const target = verdict.ok ? targetFor(args, req.headers.host ?? "") : null;
      if (target === null) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (client) => {
        const upstreamUrl = new URL(req.url ?? "/", target);
        upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
        const upstream = new WebSocket(upstreamUrl);

        const timer = setInterval(() => {
          if (client.readyState === WebSocket.OPEN) client.ping();
        }, KEEPALIVE_MS);

        let closed = false;
        const shutdown = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          try { client.close(); } catch { /* already gone */ }
          try { upstream.close(); } catch { /* already gone */ }
        };

        const pending: (string | Buffer | ArrayBuffer | Buffer[])[] = [];
        upstream.on("open", () => {
          for (const m of pending.splice(0)) upstream.send(m);
        });
        client.on("message", (m) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(m as Buffer);
          else pending.push(m as Buffer);
        });
        upstream.on("message", (m) => {
          if (client.readyState === WebSocket.OPEN) client.send(m as Buffer);
        });

        client.on("close", shutdown);
        upstream.on("close", shutdown);
        client.on("error", shutdown);
        upstream.on("error", shutdown);
      });
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(args.desiredPort, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        // server.close() only stops accepting and then waits for existing
        // sockets to end. HTTP keep-alive (undici's default, so every fetch
        // client) holds one open indefinitely, which hangs shutdown forever.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
