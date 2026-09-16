/** Underline tabs; the active one carries a 2px lavender rule. */
export interface TabsProps {
  tabs: Array<string | { id: string; label: React.ReactNode; count?: number }>;
  value: string;
  onChange?: (id: string) => void;
  style?: React.CSSProperties;
}
export function Tabs(props: TabsProps): JSX.Element;
