// The set of local ports currently reachable from the internet, and when each
// stops being reachable.
//
// Expiry is evaluated at READ time rather than by a sweeper on a timer. A dead
// sweeper would silently leave a port exposed past its TTL; a read-time check
// cannot, because nothing can route to a port without asking activePorts first.
import { shareHost } from "./routing.ts";

export interface Share {
  port: number;
  name?: string;
  expiresAt: number;
}

export interface AddShareArgs {
  port: number;
  ttlMs: number;
  now: number;
  name?: string;
}

export function addShare(shares: readonly Share[], args: AddShareArgs): Share[] {
  const next: Share = { port: args.port, expiresAt: args.now + args.ttlMs };
  if (args.name !== undefined) next.name = args.name;
  return [...shares.filter((s) => s.port !== args.port), next];
}

export function removeShare(shares: readonly Share[], port: number): Share[] {
  return shares.filter((s) => s.port !== port);
}

export function activeShares(shares: readonly Share[], now: number): Share[] {
  return shares.filter((s) => s.expiresAt > now);
}

export function activePorts(shares: readonly Share[], now: number): number[] {
  return activeShares(shares, now).map((s) => s.port);
}

export function shareUrl(port: number, hostname: string): string {
  const host = shareHost(port, hostname);
  return host === null ? "" : `https://${host}`;
}
