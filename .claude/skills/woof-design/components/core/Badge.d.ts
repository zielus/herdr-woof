/** Small square-cornered count/label badge: counts, exit codes, versions, roles. */
export interface BadgeProps {
  children: React.ReactNode;
  tone?: "neutral" | "accent";
  mono?: boolean;
  style?: React.CSSProperties;
}
export function Badge(props: BadgeProps): JSX.Element;
