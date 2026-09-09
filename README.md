# bb-plugin-cf-tunnel

Reach your [bb](https://github.com/get-bb/bb) instance from anywhere over **your
own** Cloudflare Tunnel and Access policy — your account, your domain, no
third-party relay in the path.

Built as an alternative to bb connect for people who would rather not have
remote traffic to a machine that runs coding agents transit infrastructure they
don't control.

```
phone ──https──► Cloudflare edge (Access policy: your email)
                      ▼
                 cloudflared  (outbound only, supervised by the plugin)
                      ▼
            plugin host router :8790  (127.0.0.1)
                 ├─ bb.example.com        → your bb server
                 ├─ bb-p3000.example.com  → 127.0.0.1:3000  [if shared]
                 └─ anything else         → 404
```

## Why there is a router at all

`cloudflared` maps a hostname to a **static** service, so it can't turn
`bb-p3000.example.com` into `127.0.0.1:3000` on its own, and re-pushing tunnel
config on every share would be slow and rate-limited. The tunnel therefore
carries one catch-all ingress rule pointing at a small local router, which
resolves the `Host` header itself.

That also puts the shared-port allow-list in code you own — without it,
`bb-p22.example.com` would be your SSH daemon.

## Security model

**bb has no authentication of its own.** Anyone who reaches your bb origin can
spawn agents and run shell commands on that machine. Everything here follows
from that:

- **The router fails closed.** Every request must carry a valid
  `Cf-Access-Jwt-Assertion`, verified against your team's public keys —
  unconditionally, not "when we think Access is on". The router listens on
  loopback, so without this check any local process could bypass authentication
  by setting a `Host` header.
- **A missing Access application is an outage, not an exposure.** The router
  refuses every request without a valid token, so if the application disappears
  Cloudflare issues no tokens and every visit reads `forbidden`. The connector
  keeps serving; start-up and an hourly check log it once and `bb cf-tunnel
  status` shows `access: MISSING` with where to restore it.
- **Shared ports expire** (default 24h), and expiry is evaluated per request
  rather than by a sweeper, so a dead timer can't leave a port exposed.
- **The API token is a `secret: true` setting**, which bb stores in a 0600 file
  under `<dataDir>/plugins/<id>/secrets/` — never in `bb.db`, never sent to the
  frontend. The connector token goes to `cloudflared` via `TUNNEL_TOKEN`, not
  argv, so it isn't readable from the process table.

## Install

```sh
bb plugin install git:https://github.com/MGrin/bb-plugin-cf-tunnel@main
```

You need `cloudflared` on `PATH` (`brew install cloudflared`), a Cloudflare
account with a zone, and Cloudflare Zero Trust enabled (the free plan is fine —
up to 50 users).

## Configure

```sh
bb plugin config cf-tunnel set apiToken   <token>     # keep this out of your shell history
bb plugin config cf-tunnel set accountId  <account-id>
bb plugin config cf-tunnel set zoneId     <zone-id>
bb plugin config cf-tunnel set hostname   bb.example.com
bb plugin config cf-tunnel set teamDomain yourteam.cloudflareaccess.com
bb plugin config cf-tunnel set allowedEmails you@example.com
bb plugin reload cf-tunnel
bb cf-tunnel provision
```

Every setting above is also editable on the plugin's page in bb (Extensions → Plugins →
Cloudflare Tunnel), and each field's description there says where the value comes from.
The hostname is whatever second-level name you like in your zone — `bb.example.com`,
`agents.example.com` — and can be changed later with a reprovision.

### Create the API token

1. Open <https://dash.cloudflare.com/profile/api-tokens> (profile menu, top right →
   **My Profile** → **API Tokens**).
2. **Create Token** → scroll to **Custom token** → **Get started**.
3. Name it (e.g. `bb cf-tunnel on <machine>`).
4. **Permissions** — exactly these three rows, nothing else:

   | Scope | Item | Permission |
   |---|---|---|
   | Account | Cloudflare Tunnel | Edit |
   | Account | Access: Apps and Policies | Edit |
   | Zone | DNS | Edit |

5. **Account Resources** → *Include* → your account.
6. **Zone Resources** → *Include* → *Specific zone* → the zone your hostname lives in
   (not *All zones*).
7. **Client IP Address Filtering** — leave empty. `cloudflared` connects outbound from
   this machine, and the machine travels.
8. **TTL** — your call; the plugin re-verifies the token on every provision and tells
   you when it has expired.
9. **Continue to summary** → **Create Token**. Copy it now: Cloudflare shows it once.
10. Store it in your password manager, then `bb plugin config cf-tunnel set apiToken <token>`
    (or paste it on the plugin page). It lands in a 0600 file under
    `<dataDir>/plugins/cf-tunnel/secrets/`, never in `bb.db`.

Where the ids come from: **account id** — the dashboard URL after you pick the account
(`dash.cloudflare.com/<account id>`), or any zone's Overview page, right column, *API →
Account ID*; **zone id** — same Overview page, *API → Zone ID*; **team domain** — Zero
Trust dashboard → Settings → Custom Pages → *Team domain*.

**If your token is account-owned**, note that `GET /user/tokens/verify` reports
`Invalid API Token` for a perfectly valid token. The correct path — and the one
this plugin uses — is `GET /accounts/{account_id}/tokens/verify`.

Provisioning is idempotent: it adopts an existing tunnel or Access app of the
same name rather than duplicating, and saves state after each resource so a
half-failed run is safe to retry.

## Use

```sh
bb cf-tunnel status              # connector state, URL, shared ports with TTL
bb cf-tunnel share 3000          # prints https://bb-p3000.example.com
bb cf-tunnel share 3000 --ttl 2  # ...for two hours
bb cf-tunnel unshare 3000        # removes the DNS record and the Access app
bb cf-tunnel provision           # re-converge
```

There's a homepage panel too: connector state, the URL, and shared ports with
live countdowns and one-click unshare.

`share` prints only the URL on stdout, so agents can pipe it.

## Two things worth knowing before you deploy this

**Cloudflare Universal SSL is one level deep.** It covers `example.com` and
`*.example.com` and nothing further. That is why share hosts are
`bb-p3000.example.com` and not the tidier `p3000.bb.example.com` — the latter is
a third-level name with no certificate, and it fails the TLS handshake *before*
Access is ever consulted, which looks like a mysterious connection error rather
than an auth problem. Covering it properly needs Advanced Certificate Manager
(a paid add-on). Each share therefore gets its own DNS record and its own Access
application, created on share and deleted on unshare; a wildcard would have to be
`*.example.com`, which would swallow every other site in your zone.

**Cloudflare closes idle WebSockets.** Measured at **125.9s** (close code 1006)
through a tunnel. bb's own realtime socket usually carries enough traffic to
stay alive, but terminal sockets don't — so an idle terminal would die after
about two minutes. The router sends a WebSocket ping every 30s; browsers answer
pings automatically and never surface them to page JavaScript, so this is
invisible to bb's frontend.

## Login methods

Cloudflare Access has **no native passkey login**. Out of the box you get
one-time PINs by email, which this plugin configures end to end. For Face ID /
Touch ID, add Google or GitHub as an identity provider in the Zero Trust
dashboard — that's a one-time manual step, because creating an OAuth app needs
credentials no Cloudflare API can mint. The Access policy deliberately omits
`login_method`, so an IdP you add later starts working with no reprovision.

## Development

```sh
npm install
npm test          # 69 tests, no network and no Cloudflare account required
bb plugin build .
```

All logic lives under `lib/` with injected clocks, `fetch` and signature
verification, so the whole suite runs offline.

## Licence

MIT
