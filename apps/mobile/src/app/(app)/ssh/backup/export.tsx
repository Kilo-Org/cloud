import { useLocalSearchParams } from 'expo-router';

import { SshBackupExportScreen } from '@/components/ssh/backup-export-screen';

export default function SshBackupExportRoute() {
  const { dev } = useLocalSearchParams<{ dev?: string }>();
  return <SshBackupExportScreen dev={__DEV__ ? dev : undefined} />;
}
