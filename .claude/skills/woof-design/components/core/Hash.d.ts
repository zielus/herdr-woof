/** Shortened sha256/id with full value on hover and one-click copy. */
export interface HashProps {
  value: string | null | undefined;
  /** Visible characters, default 12. */
  length?: number;
  copy?: boolean;
  prefix?: string;
  style?: React.CSSProperties;
}
export function Hash(props: HashProps): JSX.Element;
