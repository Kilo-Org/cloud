import { describe, expect, test } from '@jest/globals';
import type { CustomLlmCredentials } from '@kilocode/db/schema-types';
import {
  decryptCustomLlmCredentials,
  encryptCustomLlmCredentials,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/credentials-encryption';
import { KILO_ORGANIZATION_ID } from '@kilocode/web-shared/lib/organizations/constants';
import { useFakeByokKms } from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { testCustomLlmCredentialsEnvelope } from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

const credentials: CustomLlmCredentials = { type: 'api_key', api_key: 'sk-upstream-secret' };
const actorUserId = 'admin-user-id';

const kms = useFakeByokKms();

describe('custom LLM credentials encryption', () => {
  test('round-trips credentials', async () => {
    const envelope = await encryptCustomLlmCredentials({ credentials, actorUserId });

    expect(JSON.stringify(envelope)).not.toContain('sk-upstream-secret');
    await expect(decryptCustomLlmCredentials(envelope)).resolves.toEqual(credentials);
  });

  test('binds the data key to the Kilo organization and the envelope key id', async () => {
    const envelope = await encryptCustomLlmCredentials({ credentials, actorUserId });
    const context = {
      key_id: envelope.key_id,
      owner_type: 'organization',
      owner_id: KILO_ORGANIZATION_ID,
      provider_id: 'custom-llm',
    };

    expect(kms.requests.map(request => request.path)).toEqual(['/data-key']);
    expect(kms.requests[0].body).toEqual({ ...context, actor_user_id: actorUserId });

    await decryptCustomLlmCredentials(envelope);

    const decryptRequests = kms.requests.filter(request => request.path === '/decrypt');
    expect(decryptRequests).toHaveLength(1);
    expect(decryptRequests[0].body).toMatchObject(context);
  });

  test('uses a different key id for every encryption', async () => {
    const first = await encryptCustomLlmCredentials({ credentials, actorUserId });
    const second = await encryptCustomLlmCredentials({ credentials, actorUserId });

    expect(first.key_id).not.toBe(second.key_id);
  });

  test('returns null when the decrypted payload is not JSON', async () => {
    await expect(
      decryptCustomLlmCredentials(testCustomLlmCredentialsEnvelope('not json'))
    ).resolves.toBeNull();
  });

  test('returns null when the decrypted JSON is not valid credentials', async () => {
    await expect(
      decryptCustomLlmCredentials(testCustomLlmCredentialsEnvelope('{"type":"api_key"}'))
    ).resolves.toBeNull();
    await expect(
      decryptCustomLlmCredentials(testCustomLlmCredentialsEnvelope('{"type":"unknown"}'))
    ).resolves.toBeNull();
  });
});
