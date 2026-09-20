import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Request admission for the local control surface (p9 Web UI base).
 *
 * Binding to loopback is not by itself a defence: Vite's CVE-2025-24010 showed
 * that a page in the operator's own browser reaches a loopback server through
 * DNS rebinding when the Host header is not validated. So every request must
 * name an allowed host, every mutating request must come from this server's own
 * origin, and a server bound beyond loopback must also carry a token.
 *
 * The token guards `/api/*` only. The built bundle is public build output that
 * carries no run data, and a `<script src>` subresource inherits neither a query
 * string nor an Authorization header: gating it would load the page and nothing
 * else. On the API the token is accepted as a bearer header and as `?token=`,
 * because `EventSource` cannot set request headers and a header-only token would
 * make the event stream unreachable in exactly the mode the token exists for.
 */

export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"] as const;

/** Shortest token this server will start with. */
export const MIN_TOKEN_LENGTH = 16;

const AUTHORITY = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/;

export interface SecurityPolicy {
  /** Host names (no port) a request may name. Compared lower-case. */
  allowedHosts: readonly string[];
  /** Extra origins admitted on top of the request's own, e.g. the Vite dev server. */
  allowedOrigins: readonly string[];
  /** Required on /api/* when set; no token is required for a loopback-only server. */
  token: string | null;
}

/** What the route already knows about the request, and what admission turns on. */
export interface RequestKind {
  /** True for `/api/*`: the routes the token guards. */
  api: boolean;
  /** True for the methods that can write. */
  mutating: boolean;
}

export type Admission =
  { ok: true } | { ok: false; status: number; reason: string; message: string };

export interface Authority {
  /** Host name with no port and no brackets, lower-cased. */
  host: string;
  /** The `http://` origin this authority names, normalised by WHATWG URL. */
  origin: string;
}

/**
 * Parses an authority such as `127.0.0.1:4317`, `[::1]:4317` or `woof.example`.
 * Strict by design: anything the pattern does not describe exactly — a trailing
 * dot, junk after the port, a second colon — is a parse failure, not a host
 * whose prefix happens to be allowed.
 */
export function parseAuthority(value: string): Authority | null {
  const lowered = value.trim().toLowerCase();
  if (!AUTHORITY.test(lowered)) return null;
  const host = lowered.startsWith("[")
    ? lowered.slice(1, lowered.indexOf("]"))
    : (lowered.split(":")[0] as string);
  if (host === "" || host.endsWith(".")) return null;
  let origin: string;
  try {
    origin = new URL(`http://${lowered}`).origin;
  } catch {
    return null;
  }
  return origin === "null" ? null : { host, origin };
}

/**
 * The origin an `Origin` header names, normalised the way a browser writes it.
 * Anything carrying more than a scheme and an authority — userinfo above all —
 * is refused rather than reduced to its host.
 */
export function parseOrigin(value: string): string | null {
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.origin === "null") return null;
  // `new URL("http://evil.example@localhost").host` is `localhost`: userinfo is
  // refused rather than silently reduced to the host behind it.
  if (url.username !== "" || url.password !== "") return null;
  // A browser writes exactly `scheme://host[:port]`. Anything with a path, a
  // query, a fragment or a list of origins is not an origin and is not admitted
  // as one, whatever `URL` would reduce it to.
  const lowered = text.toLowerCase();
  if (lowered !== url.origin && lowered !== `${url.origin}/`) return null;
  return url.origin;
}

function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(request: IncomingMessage, url: URL): string | null {
  const header = request.headers.authorization;
  if (header !== undefined && header.toLowerCase().startsWith("bearer ")) {
    return header.slice("bearer ".length).trim();
  }
  return url.searchParams.get("token");
}

/**
 * Admits a request, or names why it was refused. `url` is the parsed request
 * target; `kind` says which gates apply.
 */
export function admit(
  request: IncomingMessage,
  url: URL,
  policy: SecurityPolicy,
  kind: RequestKind,
): Admission {
  const allowed = policy.allowedHosts.map((host) => host.toLowerCase());
  const raw = request.headers.host;
  const authority = raw === undefined ? null : parseAuthority(raw);
  if (authority === null) {
    return {
      ok: false,
      status: 400,
      reason: "host_invalid",
      message: `the Host header ${JSON.stringify(raw ?? "")} is not a host name with an optional port`,
    };
  }
  if (!allowed.includes(authority.host)) {
    return {
      ok: false,
      status: 403,
      reason: "host_not_allowed",
      message: `the Host header ${JSON.stringify(raw)} is not one of ${allowed.join(", ")}`,
    };
  }

  // A cross-site page can reach this server through the operator's browser; a
  // same-origin request always carries an Origin naming this very server, so
  // comparing the whole origin — scheme, host and port — is the CSRF defence
  // for a server with no accounts and no cookies. Another port on the same
  // machine is a different origin and is admitted only by --allow-origin.
  const admissible = (origin: string): boolean =>
    origin === authority.origin || policy.allowedOrigins.includes(origin);
  const header = request.headers.origin;
  const origin = header === undefined || header === "null" ? null : parseOrigin(header);
  if (kind.mutating) {
    if (origin === null || !admissible(origin)) {
      return {
        ok: false,
        status: 403,
        reason: "origin_not_allowed",
        message: `a mutating request must carry an Origin of ${[authority.origin, ...policy.allowedOrigins].join(" or ")}; it carried ${JSON.stringify(header ?? "")}`,
      };
    }
  } else if (header !== undefined && header !== "null") {
    if (origin === null || !admissible(origin)) {
      return {
        ok: false,
        status: 403,
        reason: "origin_not_allowed",
        message: `the Origin header ${JSON.stringify(header)} is not ${[authority.origin, ...policy.allowedOrigins].join(" or ")}`,
      };
    }
  }

  if (policy.token !== null && kind.api) {
    const given = presentedToken(request, url);
    if (given === null || !tokenMatches(policy.token, given)) {
      return {
        ok: false,
        status: 401,
        reason: "token_invalid",
        message:
          "this server requires the token it printed at startup on every /api/ request, as an Authorization: Bearer header or, for the event stream, ?token=",
      };
    }
  }
  return { ok: true };
}

/** Whether a bind address is loopback-only, which is what makes a token optional. */
export function isLoopback(host: string): boolean {
  return (LOOPBACK_HOSTS as readonly string[]).includes(host.toLowerCase());
}
