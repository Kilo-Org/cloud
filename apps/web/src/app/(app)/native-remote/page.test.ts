jest.mock('./NativeRemotePreview', () => ({ __esModule: true, default: () => null }));

import NativeRemotePage from './page';

afterEach(() => {
  jest.restoreAllMocks();
});

it.each<NodeJS.ProcessEnv['NODE_ENV']>(['production', 'test'])(
  'returns not-found for the preview page when NODE_ENV is %s',
  environment => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: environment });

    expect(() => NativeRemotePage()).toThrow(
      expect.objectContaining({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
    );
  }
);
