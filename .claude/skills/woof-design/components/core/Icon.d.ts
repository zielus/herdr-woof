/** Lucide-derived line icon, 16px default, 1.5px stroke. */
export interface IconProps {
  name: "play" | "square" | "x" | "check" | "copy" | "chevronDown" | "chevronRight" | "search" | "refresh" | "sun" | "moon" | "file" | "terminal" | "externalLink" | "alert" | "info" | "menu" | "github" | "clock" | "hash" | "arrowRight" | "dot";
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}
export function Icon(props: IconProps): JSX.Element;
