/** Transient notification; fires on run.blocked and termination. */
export interface ToastProps {
  tone?: "neutral" | "pass" | "fail" | "blocked";
  title: React.ReactNode;
  detail?: React.ReactNode;
  action?: React.ReactNode;
  onDismiss?: () => void;
  style?: React.CSSProperties;
}
export function Toast(props: ToastProps): JSX.Element;
