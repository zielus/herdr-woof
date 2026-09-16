/** Flat panel: surface, 1px border, 5px radius, optional uppercase label header.
 * @startingPoint section="Core" subtitle="Flat bordered panel with a label header" viewport="700x200" */
export interface CardProps {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  padding?: number | string;
  style?: React.CSSProperties;
  bodyStyle?: React.CSSProperties;
}
export function Card(props: CardProps): JSX.Element;
