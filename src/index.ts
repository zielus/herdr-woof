/**
 * Public SDK entry point.
 *
 * Keeping this module free of CLI and plugin imports preserves the package
 * boundary. The package's ESM metadata makes this compiled file importable as
 * a module. Test doubles live in `herdr-woof/testing`, not here.
 *
 * Everything below is unstable until v1: the p1 result handoff (`openAttempt`,
 * `submitResult`, `readJournal`), run plans and domain types, the state store,
 * snapshots, events and the runtime adapter contract (p2), and the p3 workflow
 * engine: definitions and their loader, admission, the sequential scheduler
 * (`runWorkflow`), the built-in build-review workflow and the run result. The
 * scheduler is the only component that chooses a next stage; it records its
 * decisions through the store. `woof attempt open`, `woof submit`,
 * `woof run show`, `woof run build-review` and `woof run cancel` call the same
 * functions.
 *
 * p4 adds configuration resolution (`resolveConfiguration`, `discoverRoots`),
 * the read-only Claude Code trust check, run host claims and their probe, the
 * inspection views behind `woof status` and `woof runs`, and `openAdmittedRun`.
 * Launching a pane host and the Herdr metadata reporter stay CLI internals.
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
  AttemptCause,
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
  Revision,
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

export {
  assignAgent,
  blockRun,
  cancelRun,
  openRun,
  reconcileDelivery,
  recordDispatch,
  recordGate,
  terminateRun,
  unblockRun,
} from "./state/store.js";
export type { CancelSource } from "./journal/lifecycle-records.js";
export { ACTIVITY_KINDS, ACTIVITY_PHASES } from "./journal/activity-records.js";
export type {
  ActivityKind,
  ActivityPhase,
  ActivitySubject,
  AgentLifecycleChangedRecord,
  RunActivityRecord,
} from "./journal/activity-records.js";
export type {
  AssignAgentInput,
  BlockRunInput,
  CancelRunInput,
  CancelRunOutcome,
  OpenRunInput,
  OpenRunOutcome,
  ReconcileDeliveryInput,
  RecordDispatchInput,
  RecordGateInput,
  StoreOutcome,
  TerminateRunInput,
  UnblockRunInput,
} from "./state/store.js";
export { deriveRunResult } from "./state/result.js";
export type {
  AcceptedRef,
  DeriveRunResultOptions,
  EvidenceRef,
  RunResult,
} from "./state/result.js";
export type { Counters } from "./state/reducer.js";
export { deriveSnapshot, readSnapshot } from "./state/snapshot.js";
export type {
  ArtifactIntegrity,
  ReadSnapshotResult,
  RunSnapshot,
  SnapshotActivity,
  SnapshotAgent,
  SnapshotAgentLifecycle,
  SnapshotChild,
  SnapshotAttempt,
  SnapshotBlocked,
  SnapshotGate,
  SnapshotHostFact,
  SnapshotObservationLoss,
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
export { createRunRenderer } from "./observe/render.js";
export type { RunEnd, RunRenderer, RunRendererInput } from "./observe/render.js";
export type { RenderOptions } from "./observe/render-text.js";
export type { GraphNode, WorkflowGraph } from "./observe/workflow-graph.js";

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
export type { OverlaidSnapshot, OverlaySkip, RuntimeOverlay } from "./runtime/overlay.js";
export { createHerdrCliRuntime } from "./runtime/herdr/adapter.js";
export type { HerdrCliRuntime, HerdrCliRuntimeOptions } from "./runtime/herdr/adapter.js";

export { validateWorkflowDefinition } from "./scheduler/definition.js";
export type {
  AgentStage,
  CheckGateContext,
  CheckStage,
  ChildRef,
  InputArtifact,
  InputRef,
  RequestContext,
  RunHistory,
  StageGateContext,
  StageRequest,
  Transition,
  ValidateDefinitionResult,
  WorkflowDefinition,
  WorkflowStage,
} from "./scheduler/definition.js";
export type { CheckoutAccess, CheckoutSpec, ResolvedCheckout } from "./contracts/checkout.js";
export { loadWorkflowDefinition } from "./scheduler/loader.js";
export type { LoadDefinitionResult, LoadReason } from "./scheduler/loader.js";
export { admitWorkflow, openAdmittedRun } from "./scheduler/admission.js";
export type {
  AdmissionCheckout,
  AdmissionConfiguration,
  AdmissionProvenance,
  AdmissionReason,
  AdmissionResult,
} from "./scheduler/admission.js";
export { runWorkflow } from "./scheduler/driver.js";
export type {
  ChildHost,
  ChildOpened,
  ChildRequest,
  RunWorkflowOptions,
  RunWorkflowResult,
  SchedulerWarning,
} from "./scheduler/driver.js";
export type { Action, AgentRuntimeView, ChildEnd } from "./scheduler/core.js";
export type { StageChildOpenedRecord, StageChildResultRecord } from "./journal/child-records.js";
export { buildReviewWorkflow } from "./workflows/build-review.js";
export type { BuildReviewInput } from "./workflows/build-review.js";
export { planBuildReviewWorkflow } from "./workflows/plan-build-review.js";
export type { PlanBuildReviewInput } from "./workflows/plan-build-review.js";
export { BUILT_IN_WORKFLOWS, builtInWorkflow, builtInWorkflowNames } from "./workflows/catalog.js";

export { discoverRoots } from "./config/discover.js";
export type { ConfigRoots, ConfigWarning, DiscoverOptions } from "./config/discover.js";
export { resolveConfiguration } from "./config/resolve.js";
export type {
  ConfigFlags,
  Provenance,
  ResolveConfigurationResult,
  ResolvedConfiguration,
} from "./config/resolve.js";
export type {
  ConfigDetail,
  ConfigFailure,
  ConfigReason,
  ConfigScope,
  ConfigSource,
  RoleValue,
} from "./config/schema.js";
export { claudeTrustStatus } from "./runtime/claude/trust.js";
export type { ClaudeTrust, ClaudeTrustStatus } from "./runtime/claude/trust.js";
export { claimHost } from "./host/claim.js";
export type { ClaimHostResult } from "./host/claim.js";
export { probeHost } from "./host/probe.js";
export type { HostInfo, HostOwner, HostState, ProbeOptions } from "./host/probe.js";
export { readRunStatus } from "./inspect/status.js";
export type { ReadRunStatusResult, RunStatusView } from "./inspect/status.js";
export { listRuns } from "./inspect/runs.js";
export type { ListRunsResult, RunListEntry } from "./inspect/runs.js";
