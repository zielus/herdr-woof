import { cn } from "cn";

import { ownerTone, statusTone, TONE_CLASS, TONE_DOT, type Tone } from "@/lib/format";

/**
 * One status chip. States are printed exactly as the engine names them, in
 * lower-case mono — never paraphrased and never title-cased.
 */
export function StateChip({
  label,
  tone,
  className,
}: {
  label: string;
  tone: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-xs whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} aria-hidden="true" />
      {label}
    </span>
  );
}

export function StatusChip({ status, className }: { status: string; className?: string }) {
  return (
    <StateChip label={status} tone={statusTone(status)} {...(className ? { className } : {})} />
  );
}

export function OwnerChip({ owner, className }: { owner: string; className?: string }) {
  return (
    <StateChip
      label={`owner ${owner}`}
      tone={ownerTone(owner)}
      {...(className ? { className } : {})}
    />
  );
}
