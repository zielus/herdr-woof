import { ApiError } from "@/lib/api";

/**
 * A failed read, said plainly. A 401 is its own state: the server started with
 * `--token` and this tab does not have it, which is a URL problem, not an empty
 * runs directory — showing an empty list there would be a lie.
 */
export function QueryFailure({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 401) {
    return (
      <section className="bg-surface border-border rounded-md border p-4 text-sm">
        <h2 className="font-medium">Token missing or wrong</h2>
        <p className="text-muted-foreground mt-2">
          This server was started with <span className="font-mono">--token</span>. Open the URL{" "}
          <span className="font-mono">woof ui</span> printed — it carries the token after the{" "}
          <span className="font-mono">#</span> — in this tab. The token is kept for the tab only, so
          a new window needs that URL again.
        </p>
        <p className="text-faint mt-2 font-mono text-xs">{error.reason}</p>
      </section>
    );
  }
  return (
    <p className="bg-fail-subtle text-fail rounded-md p-3 font-mono text-sm">
      {error instanceof ApiError ? `${error.reason}: ${error.message}` : String(error)}
    </p>
  );
}
