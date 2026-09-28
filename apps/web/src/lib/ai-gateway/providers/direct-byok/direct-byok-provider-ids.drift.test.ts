import { DIRECT_BYOK_PROVIDER_IDS } from '@kilocode/worker-utils/direct-byok-model';
import { DIRECT_BYOK_PROVIDERS_META } from './direct-byok-meta';

it('keeps the worker-utils direct BYOK provider ids in sync with the meta list', () => {
  expect([...DIRECT_BYOK_PROVIDER_IDS].sort()).toEqual(
    Object.keys(DIRECT_BYOK_PROVIDERS_META).sort()
  );
});
