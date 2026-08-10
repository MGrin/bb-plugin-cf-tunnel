// cloudflared process supervision.
//
// bb's background service supervisor already restarts a crashed service with
// capped exponential backoff, so this only has to run the process and die
// loudly when it fails. What it must NOT do is start when the Access policy is
// missing: an unprotected tunnel to an unauthenticated bb server is remote code
// execution on this machine, so "refuse to serve" beats "serve and warn".
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ResolveCloudflaredArgs {
  pathEnv: string;
  exists: (p: string) => boolean;
}

export function resolveCloudflaredPath(args: ResolveCloudflaredArgs): string | null {
  for (const dir of args.pathEnv.split(":")) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, "cloudflared");
    if (args.exists(candidate)) return candidate;
  }
  return null;
}

export interface RunConnectorArgs {
  connectorToken: string;
  signal: AbortSignal;
  log: (msg: string) => void;
  onState?: (state: "starting" | "connected" | "down") => void;
}

export async function runConnector(args: RunConnectorArgs): Promise<void> {
  const bin = resolveCloudflaredPath({ pathEnv: process.env.PATH ?? "", exists: existsSync });
  if (bin === null) {
    throw new Error("cloudflared not found on PATH — install it with `brew install cloudflared`");
  }

  args.onState?.("starting");
  // The token goes in the ENVIRONMENT, not argv. `cloudflared tunnel run
  // --token <t>` puts a live credential in the process table where any
  // `ps`/`pgrep` on this machine can read it.
  const child = spawn(bin, ["tunnel", "run"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TUNNEL_TOKEN: args.connectorToken },
  });

  const note = (b: Buffer) => {
    const line = b.toString().trim();
    if (line.length === 0) return;
    // cloudflared logs its successful registration on stderr, not stdout.
    if (line.includes("Registered tunnel connection")) args.onState?.("connected");
    args.log(line);
  };
  child.stdout.on("data", note);
  child.stderr.on("data", note);

  // SIGTERM, then SIGKILL if it lingers. A connector that refuses to die takes
  // the whole plugin down with it: bb marks the plugin `degraded` when a
  // service does not stop, which unregisters its CLI command.
  let killTimer: NodeJS.Timeout | undefined;
  args.signal.addEventListener(
    "abort",
    () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000);
      killTimer.unref?.();
    },
    { once: true },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) =>
        args.signal.aborted ? resolve() : reject(new Error(`cloudflared exited ${code}`)),
      );
      child.on("error", reject);
    });
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer);
    args.onState?.("down");
  }
}
