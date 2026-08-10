// Host header -> where the router sends the request.
//
// Share hosts are `<label>-p<port>.<zone>` (bb-p3000.example.com), NOT
// `p<port>.<label>.<zone>`. That is forced by Cloudflare Universal SSL, which
// covers `zone` and `*.zone` but nothing deeper: p3000.bb.example.com has no
// certificate and fails the TLS handshake before Access is ever consulted.
// Verified against the live zone on 2026-08-10.
//
// The sharedPorts allow-list is a security control, not bookkeeping: without it
// bb-p22.example.com would reach the SSH daemon.
export interface ResolveRouteArgs {
  host: string;
  /** e.g. "bb.example.com" — its first label also names the share hosts. */
  hostname: string;
  sharedPorts: readonly number[];
}

export type Route =
  | { kind: "bb" }
  | { kind: "port"; port: number }
  | { kind: "reject" };

/** "bb.example.com" -> { label: "bb", zone: "example.com" } */
export function splitHostname(hostname: string): { label: string; zone: string } | null {
  const dot = hostname.indexOf(".");
  if (dot <= 0 || dot === hostname.length - 1) return null;
  return { label: hostname.slice(0, dot), zone: hostname.slice(dot + 1) };
}

/** The public host that exposes a local port, e.g. bb-p3000.example.com */
export function shareHost(port: number, hostname: string): string | null {
  const parts = splitHostname(hostname);
  return parts === null ? null : `${parts.label}-p${port}.${parts.zone}`;
}

export function resolveRoute(args: ResolveRouteArgs): Route {
  const host = (args.host.split(":", 1)[0] ?? "").toLowerCase();
  const hostname = args.hostname.toLowerCase();
  if (host.length === 0) return { kind: "reject" };
  if (host === hostname) return { kind: "bb" };

  const parts = splitHostname(hostname);
  if (parts === null) return { kind: "reject" };

  const suffix = `.${parts.zone.toLowerCase()}`;
  if (!host.endsWith(suffix)) return { kind: "reject" };

  // Exactly one label before the zone, and it must be `<label>-p<digits>`.
  // Anchoring is what rejects x.bb-p3000.example.com and app.example.com alike.
  const first = host.slice(0, -suffix.length);
  const m = new RegExp(`^${parts.label.toLowerCase()}-p([0-9]{1,5})$`, "u").exec(first);
  if (m === null) return { kind: "reject" };

  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { kind: "reject" };
  if (!args.sharedPorts.includes(port)) return { kind: "reject" };
  return { kind: "port", port };
}
