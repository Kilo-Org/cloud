import { useLocalSearchParams } from 'expo-router';

import { SshFilesScreen } from '@/components/ssh/files/files-screen';
import { parseParam } from '@/lib/route-params';

type FilesRouteParams = {
  'session-id': string;
  path?: string;
  /** Dev-only: the surface the design gate opens. */
  dev?: string;
};

export default function SshFilesRoute() {
  const params = useLocalSearchParams<FilesRouteParams>();
  const dev =
    __DEV__ && (params.dev === 'transfers' || params.dev === 'preview' || params.dev === 'forwards')
      ? params.dev
      : null;

  return (
    <SshFilesScreen
      sessionId={parseParam(params['session-id']) ?? ''}
      initialPath={parseParam(params.path)}
      dev={dev}
    />
  );
}
