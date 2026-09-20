import type { IncomingMessage } from "node:http";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

// The admission rules of `woof ui`, as a table. Every row here is a request a
// browser or an attacker's page can actually make; the real-process tests in
// test/web-server.process.test.ts prove the server wires these in.

interface Admission {
  ok: boolean;
  status?: number;
  reason?: string;
}

interface Policy {
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  token: string | null;
}

interface Security {
  admit(
    request: IncomingMessage,
    url: URL,
    policy: Policy,
    kind: { api: boolean; mutating: boolean },
  ): Admission;
  parseAuthority(value: string): { host: string; origin: string } | null;
  parseOrigin(value: string): string | null;
  isLoopback(host: string): boolean;
  MIN_TOKEN_LENGTH: number;
}

let security: Security;

beforeAll(async () => {
  security = await loadDist<Security>("web/security.js");
});

const HOSTS = ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "woof.example"] as const;

function policy(over: Partial<Policy> = {}): Policy {
  return { allowedHosts: HOSTS, allowedOrigins: [], token: null, ...over };
}

/** The parts of an IncomingMessage `admit` reads. */
function req(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function admit(
  headers: Record<string, string | undefined>,
  options: { policy?: Policy; api?: boolean; mutating?: boolean; target?: string } = {},
): Admission {
  return security.admit(
    req(headers),
    new URL(options.target ?? "/api/runs", "http://placeholder.invalid"),
    options.policy ?? policy(),
    { api: options.api ?? true, mutating: options.mutating ?? false },
  );
}

describe("woof ui admission: Host", () => {
  const rows: Array<[string | undefined, boolean, string]> = [
    ["localhost", true, "the plain loopback name"],
    ["LOCALHOST", true, "compared lower-case"],
    ["localhost:4317", true, "a port is allowed and ignored"],
    ["127.0.0.1", true, "the loopback literal"],
    ["[::1]:4317", true, "bracketed IPv6 loopback"],
    ["[0:0:0:0:0:0:0:1]", true, "the long IPv6 loopback form"],
    ["woof.example", true, "a name added with --allow-host"],
    ["attacker.example", false, "DNS rebinding: the port is reachable, the name is not ours"],
    ["localhost.", false, "a trailing dot resolves the same and is refused"],
    ["localhost.evil.example", false, "a suffix of an allowed name is not an allowed name"],
    ["evil.localhost", false, "nor a prefix"],
    ["127.0.0.1:abc", false, "junk where the port belongs is a parse failure, not a port"],
    ["localhost:4317:evil", false, "and so is a second colon"],
    ["[::1].", false, "nothing may follow the brackets"],
    ["::1", false, "an unbracketed IPv6 authority is not parseable"],
    ["localhost ", true, "surrounding whitespace is trimmed"],
    ["", false, "an empty Host"],
    [undefined, false, "no Host header at all"],
  ];
  it.each(rows)("Host %j is %s (%s)", (host, allowed) => {
    const result = admit(host === undefined ? {} : { host });
    expect(result.ok).toBe(allowed);
    if (!allowed) {
      expect(result.status === 400 || result.status === 403).toBe(true);
      expect(["host_invalid", "host_not_allowed"]).toContain(result.reason);
    }
  });

  it("a parseable host that is not allowed is 403; an unparseable one is 400", () => {
    expect(admit({ host: "attacker.example" })).toMatchObject({
      status: 403,
      reason: "host_not_allowed",
    });
    expect(admit({ host: "127.0.0.1:abc" })).toMatchObject({
      status: 400,
      reason: "host_invalid",
    });
  });
});

describe("woof ui admission: Origin on a mutating request", () => {
  const host = "127.0.0.1:4401";
  const rows: Array<[string | undefined, boolean, string]> = [
    ["http://127.0.0.1:4401", true, "the request's own origin"],
    ["http://127.0.0.1:4401/", true, "with the trailing slash some clients add"],
    ["HTTP://127.0.0.1:4401", true, "case-insensitive scheme and host"],
    [undefined, false, "a missing Origin is refused, not treated as same-origin"],
    ["null", false, "Origin: null (a sandboxed frame or a redirect) is refused"],
    ["", false, "an empty Origin"],
    ["http://127.0.0.1:9999", false, "another port on this machine is another origin"],
    ["http://localhost:5173", false, "the Vite dev server is not admitted by default"],
    ["https://127.0.0.1:4401", false, "another scheme is another origin"],
    ["http://127.0.0.1", false, "the same host on the default port is another origin"],
    ["https://attacker.example", false, "a cross-site page"],
    ["http://evil.example@127.0.0.1:4401", false, "userinfo is not reduced to its host"],
    ["http://127.0.0.1:4401/evil", false, "an origin has no path"],
    ["http://127.0.0.1:4401, http://evil.example", false, "nor is it a list"],
    ["127.0.0.1:4401", false, "a scheme is required"],
    ["file://", false, "a local file"],
    ["chrome-extension://abcdefghijklmnop", false, "an extension page"],
  ];
  it.each(rows)("Origin %j is %s (%s)", (origin, allowed) => {
    const result = admit({ host, ...(origin === undefined ? {} : { origin }) }, { mutating: true });
    expect(result.ok).toBe(allowed);
    if (!allowed) expect(result).toMatchObject({ status: 403, reason: "origin_not_allowed" });
  });

  it("--allow-origin admits exactly the origins it names", () => {
    const dev = policy({ allowedOrigins: ["http://127.0.0.1:5173"] });
    expect(
      admit({ host, origin: "http://127.0.0.1:5173" }, { mutating: true, policy: dev }).ok,
    ).toBe(true);
    // A neighbouring port, and the same port over TLS, are still other origins.
    expect(
      admit({ host, origin: "http://127.0.0.1:5174" }, { mutating: true, policy: dev }).ok,
    ).toBe(false);
    expect(
      admit({ host, origin: "https://127.0.0.1:5173" }, { mutating: true, policy: dev }).ok,
    ).toBe(false);
    // The server's own origin keeps working alongside it.
    expect(
      admit({ host, origin: "http://127.0.0.1:4401" }, { mutating: true, policy: dev }).ok,
    ).toBe(true);
  });

  it("the Host the Origin is compared against is the allowlisted one, normalised", () => {
    // A browser writes `[::1]`; the long form only ever arrives in a Host header.
    expect(
      admit({ host: "[0:0:0:0:0:0:0:1]:4401", origin: "http://[::1]:4401" }, { mutating: true }).ok,
    ).toBe(true);
  });

  it("a read carries no Origin requirement, but a foreign one is still refused", () => {
    expect(admit({ host }).ok).toBe(true);
    // A cross-site page can read nothing anyway (no CORS header is ever sent),
    // but refusing is cheaper than relying on that.
    expect(admit({ host, origin: "https://attacker.example" })).toMatchObject({
      status: 403,
      reason: "origin_not_allowed",
    });
    // `Origin: null` on a read is not a cross-site claim; it is the absence of one.
    expect(admit({ host, origin: "null" }).ok).toBe(true);
  });
});

describe("woof ui admission: token", () => {
  const host = "127.0.0.1:4401";
  // Long enough for MIN_TOKEN_LENGTH and deliberately not shaped like a key:
  // a high-entropy literal here trips the release preflight's secret scan.
  const token = "woof-ui-test-token-not-a-secret";
  const guarded = policy({ token });

  it("guards the API and not the bundle", () => {
    // The bundle is public build output: a <script src> subresource carries
    // neither a query token nor an Authorization header.
    expect(admit({ host }, { api: false, policy: guarded }).ok).toBe(true);
    expect(admit({ host }, { api: true, policy: guarded })).toMatchObject({
      status: 401,
      reason: "token_invalid",
    });
  });

  const rows: Array<[Record<string, string>, string, boolean, string]> = [
    [{}, `/api/runs?token=${token}`, true, "as a query parameter, which EventSource needs"],
    [{ authorization: `Bearer ${token}` }, "/api/runs", true, "as a bearer header"],
    [{ authorization: `bearer ${token}` }, "/api/runs", true, "the scheme is case-insensitive"],
    [{}, "/api/runs", false, "no token at all"],
    [{}, "/api/runs?token=", false, "an empty token"],
    [{}, `/api/runs?token=${token}x`, false, "a longer token"],
    [{}, `/api/runs?token=${token.slice(0, -1)}`, false, "a prefix of the token"],
    // Same length, wrong bytes: this is the comparison that reaches
    // timingSafeEqual rather than failing the length check in front of it.
    [{}, `/api/runs?token=${token.slice(0, -1)}0`, false, "a same-length wrong token"],
    [{}, `/api/runs?token=${token.toUpperCase()}`, false, "the same token in another case"],
    [{ authorization: `Bearer ${token}` }, `/api/runs?token=wrong`, true, "the header wins"],
    [{ authorization: "Bearer nope" }, `/api/runs?token=${token}`, false, "and it wins when wrong"],
    [
      { authorization: "Basic abc" },
      `/api/runs?token=${token}`,
      true,
      "a non-bearer scheme falls through to the query",
    ],
  ];
  it.each(rows)("%j %s is %s (%s)", (headers, target, allowed) => {
    expect(admit({ host, ...headers }, { policy: guarded, target }).ok).toBe(allowed);
  });

  it("is checked after the Host and the Origin, so it never buys past either", () => {
    expect(
      admit({ host: "attacker.example", authorization: `Bearer ${token}` }, { policy: guarded }),
    ).toMatchObject({ status: 403, reason: "host_not_allowed" });
    expect(
      admit({ host, authorization: `Bearer ${token}` }, { policy: guarded, mutating: true }),
    ).toMatchObject({ status: 403, reason: "origin_not_allowed" });
  });
});

describe("woof ui admission: the parsers on their own", () => {
  it("parseAuthority normalises what it accepts and refuses the rest", () => {
    expect(security.parseAuthority("LocalHost:4317")).toEqual({
      host: "localhost",
      origin: "http://localhost:4317",
    });
    expect(security.parseAuthority("[0:0:0:0:0:0:0:1]:4401")).toEqual({
      host: "0:0:0:0:0:0:0:1",
      origin: "http://[::1]:4401",
    });
    // Port 0 and a port past 65535 are not authorities a browser can produce.
    expect(security.parseAuthority("localhost:99999")).toBeNull();
    expect(security.parseAuthority("localhost.")).toBeNull();
    expect(security.parseAuthority("local host")).toBeNull();
  });

  it("parseOrigin accepts a scheme and an authority, and nothing else", () => {
    expect(security.parseOrigin("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
    expect(security.parseOrigin("https://woof.example")).toBe("https://woof.example");
    expect(security.parseOrigin("http://user:pass@127.0.0.1")).toBeNull();
    expect(security.parseOrigin("http://127.0.0.1/path")).toBeNull();
    expect(security.parseOrigin("null")).toBeNull();
    expect(security.parseOrigin("")).toBeNull();
  });

  it("names the loopback bind addresses that make a token optional", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "LOCALHOST"]) {
      expect(security.isLoopback(host), host).toBe(true);
    }
    for (const host of ["0.0.0.0", "192.168.1.10", "woof.example", "::"]) {
      expect(security.isLoopback(host), host).toBe(false);
    }
  });

  it("names a minimum token length the server refuses to start below", () => {
    expect(security.MIN_TOKEN_LENGTH).toBe(16);
  });
});
