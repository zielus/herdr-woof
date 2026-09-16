/** README image and badge references (preflight `links`). */

export type Visibility = "public" | "private" | "unknown";
export type LinkStatus = "pass" | "warn" | "fail";

/** Hosts that serve this repository's own content; a 404 there is expected while it is private. */
const REPOSITORY_PREFIXES = [
  "https://github.com/zielus/herdr-woof/",
  "https://raw.githubusercontent.com/zielus/herdr-woof/",
];

/** Every image reference in a README: `![](…)`, `<img src>` and each `<source srcset>` URL. */
export function readmeImageRefs(markdown: string): string[] {
  const refs: string[] = [];
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g))
    refs.push(match[1] as string);
  for (const match of markdown.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi))
    refs.push(match[1] as string);
  for (const match of markdown.matchAll(/<source\b[^>]*\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const candidate of (match[1] as string).split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url !== undefined && url !== "") refs.push(url);
    }
  }
  return refs;
}

/** Whether a reference is an absolute URL (as opposed to a repository-relative path). */
export function isAbsoluteRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//");
}

/**
 * The status of an absolute image URL given the HTTP status it answered with
 * (null: no response). 2xx/3xx pass. A failure on this repository's own GitHub
 * content warns while the repository is private or its visibility unknown,
 * and fails once it is public; anything else, and a malformed URL, fails.
 */
export function classifyLink(
  url: string,
  status: number | null,
  visibility: Visibility,
): LinkStatus {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "fail";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "fail";
  if (status !== null && status >= 200 && status < 400) return "pass";
  const ownContent = REPOSITORY_PREFIXES.some((prefix) => parsed.href.startsWith(prefix));
  return ownContent && visibility !== "public" ? "warn" : "fail";
}
