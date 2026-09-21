import type { SnapshotAgent, RunSnapshot } from "../state/snapshot.js";
import type { RunStatusView } from "../inspect/status.js";

/**
 * Human-readable projection of run events and status (pure: no I/O, no process access). One journal
 * event becomes one line; a status view becomes a short header block. Every string taken from the
 * journal is sanitized (control characters become spaces), so a line never carries an escape
 * sequence or a line break it did not add itself. Colors are SGR codes around whole fields, and the
 * colored text with the codes removed is exactly the plain text.
 */

export interface FormatOptions {
  color: boolean;
  /** IANA time zone for event times; local time when omitted. */
  timeZone?: string;
}

/** The fields of a run event the formatter reads; `type` is any string, so future types format too. */
export interface FormattableEvent {
  seq: number;
  ts: string;
  type: string;
  subject: { agentId?: string; stageId?: string; visit?: number; attempt?: number };
  data: unknown;
}

export interface HeaderInput {
  status: RunStatusView;
  agents: readonly SnapshotAgent[];
  outcome: RunSnapshot["outcome"];
}

const TYPE_WIDTH = 20;
const LABEL_WIDTH = 9;
const MESSAGE_CLIP = 160;
const UNKNOWN_CLIP = 200;

const SGR = {
  bold: "1",
  dim: "2",
  red: "31",
  green: "32",
  yellow: "33",
  cyan: "36",
} as const;
type Style = keyof typeof SGR;

/** Colors only on a terminal, and never when NO_COLOR is set to a non-empty value (no-color.org). */
export function colorEnabled(input: {
  isTTY: boolean | undefined;
  env: Record<string, string | undefined>;
}): boolean {
  const noColor = input.env["NO_COLOR"];
  return input.isTTY === true && (noColor === undefined || noColor === "");
}

export function formatEventLine(event: FormattableEvent, options: FormatOptions): string {
  const paint = painter(options.color);
  const type = text(event.type);
  const padding = " ".repeat(Math.max(1, TYPE_WIDTH - type.length + 1));
  const data = isObject(event.data) ? event.data : {};
  return [
    paint(timeOf(event.ts, options.timeZone), "dim"),
    " ",
    paint(`#${text(event.seq)}`, "dim"),
    " ",
    paint(type, typeStyle(event.type, data)),
    padding,
    subjectOf(event.subject),
    "  ",
    summaryOf(event.type, event.data),
  ].join("");
}

export function formatHeader(input: HeaderInput, options: FormatOptions): string[] {
  const paint = painter(options.color);
  const label = (name: string) => paint(name, "bold") + " ".repeat(LABEL_WIDTH - name.length);
  const { status } = input;
  const lines = [
    `${label("run")}${text(status.runId)}  ${workflowOf(status.workflow)}  ${text(status.status)}`,
    `${label("dir")}${text(status.runDir)}`,
    `${label("now")}${
      status.activeAttempts.length === 0
        ? "-"
        : status.activeAttempts
            .map(
              (active) =>
                `${text(active.stageId)} v${text(active.visit)} a${text(active.attempt)} (${text(active.agentId)})`,
            )
            .join(", ")
    }`,
    `${label("owner")}${ownerOf(status.liveness)}`,
  ];
  for (const agent of input.agents) {
    const pane = agent.assignment === null ? "" : ` pane ${text(agent.assignment.paneId)}`;
    lines.push(
      `${label("agent")}${text(agent.agentId)}  role ${orDash(agent.role)} kind ${orDash(agent.kind)} model ${orDash(agent.model)}${pane}`,
    );
  }
  if (input.outcome !== null) {
    const { outcome } = input;
    lines.push(
      `${label("outcome")}${paint(text(outcome.outcome), outcomeStyle(outcome.outcome))}: ${text(outcome.reason)}${
        outcome.limit === null ? "" : ` (limit ${text(outcome.limit)})`
      }`,
    );
  }
  return lines;
}

