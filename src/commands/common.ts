import { readFileSync, statSync } from "node:fs";

import { MAX_ENVELOPE_BYTES } from "../contracts/envelope.js";

/** Shared CLI plumbing for command handlers: usage errors, flag parsing and JSON output. */

export class UsageError extends Error {}

/** Largest workflow input read from a file or stdin, in bytes. */
export const MAX_INPUT_BYTES = 1024 * 1024;

export const OUTCOME_EXIT_CODES = { completed: 0, failed: 4, exhausted: 5, cancelled: 6 } as const;

export function parse<T>(run: () => T, usage: string): T {
  try {
    return run();
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${usage}`);
  }
}

export function required(value: string | undefined, flag: string, usage: string): string {
  if (value === undefined || value === "") throw new UsageError(`${flag} is required\n\n${usage}`);
  return value;
}

export function milliseconds(value: string, flag: string, min = 0, max = 3_600_000): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new UsageError(`${flag} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

/** Prints a one-line rejection and returns the exit code. */
export function rejected(
  reason: string,
  message: string,
  details: unknown[],
  code: number,
  extra: Record<string, unknown> = {},
): number {
  console.log(JSON.stringify({ outcome: "rejected", reason, message, details, ...extra }));
  return code;
}

export function readInputFile(path: string): Uint8Array {
  const size = statSync(path).size;
  if (size > MAX_INPUT_BYTES) throw new Error(`${path} is larger than ${MAX_INPUT_BYTES} bytes`);
  return readFileSync(path);
}

/**
 * Reads file descriptor 0 through the stdin stream, stopping one chunk past
 * `limit` (MAX_ENVELOPE_BYTES for envelopes) so the caller can report the size. The
 * stdin device is never opened by path: on Linux that fails with ENXIO when
 * stdin is a socket, as it is for many process spawners.
 */
export async function readStdin(limit = MAX_ENVELOPE_BYTES): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      chunks.push(buffer);
      size += buffer.byteLength;
      if (size > limit) break;
    }
  } catch (error) {
    throw new UsageError(`cannot read the envelope from stdin: ${(error as Error).message}`);
  }
  return Buffer.concat(chunks);
}
