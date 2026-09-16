/** One row of the run journal: seq, time, type (colored by family), subject, data. */
export interface JournalLineProps {
  seq: number;
  /** ISO timestamp; only the time part is shown. */
  ts: string;
  /** Record type, e.g. "gate.recorded". */
  type: string;
  subject?: { agentId?: string; stageId?: string; visit?: number; attempt?: number };
  data?: Record<string, unknown>;
  decision?: "pass" | "reject";
  selected?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export function JournalLine(props: JournalLineProps): JSX.Element;
