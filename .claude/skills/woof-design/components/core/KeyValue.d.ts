/** Two-column definition list; values mono by default. */
export interface KeyValueProps {
  items: Array<{ k: React.ReactNode; v: React.ReactNode; mono?: boolean }>;
  columns?: number;
  labelWidth?: number;
  style?: React.CSSProperties;
}
export function KeyValue(props: KeyValueProps): JSX.Element;
