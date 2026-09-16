/** Pill status chip; the only place state color meets text.
 * @startingPoint section="Core" subtitle="Status chips for every run, agent and gate state" viewport="700x200" */
export interface ChipProps {
  /** Engine state word, rendered verbatim in mono: running, blocked, pass, fail, lost, idle… */
  state: string;
  /** Override the color family. */
  tone?: "pass" | "fail" | "blocked" | "lost" | "idle" | "working";
  dot?: boolean;
  pulse?: boolean;
  size?: "sm" | "md";
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export function Chip(props: ChipProps): JSX.Element;
