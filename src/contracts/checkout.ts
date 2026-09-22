import { isAbsolute } from "node:path";

import { isPlainObject, type RejectionDetail } from "./envelope.js";

/**
 * The checkout policy of a run (docs/design/composition.md): where the run's
 * agents, checks and fingerprints work. It is data in the run input — the
 * reserved top-level key `checkout` of every workflow input — so a wrapping
 * workflow or script sets it like any other field. The engine peels it off
 * before the definition's own `validateInput` sees the input, resolves it once
 * at the top, and records the result on `run.opened.checkout`; a nested run
 * inherits its parent's checkout.
 */

/** The reserved top-level input key. */
export const CHECKOUT_KEY = "checkout";

export type CheckoutMode = "current" | "worktree" | "path";

export type CheckoutSpec =
  | { mode: "current" }
  | { mode: "worktree"; branch?: string; base?: string; label?: string; keep?: boolean }
  | { mode: "path"; path: string };

/** What a definition's agents may do to the tree: `writable` refuses a dirty `current` or `path` tree. */
export type CheckoutAccess = "any" | "writable";

/** The checkout a run works in, as `run.opened.checkout` records it. */
export interface ResolvedCheckout {
  mode: CheckoutMode;
  /** Absolute top level of the git work tree the run works in. */
  path: string;
  /** Absolute repository the definition named (`repository(input)`). */
  source: string;
  /** The worktree's branch; null for `current` and `path`. */
  branch: string | null;
  /** The base ref a worktree was created from, when the caller named one. */
  base: string | null;
  /** The Herdr workspace of a created worktree; null otherwise. */
  workspaceId: string | null;
  /** True only for a worktree this run created. */
  created: boolean;
  /** Whether a created worktree is kept after a completed run (always true otherwise). */
  keep: boolean;
  /** True for a nested run working in its parent's checkout. */
  inherited: boolean;
}

const MODES: ReadonlySet<string> = new Set(["current", "worktree", "path"]);
const MAX_REF = 200;
const MAX_LABEL = 100;
/** A conservative git branch name: no leading dash or dot, no `..`, `@{`, control or special characters. */
const BRANCH_PATTERN = /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]+(?<![./])$/;
/** A ref or revision expression for `--base` (`main`, `origin/main`, `HEAD~1`, a sha). */
const BASE_PATTERN = /^(?!-)[A-Za-z0-9._/@^~-]+$/;

function isBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_REF &&
    BRANCH_PATTERN.test(value) &&
    !value.endsWith(".lock")
  );
}

function isLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= MAX_LABEL &&
    // oxlint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** Problems of a caller's `checkout` value, one detail per field; empty when it is valid. */
export function checkoutSpecProblems(value: unknown, field = CHECKOUT_KEY): RejectionDetail[] {
  const details: RejectionDetail[] = [];
  const fail = (path: string, message: string) => details.push({ field: path, message });
  if (!isPlainObject(value)) {
    fail(field, 'must be an object with mode "current", "worktree" or "path"');
    return details;
  }
  const mode = value["mode"];
  if (typeof mode !== "string" || !MODES.has(mode)) {
    fail(`${field}.mode`, 'must be "current", "worktree" or "path"');
    return details;
  }
  const allowed =
    mode === "worktree"
      ? ["mode", "branch", "base", "label", "keep"]
      : mode === "path"
        ? ["mode", "path"]
        : ["mode"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field}.${key}`, `unknown field for mode ${mode}`);
  }
  if (mode === "worktree") {
    if (value["branch"] !== undefined && !isBranch(value["branch"]))
      fail(`${field}.branch`, `must be a git branch name of at most ${MAX_REF} characters`);
    if (
      value["base"] !== undefined &&
      !(
        typeof value["base"] === "string" &&
        value["base"].length <= MAX_REF &&
        BASE_PATTERN.test(value["base"])
      )
    )
      fail(`${field}.base`, `must be a git ref of at most ${MAX_REF} characters`);
    if (value["label"] !== undefined && !isLabel(value["label"]))
      fail(`${field}.label`, `must be a non-empty single-line string of at most ${MAX_LABEL}`);
    if (value["keep"] !== undefined && typeof value["keep"] !== "boolean")
      fail(`${field}.keep`, "must be a boolean");
  }
  if (mode === "path") {
    const path = value["path"];
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
      fail(`${field}.path`, "must be an absolute path");
  }
  return details;
}

export type PeeledInput =
  | { ok: true; input: unknown; spec: CheckoutSpec | undefined }
  | { ok: false; details: RejectionDetail[] };

/**
 * Splits the reserved `checkout` key off a caller's raw input. The rest is what
 * the definition validates and what `input.json` records; the spec is validated
 * here, once, for every workflow. A non-object input is passed through unchanged
 * for the definition to refuse.
 */
export function peelCheckout(raw: unknown): PeeledInput {
  if (!isPlainObject(raw) || !Object.hasOwn(raw, CHECKOUT_KEY)) {
    return { ok: true, input: raw, spec: undefined };
  }
  const { [CHECKOUT_KEY]: spec, ...rest } = raw;
  const details = checkoutSpecProblems(spec);
  if (details.length > 0) return { ok: false, details };
  return { ok: true, input: rest, spec: structuredClone(spec) as CheckoutSpec };
}

/** Why a `run.opened.checkout` value is not a resolved checkout; undefined when it is. */
export function resolvedCheckoutProblem(value: unknown, field = "checkout"): string | undefined {
  if (!isPlainObject(value)) return `${field} is not an object`;
  const keys = [
    "mode",
    "path",
    "source",
    "branch",
    "base",
    "workspaceId",
    "created",
    "keep",
    "inherited",
  ];
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return `unexpected field ${field}.${key}`;
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return `missing field ${field}.${key}`;
  }
  if (typeof value["mode"] !== "string" || !MODES.has(value["mode"]))
    return `${field}.mode is not current, worktree or path`;
  for (const key of ["path", "source"]) {
    const path = value[key];
    if (typeof path !== "string" || !isAbsolute(path)) return `${field}.${key} is not absolute`;
  }
  for (const key of ["branch", "base", "workspaceId"]) {
    const item = value[key];
    if (item !== null && (typeof item !== "string" || item === ""))
      return `${field}.${key} is not a non-empty string or null`;
  }
  for (const key of ["created", "keep", "inherited"]) {
    if (typeof value[key] !== "boolean") return `${field}.${key} is not a boolean`;
  }
  if (value["created"] === true && value["mode"] !== "worktree")
    return `${field}.created is only true for mode worktree`;
  return undefined;
}
