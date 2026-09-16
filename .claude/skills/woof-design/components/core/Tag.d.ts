/** Removable filter tag (e.g. active filters in the runs list). */
export interface TagProps {
  children: React.ReactNode;
  onRemove?: () => void;
  style?: React.CSSProperties;
}
export function Tag(props: TagProps): JSX.Element;
