/**
 * Public SDK entry point.
 *
 * Keeping this module free of CLI and plugin imports preserves the package
 * boundary. The package's ESM metadata makes this compiled file importable as
 * a module. Test doubles live in `herdr-woof/testing`, not here.
 *
 * Everything below is a p2 contract, unstable until v1: the p1 result handoff
 * (`openAttempt`, `submitResult`, `readJournal`), run plans and domain types,
 * the state store, snapshots, events and the runtime adapter contract. There
 * is no scheduler: nothing here chooses a next stage, evaluates a verdict,
 * resends a prompt or turns a runtime observation into a journal record.
 * `woof attempt open`, `woof submit` and `woof run show` call the same
 * functions.
 */
export const SDK_FOUNDATION = true;

export { REJECTION_REASONS } from "./contracts/reasons.js";
export type {
  AttemptOpenReason,
  InfraReason,
  RejectionReason,
  StoreReason,
} from "./contracts/reasons.js";
export type {
  AttemptIdentity,
  Envelope,
  Receipt,
  RejectionDetail,
  SubmissionStatus,
  SubmitOutcome,
} from "./contracts/envelope.js";

export { validateRunPlan } from "./domain/plan.js";
export type { ValidateRunPlanResult } from "./domain/plan.js";
export { DISPATCH_REASONS } from "./domain/types.js";
export type {
  AgentKind,
  AgentSpec,
  AttemptRef,
  AttemptStatus,
  BlockInfo,
  DeliveryResolution,
  DeliveryState,
  DispatchDelivery,
  GateDecision,
  GateResult,
  Limits,
  Outcome,
  RoleName,
  RunPlan,
  RunStatus,
  StageSpec,
  TerminalOutcome,
} from "./domain/types.js";

export { readJournal } from "./journal/journal.js";
export type { ReadJournalResult } from "./journal/journal.js";
export type { JournalRecord } from "./journal/records.js";
export { openAttempt } from "./submission/attempt.js";
export type { OpenAttemptInput, OpenAttemptOutcome, OpenedAttempt } from "./submission/attempt.js";
export { MAX_ARTIFACT_BYTES } from "./journal/accepted-copy.js";
export { submitResult } from "./submission/submit.js";
export type { SubmitInput } from "./submission/submit.js";

export { assignAgent, openRun, recordDispatch, terminateRun } from "./state/store.js";
export type {
  AssignAgentInput,
  OpenRunInput,
  RecordDispatchInput,
  StoreOutcome,
  TerminateRunInput,
} from "./state/store.js";
export type { Counters } from "./state/reducer.js";
export { deriveSnapshot, readSnapshot } from "./state/snapshot.js";
export type {
  ArtifactIntegrity,
  ReadSnapshotResult,
  RunSnapshot,
  SnapshotAgent,
  SnapshotAttempt,
  SnapshotStage,
} from "./state/snapshot.js";

export { foldEvents, readEvents } from "./observe/events.js";
export type {
  FoldEventsResult,
  ReadEventsResult,
  RunEvent,
  RunProjection,
} from "./observe/events.js";
export type { CursorProblem } from "./observe/cursor.js";
export { subscribeEvents } from "./observe/subscribe.js";
export type { SubscribeOptions, SubscriptionItem } from "./observe/subscribe.js";

export type {
  AgentHandle,
  AmbiguousCode,
  AmbiguousDeliveryError,
  DeliveryResult,
  Lifecycle,
  LifecycleObservation,
  NotDeliveredCode,
  NotDeliveredError,
  ObservationOrder,
  RuntimeAdapter,
  RuntimeError,
  RuntimeErrorCode,
  RuntimeResult,
} from "./runtime/adapter.js";
export { herdrRuntimeName } from "./runtime/names.js";
export { ObservationTracker, watchAgent } from "./runtime/tracker.js";
export type { AgentWatch, TrackKind, TrackResult, WatchOptions } from "./runtime/tracker.js";
export { overlayRuntime } from "./runtime/overlay.js";
export type { OverlaidSnapshot, RuntimeOverlay } from "./runtime/overlay.js";
export { createHerdrCliRuntime } from "./runtime/herdr/adapter.js";
export type { HerdrCliRuntime, HerdrCliRuntimeOptions } from "./runtime/herdr/adapter.js";
