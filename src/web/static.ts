import { createReadStream, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

/**
 * Serves the built single-page app from `dist-ui/`. The bundle is a build
 * product of `bun run build:ui`, not of `bun run build`, so a checkout that has
 * only compiled the CLI has no `dist-ui/`: that is reported as a 503 naming the
 * command to run, never as an empty page.
 */

const TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export const MISSING_SPA_MESSAGE =
  "the web UI bundle is missing; build it with: bun run build:ui (from a checkout), or reinstall herdr-woof, which ships it";

/** What `serveSpa` did, so the caller can answer the two cases it cannot. */
export type SpaOutcome = "served" | "bundle_missing" | "not_found";

function fileAt(path: string): { path: string; bytes: number } | null {
  try {
    const stats = statSync(path);
    return stats.isFile() ? { path, bytes: stats.size } : null;
  } catch {
    return null;
  }
}

/**
 * The request path as a filesystem path, or null when it cannot be one. Decoding
 * happens here and only here: a path decoded twice, or classified before it is
 * decoded, is how `%2e` hides a file extension from a caller that decodes later.
 */
function decodePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return decoded.includes("\0") ? null : decoded;
}

/**
 * Resolves an already-decoded request path to a real file inside `root`, or null
 * when there is none. The path is never trusted: it is resolved, then
 * realpath'd, then checked to still be under the realpath'd root — so neither
 * `..`, an encoded separator, nor a symlink planted inside the bundle can leave
 * it. index.html goes through this too, or a symlinked index would be the one
 * file that escapes.
 */
function fileWithin(root: string, decoded: string): string | null {
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(resolve(join(root, decoded)));
    // The root is realpath'd on every request too: on macOS `/var` is a symlink
    // to `/private/var`, so comparing a real path against a merely resolved root
    // would reject every path under a temporary directory.
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return real === realRoot || real.startsWith(prefix) ? real : null;
}

/**
 * The bundle's entry point, or null when there is no bundle to serve. An index
 * that is absent and one that resolves outside the bundle are the same answer:
 * the containment check is not something the entry point gets to skip. The
 * server reports its `spa` flag from this, so the flag and what a request
 * actually gets cannot disagree.
 */
export function bundleIndex(distUiDir: string): { path: string; bytes: number } | null {
  const within = fileWithin(distUiDir, "/index.html");
  return within === null ? null : fileAt(within);
}

/**
 * Writes the SPA asset for `pathname`. A path with no file extension falls back
 * to index.html so client-side routes such as /runs/<id> load on a refresh; a
 * missing path that names a file — a stale hashed asset after a rebuild — is
 * reported as not found, because answering it with HTML surfaces in the browser
 * as a MIME error instead of a 404.
 *
 * The extension is read from the decoded path, the same value the file lookup
 * uses: classifying the encoded one lets `/assets/missing%2ejs` look
 * extensionless and take the fallback while `/assets/missing.js` is a 404.
 */
export function serveSpa(
  response: ServerResponse,
  distUiDir: string,
  pathname: string,
): SpaOutcome {
  const decoded = decodePath(pathname);
  // A path that is not decodable is not a client-side route either.
  if (decoded === null) return "not_found";

  const index = bundleIndex(distUiDir);
  if (index === null) return "bundle_missing";

  const requested = fileWithin(distUiDir, decoded);
  const asset = requested === null ? null : fileAt(requested);
  if (asset === null && extname(decoded) !== "") return "not_found";
  const file = asset ?? index;
  const type = TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream";
  response.writeHead(200, {
    "content-type": type,
    "content-length": String(file.bytes),
    // Hashed assets are immutable; index.html must never be cached, or a rebuilt
    // bundle keeps serving the previous entry point. Vite names a hashed asset
    // `<name>-<hash>.<ext>`.
    "cache-control":
      asset === null || !/-[0-9A-Za-z_-]{8,}\.[0-9a-z]+$/.test(file.path)
        ? "no-store"
        : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  createReadStream(file.path).pipe(response);
  return "served";
}
