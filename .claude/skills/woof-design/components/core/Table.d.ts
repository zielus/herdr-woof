/** Dense data table, 28px rows (24 dense), selected row gets a 2px lavender edge.
 * @startingPoint section="Core" subtitle="Dense table with selectable rows" viewport="700x200" */
export interface TableProps {
  columns: Array<{ key: string; label: React.ReactNode; align?: "left" | "right"; width?: number | string; maxWidth?: number | string; mono?: boolean; render?: (row: any) => React.ReactNode }>;
  rows: any[];
  rowKey?: string;
  selected?: string | number;
  onSelect?: (key: any, row: any) => void;
  dense?: boolean;
  empty?: React.ReactNode;
  style?: React.CSSProperties;
}
export function Table(props: TableProps): JSX.Element;
