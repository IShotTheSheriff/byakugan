import { cn } from '../utils';

export function Button(props: { label: string; data: unknown; children?: unknown }) {
  return <button className={cn('btn', 'primary')}>{props.label}</button>;
}

Button.displayName = 'Button';
