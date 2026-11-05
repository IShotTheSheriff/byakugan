import { cx } from './cx';

export function Modal({ open }: { open: boolean }) {
  return open ? <dialog className={cx('modal')} /> : null;
}
