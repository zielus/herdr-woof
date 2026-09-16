/** Hover tooltip, always dark charcoal, mono text. */
export interface TooltipProps {
  label: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom";
}
export function Tooltip(props: TooltipProps): JSX.Element;
