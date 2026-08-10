// Cloudflare Access JWT verification.
//
// The edge has already enforced the Access policy by the time a request
// reaches us, so this looks redundant — it is not. The router listens on
// loopback, and without this check any local process could bypass the entire
// authentication story by opening a socket to it and setting a Host header.
// Hence: every failure path returns { ok: false }. There is no configuration,
// no environment, and no error under which this returns ok for a request that
// did not carry a valid assertion.
//
// The signature check is injected so tests need no keys and no network; the
// JWKS-backed implementation lives in the router wiring.
export interface JwtClaims {
  aud: string[];
  exp: number;
  email?: string;
}

export interface VerifyArgs {
  token: string | undefined;
  /**
   * Every Access audience that may legitimately reach this router. There is
   * more than one because a Cloudflare wildcard app (`*.bb.example.com`, which
   * covers the share hosts) does NOT cover the apex (`bb.example.com`) — they are
   * two applications with two auds. Accepting only one would either lock you
   * out of bb or leave the share hosts unauthenticated.
   */
  audiences: readonly string[];
  now: number;
  verifySignature: (token: string) => Promise<JwtClaims | null>;
}

export type VerifyResult =
  | { ok: true; email: string }
  | { ok: false; reason: string };

export async function verifyAccessJwt(args: VerifyArgs): Promise<VerifyResult> {
  if (args.token === undefined || args.token.length === 0) {
    return { ok: false, reason: "missing Cf-Access-Jwt-Assertion" };
  }
  // No configured audience means provisioning never completed. Treating that
  // as "allow anything" would turn a misconfiguration into an open door.
  if (args.audiences.length === 0 || args.audiences.every((a) => a.length === 0)) {
    return { ok: false, reason: "no Access audience configured" };
  }

  let claims: JwtClaims | null;
  try {
    claims = await args.verifySignature(args.token);
  } catch {
    return { ok: false, reason: "signature verification failed" };
  }

  if (claims === null) return { ok: false, reason: "invalid signature" };
  const accepted = args.audiences.filter((a) => a.length > 0);
  if (!claims.aud.some((a) => accepted.includes(a))) {
    return { ok: false, reason: "audience mismatch" };
  }
  if (claims.exp * 1000 <= args.now) return { ok: false, reason: "expired" };
  return { ok: true, email: claims.email ?? "" };
}
