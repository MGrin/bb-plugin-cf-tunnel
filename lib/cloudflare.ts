// Typed Cloudflare API v4 client, over an injected fetch so tests need no
// network and no account.
//
// One non-obvious detail, learned the hard way on 2026-08-10: your token is
// ACCOUNT-owned, and GET /user/tokens/verify reports `1000 Invalid API Token`
// for it even though the token is perfectly valid. The account path is the
// correct one. A test pins this so nobody "fixes" it back.
const API = "https://api.cloudflare.com/client/v4";

export interface CloudflareClientArgs {
  token: string;
  accountId: string;
  zoneId: string;
  fetchImpl: typeof fetch;
}

export interface CloudflareClient {
  verifyToken(): Promise<boolean>;
  findTunnel(name: string): Promise<{ id: string } | null>;
  createTunnel(name: string): Promise<{ id: string }>;
  getTunnelToken(id: string): Promise<string>;
  putTunnelConfig(id: string, originUrl: string): Promise<void>;
  findDnsRecord(name: string): Promise<{ id: string } | null>;
  createDnsRecord(name: string, content: string): Promise<void>;
  deleteDnsRecord(id: string): Promise<void>;
  deleteAccessApp(id: string): Promise<void>;
  findAccessApp(domain: string): Promise<{ id: string; aud: string } | null>;
  createAccessApp(args: {
    name: string;
    domain: string;
    sessionDuration: string;
  }): Promise<{ id: string; aud: string }>;
  createAccessPolicy(appId: string, emails: readonly string[]): Promise<void>;
}

interface ApiEnvelope<T> {
  success: boolean;
  result?: T;
  errors?: { message?: string }[];
}

export function createCloudflareClient(args: CloudflareClientArgs): CloudflareClient {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await args.fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${args.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json()) as ApiEnvelope<T>;
    if (!body.success) {
      const msg = (body.errors ?? []).map((e) => e.message ?? "unknown").join("; ");
      throw new Error(`Cloudflare API ${path}: ${msg || "request failed"}`);
    }
    return body.result as T;
  }

  const acct = `/accounts/${args.accountId}`;

  return {
    async verifyToken() {
      try {
        await call(`${acct}/tokens/verify`);
        return true;
      } catch {
        return false;
      }
    },

    async findTunnel(name) {
      const r = await call<{ id: string; name: string; deleted_at?: string | null }[]>(
        `${acct}/cfd_tunnel?name=${encodeURIComponent(name)}`,
      );
      const hit = (r ?? []).find((t) => t.name === name && !t.deleted_at);
      return hit ? { id: hit.id } : null;
    },

    async createTunnel(name) {
      return call<{ id: string }>(`${acct}/cfd_tunnel`, {
        method: "POST",
        body: JSON.stringify({ name, config_src: "cloudflare" }),
      });
    },

    async getTunnelToken(id) {
      // The create response does NOT carry the connector token; it is a
      // separate endpoint, and this is the value `cloudflared tunnel run
      // --token` expects.
      return call<string>(`${acct}/cfd_tunnel/${id}/token`);
    },

    async putTunnelConfig(id, originUrl) {
      await call(`${acct}/cfd_tunnel/${id}/configurations`, {
        method: "PUT",
        body: JSON.stringify({ config: { ingress: [{ service: originUrl }] } }),
      });
    },

    async findDnsRecord(name) {
      const r = await call<{ id: string }[]>(
        `/zones/${args.zoneId}/dns_records?name=${encodeURIComponent(name)}`,
      );
      return r?.[0] ? { id: r[0].id } : null;
    },

    async createDnsRecord(name, content) {
      await call(`/zones/${args.zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({ type: "CNAME", name, content, proxied: true, ttl: 1 }),
      });
    },

    async deleteDnsRecord(id) {
      await call(`/zones/${args.zoneId}/dns_records/${id}`, { method: "DELETE" });
    },

    async deleteAccessApp(id) {
      await call(`${acct}/access/apps/${id}`, { method: "DELETE" });
    },

    async findAccessApp(domain) {
      const r = await call<{ id: string; domain: string; aud: string }[]>(`${acct}/access/apps`);
      const hit = (r ?? []).find((a) => a.domain === domain);
      return hit ? { id: hit.id, aud: hit.aud } : null;
    },

    async createAccessApp(a) {
      return call<{ id: string; aud: string }>(`${acct}/access/apps`, {
        method: "POST",
        body: JSON.stringify({
          name: a.name,
          domain: a.domain,
          type: "self_hosted",
          session_duration: a.sessionDuration,
        }),
      });
    },

    async createAccessPolicy(appId, emails) {
      // login_method is deliberately absent: omitting it allows every login
      // method enabled on the account, so email OTP works now and a Google IdP
      // added by hand later starts working with no reprovision. It also keeps
      // us off access/identity_providers, which this token cannot read (403).
      await call(`${acct}/access/apps/${appId}/policies`, {
        method: "POST",
        body: JSON.stringify({
          name: "bb tunnel allow",
          decision: "allow",
          include: emails.map((email) => ({ email: { email } })),
        }),
      });
    },
  };
}
