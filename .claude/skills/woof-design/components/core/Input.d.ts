/** Text input on the inset surface; mono variant for paths and ids. */
export interface InputProps {
  value?: string;
  defaultValue?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  /** Monospace value (paths, ids, commands). */
  mono?: boolean;
  icon?: string;
  invalid?: boolean;
  disabled?: boolean;
  width?: number | string;
  size?: "md" | "lg";
  label?: string;
  hint?: string;
  style?: React.CSSProperties;
}
export function Input(props: InputProps): JSX.Element;
