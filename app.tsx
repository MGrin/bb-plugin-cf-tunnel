// bb-plugin-cf-tunnel frontend — tunnel state, the public URL, and shared ports.
//
// The panel's job is to answer three questions at a glance: is the tunnel up,
// what URL do I open on my phone, and what of mine is currently reachable from
// the internet. The last one matters most — a shared port is a hole in the
// firewall with a timer on it, so it is rendered with its countdown and a
// one-click way to close it early.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Status = {
  connectorState: string;
  hostname: string;
  url: string;
  provisioned: boolean;
  routerPort: number;
  shares: { port: number; url: string; expiresAt: number }[];
};

const TONE: Record<string, string> = {
  connected: "text-primary",
  starting: "text-muted-foreground",
  down: "text-destructive",
  "not-provisioned": "text-muted-foreground",
};

function remaining(expiresAt: number, now: number): string {
  const mins = Math.max(0, Math.round((expiresAt - now) / 60_000));
  if (mins < 60) return `${mins}m left`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m left`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function TunnelSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Countdowns must tick without refetching; the server is not the clock here.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setSt((await rpc.call("status", null)) as Status);
  }, [rpc]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 15_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const act = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fn();
      setNote(r.message);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (st === null) return null;

  const live = st.shares.filter((s) => s.expiresAt > now);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between">
          <span className={`text-sm ${TONE[st.connectorState] ?? "text-muted-foreground"}`}>
            ● {st.connectorState}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            router 127.0.0.1:{st.routerPort}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          {st.provisioned ? (
            <a
              href={st.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-foreground hover:underline truncate"
            >
              {st.url}
            </a>
          ) : (
            <span className="text-sm text-muted-foreground">not provisioned</span>
          )}
          {st.provisioned && <CopyButton value={st.url} />}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-3">
        <div className="mb-2 text-xs text-muted-foreground">
          Shared ports {live.length > 0 && `(${live.length} reachable from the internet)`}
        </div>
        {live.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            none — <span className="font-mono">bb cf-tunnel share &lt;port&gt;</span>
          </div>
        ) : (
          <div className="space-y-2">
            {live.map((s) => (
              <div key={s.port} className="flex items-center justify-between gap-2">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-foreground hover:underline truncate"
                >
                  {s.url}
                </a>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {remaining(s.expiresAt, now)}
                  </span>
                  <CopyButton value={s.url} />
                  <button
                    type="button"
                    disabled={busy}
                    className="text-xs text-destructive hover:underline disabled:opacity-50"
                    onClick={() =>
                      void act(
                        () =>
                          rpc.call("unshare", { port: s.port }) as Promise<{
                            ok: boolean;
                            message: string;
                          }>,
                      )
                    }
                  >
                    unshare
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          disabled={busy}
          className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          onClick={() =>
            void act(
              () => rpc.call("provision", null) as Promise<{ ok: boolean; message: string }>,
            )
          }
        >
          {busy ? "working…" : st.provisioned ? "reprovision" : "provision"}
        </button>
        {note !== null && <span className="text-xs text-muted-foreground truncate">{note}</span>}
      </div>
    </div>
  );
}

function TunnelPanel() {
  return (
    <div className="p-4 max-w-2xl">
      <TunnelSection />
    </div>
  );
}

export default definePluginApp((app) => {
  // Homepage section for the at-a-glance state, and a sidebar panel for when
  // you want to go look at it deliberately — chiefly to see what of yours is
  // currently reachable from the internet, and close it.
  app.slots.homepageSection({
    id: "cf-tunnel",
    title: "Cloudflare Tunnel",
    component: TunnelSection,
  });
  app.slots.navPanel({
    id: "cf-tunnel-panel",
    title: "Tunnel",
    icon: "Cloud",
    path: "tunnel",
    component: TunnelPanel,
  });
});