/** The line `woof status --pretty` adds for a host outcome (exit 8). */
export function formatHostOutcome(hostOutcome: unknown, options: FormatOptions): string {
  const paint = painter(options.color);
  const value = isObject(hostOutcome) ? hostOutcome : {};
  const reason = value["reason"] === undefined ? "" : ` ${text(value["reason"])}`;
  const message = value["message"] === undefined ? "" : `: ${clipped(value["message"])}`;
  return `${paint("host", "bold")}${" ".repeat(LABEL_WIDTH - 4)}${text(value["outcome"])}${reason}${message}`;
}

/** The human form of the end line `woof events` prints as JSON. */
export function formatEnd(cursor: string | null, reason: string, options: FormatOptions): string {
  const paint = painter(options.color);
  return paint(`-- end (${text(reason)}) cursor ${cursor === null ? "-" : text(cursor)}`, "dim");
}

/** The human form of a resync_required or error item. */
export function formatProblem(
  item: { type: string; reason: string; message: string },
  options: FormatOptions,
): string {
  const paint = painter(options.color);
  return paint(`!! ${text(item.type)} ${text(item.reason)}: ${text(item.message)}`, "red");
}

function summaryOf(type: string, raw: unknown): string {
  const data = isObject(raw) ? raw : {};
  try {
    switch (type) {
      case "run.opened": {
        const plan = data["plan"];
        const workflow = isObject(plan) ? plan["workflow"] : undefined;
        return `${text(data["runId"])} ${
          isObject(workflow)
            ? `${text(workflow["name"])}@${text(workflow["version"])}`
            : plan === undefined
              ? "plan-less"
              : "?"
        }`;
      }
      case "agent.assigned": {
        const runtime = isObject(data["runtime"]) ? data["runtime"] : {};
        return `runtime ${text(runtime["runtimeName"])} pane ${text(runtime["paneId"])}`;
      }
      case "attempt.opened":
        return `artifacts ${text(data["artifactDir"])}`;
      case "request.dispatched":
        return `delivery ${text(data["delivery"])} (${text(data["reason"])})`;
      case "submission.accepted":
        return `${text(data["status"])} verdict ${
          data["verdict"] === null ? "-" : text(data["verdict"])
        } receipt ${text(data["receiptId"])}`;
      case "submission.rejected":
        return `${text(data["reason"])}: ${clipped(data["message"])}`;
      case "submission.duplicate":
        return `duplicate of #${text(data["acceptedSeq"])} receipt ${text(data["receiptId"])}`;
      case "gate.recorded": {
        const next = isObject(data["next"]) ? data["next"] : {};
        const target = next["stageId"] !== undefined ? next["stageId"] : next["outcome"];
        return `${text(data["kind"])} ${text(data["gate"])} ${text(data["decision"])} (${text(data["reason"])}) round ${text(data["round"])} -> ${text(target)}`;
      }
      case "run.terminated":
        return `${text(data["outcome"])}: ${text(data["reason"])}${
          data["limit"] === undefined ? "" : ` (limit ${text(data["limit"])})`
        }`;
      case "run.blocked":
        return `${text(data["reason"])}: ${clipped(data["requiredAction"])}`;
      case "run.unblocked":
        return text(data["resolution"]);
      case "delivery.reconciled":
        return `${text(data["resolution"])} (${text(data["evidence"])}) dispatch #${text(data["dispatchSeq"])}`;
      case "host.claimed":
        return `pid ${text(data["pid"])} on ${text(data["hostname"])}${
          data["paneId"] === null ? "" : ` pane ${text(data["paneId"])}`
        } heartbeat ${text(data["heartbeatMs"])} ms`;
      case "host.exited":
        return `pid ${text(data["pid"])} exit ${text(data["exitCode"])} (${clipped(data["reason"])})`;
      case "host.lost":
        return `pid ${data["pid"] === null ? "-" : text(data["pid"])} ${clipped(data["reason"])}, last heartbeat ${
          data["heartbeatAt"] === null ? "-" : text(data["heartbeatAt"])
        } (found by ${text(data["detectedBy"])})`;
      case "run.cancel_requested":
        return `by ${text(data["source"])}: ${clipped(data["reason"])}`;
      case "observation.lost":
        return `${text(data["code"])}: ${clipped(data["message"])}`;
      case "observation.recovered":
        return `after loss #${text(data["lostSeq"])}`;
      default:
        return unknownSummary(raw);
    }
  } catch {
    return "?";
  }
}

