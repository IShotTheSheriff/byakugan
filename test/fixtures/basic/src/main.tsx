import { partition } from 'lodash';
import { pick } from 'es-utils';
import { Button } from '@/components';
import { formatDate } from './utils';
import * as strings from './strings';
import type { Props } from './types';

export function App(props: Props) {
  const [big, small] = partition([1, 2, 3], n => n > 1);
  return (
    <Button label={formatDate(props.date) + strings.upper(props.label)} data={pick({ a: 1 }, 'a')}>
      {big.length + small.length}
    </Button>
  );
}
