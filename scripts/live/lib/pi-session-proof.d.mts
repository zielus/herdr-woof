/** Types for the pi session authorship proof (p8a). The implementation is the .mjs beside this file. */

export declare const PROOF_LINES_PER_PHASE: number;
export declare const PROOF_LINE_CHARS: number;

export type PiProofPairing = "receipt" | "timestamp" | "none";

export interface PiPhaseView {
  /** Redaction-ready extract lines for the qualifying calls, bounded and truncated. */
  calls: string[];
  /** How this phase's submit was tied to the journal's accepted submission. */
  pairing: PiProofPairing;
  receiptId: string | null;
  /** The model active at each qualifying call; more than one entry is a failure. */
  models: (string | null)[];
}

export interface PiSessionProofResult {
  ok: boolean;
  /** Why the proof failed; absent when ok. */
  reason?: string;
  /** The expected model, when ok. */
  model?: string;
  phases: { build: PiPhaseView; repair: PiPhaseView };
}

export interface PiSessionProofOptions {
  sessionPath: unknown;
  repairDispatchTs: unknown;
  runDir: string;
  repoDir: string;
  cliPath: string;
  expectedModel: string;
  accepted?: ReadonlyArray<{ stageId: string; receiptId?: string | null; ts?: string | null }>;
  readFile?: (path: string) => string;
}

export declare function readPiSessionProof(options: PiSessionProofOptions): PiSessionProofResult;
export declare function tokenize(command: string): string[];
export declare function receiptIdOf(text: string): string | null;