function unknownSummary(data: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    return "?";
  }
  return json === undefined ? "?" : clip(sanitize(json), UNKNOWN_CLIP);
}

function typeStyle(type: string, data: Record<string, unknown>): Style | undefined {
  switch (type) {
    case "submission.accepted":
      return "green";
    case "submission.rejected":
      return "red";
    case "submission.duplicate":
    case "run.blocked":
    case "run.cancel_requested":
    case "observation.lost":
      return "yellow";
    case "host.lost":
      return "red";
    case "gate.recorded":
      return data["decision"] === "pass" ? "green" : "red";
    case "run.terminated":
      return outcomeStyle(data["outcome"]);
    case "delivery.reconciled":
      return data["resolution"] === "delivered" ? "cyan" : "yellow";
    case "agent.assigned":
    case "request.dispatched":
    case "attempt.opened":
      return "cyan";
    default:
      return undefined;
  }
}

function outcomeStyle(outcome: unknown): Style {
  return outcome === "completed" ? "green" : "red";
}

function subjectOf(subject: FormattableEvent["subject"]): string {
  const value: Record<string, unknown> = isObject(subject) ? subject : {};
  const parts: string[] = [];
  if (value["agentId"] !== undefined) parts.push(text(value["agentId"]));
  if (value["stageId"] !== undefined)
    parts.push(`${text(value["stageId"])} v${text(value["visit"])} a${text(value["attempt"])}`);
  return parts.length === 0 ? "-" : parts.join(" ");
}

function workflowOf(workflow: RunStatusView["workflow"]): string {
  return workflow === null ? "plan-less" : `${text(workflow.name)}@${text(workflow.version)}`;
}

function ownerOf(liveness: RunStatusView["liveness"]): string {
  const host = liveness.host;
  return [
    text(liveness.owner),
    host?.paneId === null || host?.paneId === undefined ? "" : ` pane ${text(host.paneId)}`,
    host?.pid === null || host?.pid === undefined ? "" : ` pid ${text(host.pid)}`,
    liveness.claimProblem === undefined ? "" : ` (${text(liveness.claimProblem)})`,
  ].join("");
}

const TIME_FORMATS = new Map<string, Intl.DateTimeFormat>();

function timeOf(ts: string, timeZone: string | undefined): string {
  const date = new Date(ts);
  if (typeof ts !== "string" || Number.isNaN(date.getTime())) return "??:??:??";
  const key = timeZone ?? "";
  let format = TIME_FORMATS.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      ...(timeZone !== undefined ? { timeZone } : {}),
    });
    TIME_FORMATS.set(key, format);
  }
  return format.format(date);
}

function painter(color: boolean): (value: string, style: Style | undefined) => string {
  return (value, style) =>
    color && style !== undefined ? `\u001B[${SGR[style]}m${value}\u001B[0m` : value;
}

/** A field as display text: strings sanitized, finite numbers and booleans as written, anything else `?`. */
function text(value: unknown): string {
  if (typeof value === "string") return sanitize(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "?";
}

function orDash(value: string | null): string {
  return value === null ? "-" : text(value);
}

function clipped(value: unknown): string {
  return clip(text(value), MESSAGE_CLIP);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// C0 and C1 control characters, DEL included: ESC, CR and LF among them.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

function sanitize(value: string): string {
  return value.replaceAll(CONTROL, " ");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
