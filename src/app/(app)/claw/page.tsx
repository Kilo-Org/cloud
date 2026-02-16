'use client';

import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { ClawDashboard, withStatusQueryBoundary } from './components';

const ClawDashboardWithBoundary = withStatusQueryBoundary(ClawDashboard);

export default function ClawPage() {
  const statusQuery = useKiloClawStatus();
  return <ClawDashboardWithBoundary statusQuery={statusQuery} />;
}
