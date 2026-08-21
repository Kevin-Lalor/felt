import { useStore } from './store';
import { Join } from './components/Join';
import { Table } from './components/Table';

export function App() {
  const phase = useStore((s) => s.phase);
  return phase === 'join' ? <Join /> : <Table />;
}
