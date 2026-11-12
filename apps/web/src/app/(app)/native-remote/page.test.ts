jest.mock('./NativeRemotePreview', () => ({ __esModule: true, default: () => null }));

import NativeRemotePage from './page';
import OrganizationNativeRemotePage from '../organizations/[id]/native-remote/page';

afterEach(() => {
  jest.restoreAllMocks();
});

it.each<NodeJS.ProcessEnv['NODE_ENV']>(['production', 'test'])(
  'returns not-found for the preview page when NODE_ENV is %s',
  environment => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: environment });

    for (const Page of [NativeRemotePage, OrganizationNativeRemotePage]) {
      expect(() => Page()).toThrow(
        expect.objectContaining({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
      );
    }
  }
);
