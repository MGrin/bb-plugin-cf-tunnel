export type ConnectorState =
  | "starting"
  | "connected"
  | "down"
  | "not-provisioned"
  | "unknown";

/**
 * What `bb cf-tunnel status` should print.
 *
 * The rule this encodes: "not-provisioned" is a CLAIM, not a default. It tells
 * the reader to run `bb cf-tunnel provision`, so it may only be said when the
 * stored state actually lacks a connector token. A tunnel that is provisioned
 * but whose connector will not start is a different problem needing a different
 * action, and saying "not-provisioned" there sends the reader to re-run a
 * command that already succeeded — which is exactly what happened on
 * 2026-08-15, repeatedly, while the real cause was cloudflared missing from
 * launchd's PATH.
 *
 * Where the plugin cannot tell, it says "unknown" rather than guessing.
 */
export function reportedState(args: {
  provisioned: boolean;
  observed: ConnectorState;
}): ConnectorState {
  if (!args.provisioned) return "not-provisioned";
  // Provisioned: the observed flag may still be carrying a stale or never-set
  // "not-provisioned" from an instance that failed before measuring anything.
  if (args.observed === "not-provisioned") return "unknown";
  return args.observed;
}

/** An error line is worth printing only when it explains a state that is not fine. */
export function shouldShowError(args: {
  reported: ConnectorState;
  error: string | null;
}): boolean {
  return args.error !== null && args.reported !== "connected";
}
