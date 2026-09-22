import type { ResolvedCheckout } from "../contracts/checkout.js";
import { execHerdr } from "../runtime/herdr/exec.js";
import { parseHerdrOutput, parseWorktreeCreated } from "../runtime/herdr/parse.js";
import type { AdmissionCheckout, CreatedWorktree } from "../scheduler/admission.js";

/**
 * Herdr worktrees for a run's checkout (docs/design/composition.md). Herdr owns worktrees:
 * Woof asks `herdr worktree create` for one, never runs `git worktree add` itself, and never
 * passes `--trust-repository`. A worktree a run created is removed only when the run asked
 * for it (`keep: false`) and completed; the branch always stays.
 */

const WORKTREE_TIMEOUT_MS = 60_000;

export interface HerdrAccess {
  bin: string;
  env: NodeJS.ProcessEnv;
}

/** A created worktree with the workspace root pane its host may run in. */
export type HerdrWorktree = Extract<CreatedWorktree, { ok: true }> & {
  rootPaneId: string;
  tabId: string;
};

/**
 * Whether a top-level run defaults to a new worktree: inside Herdr (`HERDR_ENV=1`) with the
 * Herdr runtime. A test runtime module, or no Herdr, works in the current tree.
 */
export function defaultCheckoutMode(
  env: NodeJS.ProcessEnv,
  runtimeModule: string | undefined,
): "current" | "worktree" {
  return env["HERDR_ENV"] === "1" && runtimeModule === undefined ? "worktree" : "current";
}

/** `herdr worktree create --cwd <source> --branch <b> [--base <ref>] --label <l> --no-focus`. */
export async function createHerdrWorktree(
  herdr: HerdrAccess,
  request: { source: string; branch: string; base: string | null; label: string },
): Promise<HerdrWorktree | Extract<CreatedWorktree, { ok: false }>> {
  const args = [
    "worktree",
    "create",
    "--cwd",
    request.source,
    "--branch",
    request.branch,
    ...(request.base !== null ? ["--base", request.base] : []),
    "--label",
    request.label,
    "--no-focus",
  ];
  const exec = await execHerdr(args, {
    bin: herdr.bin,
    env: herdr.env,
    timeoutMs: WORKTREE_TIMEOUT_MS,
    graceMs: 2000,
  });
  const outcome = parseHerdrOutput(args, exec);
  if (!outcome.ok) {
    return {
      ok: false,
      reason: "checkout_failed",
      message: `herdr worktree create failed: ${outcome.error.code}: ${outcome.error.message}`,
    };
  }
  const created = parseWorktreeCreated(outcome.result);
  if (!created.ok) {
    // Herdr made something it did not describe well enough to use: remove what it named.
    const cleanup =
      created.workspaceId === undefined
        ? ""
        : `; ${(await removeHerdrWorktree(herdr, created.workspaceId)).message}`;
    return {
      ok: false,
      reason: "checkout_failed",
      message: `herdr worktree create failed: ${created.message}${cleanup}`,
    };
  }
  return {
    ok: true,
    path: created.path,
    branch: created.branch,
    base: request.base,
    workspaceId: created.workspaceId,
    rootPaneId: created.rootPaneId,
    tabId: created.tabId,
  };
}

/** `herdr worktree remove --workspace <id> --force`: the checkout and its workspace; the branch stays. */
export async function removeHerdrWorktree(
  herdr: HerdrAccess,
  workspaceId: string,
): Promise<{ ok: boolean; message: string }> {
  const args = ["worktree", "remove", "--workspace", workspaceId, "--force"];
  const exec = await execHerdr(args, {
    bin: herdr.bin,
    env: herdr.env,
    timeoutMs: WORKTREE_TIMEOUT_MS,
    graceMs: 2000,
  });
  const outcome = parseHerdrOutput(args, exec);
  return outcome.ok
    ? { ok: true, message: `the worktree of workspace ${workspaceId} was removed` }
    : {
        ok: false,
        message: `the worktree of workspace ${workspaceId} could not be removed (${outcome.error.code}: ${outcome.error.message})`,
      };
}

/**
 * The admission checkout options of a top-level run: Herdr worktrees when Herdr is reachable
 * (`herdr` non-null), the default mode, and the default branch and label. `created` receives the
 * worktree this admission made, so the caller can run the host in its root pane or remove it.
 */
export function topLevelCheckout(options: {
  herdr: HerdrAccess | null;
  defaultMode: "current" | "worktree";
  runId: string;
  workflow: string;
  created?: (worktree: HerdrWorktree) => void;
}): AdmissionCheckout {
  const herdr = options.herdr;
  return {
    defaultMode: options.defaultMode,
    // Woof's own project configuration is not the operator's work in progress.
    cleanPrefixes: [".woof/"],
    names: { branch: `woof/${options.runId}`, label: `woof:${options.workflow}` },
    ...(herdr === null
      ? {}
      : {
          createWorktree: async (request) => {
            const made = await createHerdrWorktree(herdr, request);
            if (made.ok) options.created?.(made);
            return made;
          },
        }),
  };
}

/** Removes a worktree this run created (best effort), naming what happened. */
export async function discardCreatedCheckout(
  herdr: HerdrAccess | null,
  checkout: ResolvedCheckout | undefined,
): Promise<string | undefined> {
  if (checkout === undefined || !checkout.created || checkout.workspaceId === null)
    return undefined;
  if (herdr === null) return `the created worktree ${checkout.path} was left in place`;
  return (await removeHerdrWorktree(herdr, checkout.workspaceId)).message;
}
