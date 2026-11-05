import dynamic from 'next/dynamic';

const Chart = dynamic(() => import('@/components/Chart'));

export default function Dashboard() {
  return <Chart />;
}
