import { formatMoney } from '../utils';

export function Modal() {
  return <div>{formatMoney(10)}</div>;
}

Modal.displayName = 'Modal';
