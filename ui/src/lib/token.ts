/**
 * The server's bearer token, when it started with one.
 *
 * `woof ui --token` prints its URL with the token in the **fragment**
 * (`http://host:port/#token=…`), which a browser never sends to a server: it
 * stays out of access logs, proxies and `Referer` headers, unlike a query
 * string. This module reads it once at startup, keeps it for the tab, and
 * removes it from the address bar so a copied URL carries no secret.
 *
 * It is sent as `Authorization: Bearer` on every fetch. `EventSource` cannot set
 * request headers, so the event stream — and only the event stream — appends it
 * as `?token=`.
 */

const KEY = "woof.token";

/** Used when sessionStorage throws, as it does in some privacy modes. */
let inMemory: string | null = null;

function stored(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * Reads `#token=` once, keeps it for this tab, and rewrites the address bar
 * without it. Called before the app renders, so the first fetch already has it.
 */
export function captureToken(): void {
  const hash = window.location.hash;
  if (!hash.startsWith("#")) return;
  const parameters = new URLSearchParams(hash.slice(1));
  const found = parameters.get("token");
  if (found === null || found === "") return;
  inMemory = found;
  try {
    sessionStorage.setItem(KEY, found);
  } catch {
    // The in-memory copy still serves this page load.
  }
  parameters.delete("token");
  const rest = parameters.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${rest === "" ? "" : `#${rest}`}`,
  );
}

/** The token for this tab, or null when the server started without one. */
export function token(): string | null {
  return inMemory ?? stored();
}

/** `?token=` for `EventSource`, which cannot carry an Authorization header. */
export function tokenQuery(): string {
  const secret = token();
  return secret === null ? "" : `?token=${encodeURIComponent(secret)}`;
}
