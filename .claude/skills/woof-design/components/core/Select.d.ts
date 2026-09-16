/** Native select styled as a 28px control. */
export interface SelectProps {
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: Array<string | { value: string; label: string }>;
  mono?: boolean;
  disabled?: boolean;
  width?: number | string;
  style?: React.CSSProperties;
}
export function Select(props: SelectProps): JSX.Element;
