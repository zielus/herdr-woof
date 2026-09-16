/** Vertical timeline of stage visits with nested attempts.
 * @startingPoint section="Core" subtitle="Stage visits with nested attempts" viewport="700x200" */
export interface TimelineProps {
  items: Array<{ stageId: string; visit: number; round?: number; status?: string; attempts?: Array<{ attempt: number; status?: string; cause?: string; agentId?: string; verdict?: string | null; at?: string }> }>;
  selected?: string;
  onSelect?: (key: string, attempt: any) => void;
  style?: React.CSSProperties;
}
export function Timeline(props: TimelineProps): JSX.Element;
