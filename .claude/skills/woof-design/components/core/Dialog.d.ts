/** Modal confirmation dialog; the only surface with a shadow-2. */
export interface DialogProps {
  open: boolean;
  title: React.ReactNode;
  children?: React.ReactNode;
  onClose?: () => void;
  actions?: React.ReactNode;
  width?: number;
  /** Render without the fixed backdrop (for specimens). */
  inline?: boolean;
}
export function Dialog(props: DialogProps): JSX.Element;
