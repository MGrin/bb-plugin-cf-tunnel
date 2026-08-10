// Idempotent Cloudflare provisioning.
//
// The property that matters is CONVERGENCE: a half-failed run must be safe to
// retry. That is why saveState is called after each resource is created rather
// than once at the end — a crash between steps leaves durable state pointing at
// what already exists, so the next run adopts instead of duplicating. A
// provisioner that cannot be retried safely is the worst state this plugin
// could be in, because the failure mode is a second live tunnel nobody is
// watching.
import type { CloudflareClient } from "./cloudflare.ts";

export interface ProvisionState {
  tunnelId: string;
  connectorToken: string;
  /**
   * Access applications keyed by the domain each covers. Keying by domain is
   * what makes pruning possible: an app deleted at Cloudflare can be dropped
   * here together with its audience, instead of leaving an orphan aud in a
   * flat list that nothing can map back to a hostname.
   */
  apps: Record<string, { id: string; aud: string }>;
}

export interface ProvisionArgs {
  client: CloudflareClient;
  state: Partial<ProvisionState>;
  hostname: string;
  routerPort: number;
  sessionDuration: string;
  emails: readonly string[];
  saveState: (state: Partial<ProvisionState>) => Promise<void>;
}

export async function provision(args: ProvisionArgs): Promise<ProvisionState> {
  const state: Partial<ProvisionState> = { ...args.state };
  const tunnelName = `bb-${args.hostname}`;

  if (state.tunnelId === undefined) {
    const existing = await args.client.findTunnel(tunnelName);
    state.tunnelId = existing?.id ?? (await args.client.createTunnel(tunnelName)).id;
    await args.saveState(state);
  }

  if (state.connectorToken === undefined) {
    state.connectorToken = await args.client.getTunnelToken(state.tunnelId);
    await args.saveState(state);
  }

  // Written every run rather than once: the router port can change if the
  // persisted port is taken at startup, and this rule is what makes the tunnel
  // reach it. Re-writing an identical config is a no-op at Cloudflare.
  await args.client.putTunnelConfig(state.tunnelId, `http://127.0.0.1:${args.routerPort}`);

  // Only the apex host is created up front. Share hosts (bb-p3000.example.com)
  // are created on demand by ensureShareHost, because a wildcard covering them
  // would have to be `*.example.com` — which would shadow every other site in the
  // zone and put them behind Access.
  const target = `${state.tunnelId}.cfargotunnel.com`;
  if ((await args.client.findDnsRecord(args.hostname)) === null) {
    await args.client.createDnsRecord(args.hostname, target);
  }

  // The apex needs its own Access application. Share hosts get theirs on
  // demand — see ensureShareHost — because a wildcard covering them would have
  // to be *.example.com, which would swallow every other site in the zone.
  state.apps ??= {};

  for (const domain of protectedDomains(args.hostname)) {
    if (state.apps[domain] !== undefined) continue;

    const found = await args.client.findAccessApp(domain);
    const app =
      found ??
      (await args.client.createAccessApp({
        name: `bb (${domain})`,
        domain,
        sessionDuration: args.sessionDuration,
      }));

    state.apps[domain] = { id: app.id, aud: app.aud };
    await args.saveState(state);

    // Only a freshly created app gets a policy. Adding one to an app that
    // already existed would silently widen rules the user set themselves.
    if (found === null) {
      await args.client.createAccessPolicy(app.id, args.emails);
    }
  }

  return state as ProvisionState;
}

/** Audiences the router may accept, derived from the apps we actually own. */
export function acceptedAuds(state: Partial<ProvisionState>): string[] {
  return Object.values(state.apps ?? {}).map((a) => a.aud);
}

/** The exact hostnames this plugin puts behind Access — never a broader zone. */
export function protectedDomains(hostname: string): string[] {
  return [hostname];
}
