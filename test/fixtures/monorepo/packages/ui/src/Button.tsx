import { cx } from './cx';

export function Button({ children }: { children: React.ReactNode }) {
  return <button className={cx('btn')}>{children}</button>;
}
