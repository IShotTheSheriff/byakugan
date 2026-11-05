import { partition } from 'lodash';
import { Button } from '@acme/ui';
import { Hero } from '@/components/Hero';

export const metadata = { title: 'Home' };

export default function Page() {
  const [even] = partition([1, 2, 3, 4], n => n % 2 === 0);
  return (
    <main>
      <Hero />
      <Button>{even.length}</Button>
    </main>
  );
}
