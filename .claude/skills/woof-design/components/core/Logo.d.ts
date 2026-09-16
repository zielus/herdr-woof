/** The Woof mark, theme-aware. Prefer 32px or larger. */
export interface LogoProps {
  size?: number;
  variant?: "mark" | "tile";
  theme?: "dark" | "light";
  /** Path to assets/brand relative to the page. */
  base?: string;
  withName?: boolean;
  version?: string;
  style?: React.CSSProperties;
}
export function Logo(props: LogoProps): JSX.Element;
