/** Ghost square button holding one Icon. */
export interface IconButtonProps {
  icon: string;
  /** Required accessible label; also the tooltip. */
  label: string;
  size?: "sm" | "md";
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export function IconButton(props: IconButtonProps): JSX.Element;
