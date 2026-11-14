import { useLocalSearchParams } from 'expo-router';

import { SshBackupImportScreen } from '@/components/ssh/backup-import-screen';

export default function SshBackupImportRoute() {
  const { dev } = useLocalSearchParams<{ dev?: string }>();
  return <SshBackupImportScreen dev={__DEV__ ? dev : undefined} />;
}
