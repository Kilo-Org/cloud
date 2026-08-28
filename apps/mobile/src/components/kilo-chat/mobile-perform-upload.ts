import { createXhrPerformUpload, type PerformUpload } from '@kilocode/kilo-chat-hooks';

import { LocalAccessDeniedError } from '@/lib/local-access';

const performUpload = createXhrPerformUpload();

// The shared uploader permits old web callers without admission; mobile never does.
// eslint-disable-next-line max-params -- preserve the shared PerformUpload contract
export const mobilePerformUpload: PerformUpload = async (blob, putUrl, putHeaders, options) => {
  if (!options.operation) {
    throw new LocalAccessDeniedError('stale');
  }
  await performUpload(blob, putUrl, putHeaders, options);
};
