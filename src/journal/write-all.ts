import { writeSync } from "node:fs";

export type WriteFn = (fd: number, buffer: Uint8Array, offset: number, length: number) => number;

/**
 * Writes every byte of `data` to `fd`, resuming after short writes. A write
 * that reports no progress throws instead of being treated as complete, so a
 * caller never acknowledges a partially written line or file. `write` is
 * injectable for fault testing.
 */
export function writeAll(
  fd: number,
  data: string | Uint8Array,
  write: WriteFn = (target, buffer, offset, length) => writeSync(target, buffer, offset, length),
): void {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = write(fd, bytes, offset, bytes.byteLength - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error(
        `short write: ${offset} of ${bytes.byteLength} bytes written, then no progress`,
      );
    }
    offset += written;
  }
}
