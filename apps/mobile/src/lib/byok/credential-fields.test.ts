// eslint-disable-next-line import/no-nodejs-modules -- test-only fixture key
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  credentialForm,
  credentialPayload,
  credentialProblem,
  type CredentialValues,
  missingFields,
  type ModelMapping,
  readStructuredCredential,
} from './credential-fields';

/** A real key, because the Vertex form now refuses anything that is not a PEM. */
const { privateKey: fixtureKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const exportedKey = fixtureKey.export({ type: 'pkcs8', format: 'pem' });
const PEM_KEY = typeof exportedKey === 'string' ? exportedKey : exportedKey.toString('utf8');

describe('credentialForm', () => {
  it('offers one API key and its region for the API-key Bedrock method', () => {
    const form = credentialForm('bedrock', 'apiKey');
    expect(form?.fields.map(field => field.id)).toEqual(['apiKey', 'region']);
    expect(form?.showsAuthMode).toBe(true);
  });

  it('offers the IAM key pair and its region for the access-key Bedrock method', () => {
    const form = credentialForm('bedrock-byok', 'accessKeys');
    expect(form?.fields.map(field => field.id)).toEqual([
      'accessKeyId',
      'secretAccessKey',
      'region',
    ]);
  });

  it('offers Azure its key and resource name, with model mappings', () => {
    const form = credentialForm('azure', 'apiKey');
    expect(form?.fields.map(field => field.id)).toEqual(['apiKey', 'resourceName']);
    expect(form?.showsModelMappings).toBe(true);
  });

  it('offers Vertex its project, location and service account', () => {
    const form = credentialForm('vertex-byok', 'apiKey');
    expect(form?.fields.map(field => field.id)).toEqual([
      'project',
      'location',
      'clientEmail',
      'privateKey',
    ]);
  });

  it('asks a single-key provider for no structured field', () => {
    expect(credentialForm('anthropic', 'apiKey')).toBeNull();
  });

  it('masks every secret field and nothing else', () => {
    const form = credentialForm('bedrock', 'accessKeys');
    expect(form?.fields.filter(field => field.secret).map(field => field.id)).toEqual([
      'secretAccessKey',
    ]);
  });
});

describe('missingFields', () => {
  const form = credentialForm('vertex', 'apiKey');

  it('names every field the form still needs, in the order the form shows them', () => {
    if (!form) {
      throw new Error('missing the Vertex form');
    }
    const values: CredentialValues = { project: 'p', location: '  ' };
    expect(missingFields(form, values)).toEqual(['location', 'clientEmail', 'privateKey']);
  });

  it('asks nothing of a complete form', () => {
    if (!form) {
      throw new Error('missing the Vertex form');
    }
    const values: CredentialValues = {
      project: 'p',
      location: 'global',
      clientEmail: 'service@example.test',
      privateKey: 'pem',
    };
    expect(missingFields(form, values)).toEqual([]);
  });
});

describe('credentialPayload', () => {
  function vertexValues(privateKey: string) {
    return {
      project: 'p',
      location: 'global',
      clientEmail: 'service@example.test',
      privateKey,
    } satisfies CredentialValues;
  }

  it('refuses a value that is not a private key instead of storing it', () => {
    expect(
      credentialProblem({
        providerId: 'vertex',
        mode: 'apiKey',
        values: vertexValues('not a key'),
        modelMappings: [],
      })
    ).toEqual({ code: 'invalid-credential' });
  });

  it('writes the Bedrock API-key method as the web form stores it', () => {
    expect(
      credentialPayload({
        providerId: 'bedrock',
        mode: 'apiKey',
        values: { apiKey: ' k ', region: 'us-east-1' },
        modelMappings: [],
      })
    ).toEqual({ apiKey: 'k', region: 'us-east-1' });
  });

  it('writes the Bedrock IAM method without the API-key field', () => {
    expect(
      credentialPayload({
        providerId: 'bedrock',
        mode: 'accessKeys',
        values: { accessKeyId: 'id', secretAccessKey: 'secret', region: 'us-east-1' },
        modelMappings: [],
      })
    ).toEqual({ accessKeyId: 'id', secretAccessKey: 'secret', region: 'us-east-1' });
  });

  it('keeps Azure model mappings only when there are some', () => {
    const base = {
      providerId: 'azure',
      mode: 'apiKey',
      values: { apiKey: 'k', resourceName: 'r' },
    } as const;
    expect(credentialPayload({ ...base, modelMappings: [] })).toEqual({
      apiKey: 'k',
      resourceName: 'r',
    });
    expect(
      credentialPayload({
        ...base,
        modelMappings: [{ gatewayModelSlug: 'anthropic/claude', customModelId: 'deployment' }],
      })
    ).toEqual({
      apiKey: 'k',
      resourceName: 'r',
      modelMappings: [{ gatewayModelSlug: 'anthropic/claude', customModelId: 'deployment' }],
    });
  });

  it('nests the Vertex service account', () => {
    expect(
      credentialPayload({
        providerId: 'vertex',
        mode: 'apiKey',
        values: {
          project: 'project',
          location: 'global',
          clientEmail: 'service@example.test',
          privateKey: PEM_KEY,
        },
        modelMappings: [],
      })
    ).toEqual({
      project: 'project',
      location: 'global',
      googleCredentials: { clientEmail: 'service@example.test', privateKey: PEM_KEY.trim() },
    });
  });
});

describe('readStructuredCredential', () => {
  /** One form's fields read as the credential its provider takes. */
  function read(
    providerId: string,
    values: CredentialValues,
    rows: readonly Partial<ModelMapping>[] = []
  ) {
    const form = credentialForm(providerId, 'apiKey');
    if (!form) {
      throw new Error(`missing the ${providerId} form`);
    }
    return readStructuredCredential({ providerId, mode: 'apiKey', form, values, rows });
  }
  const readAzure = (rows: readonly Partial<ModelMapping>[]) =>
    read('azure', { apiKey: 'k', resourceName: 'r' }, rows);
  const readVertex = (privateKey: string) =>
    read('vertex', { project: 'p', location: 'global', clientEmail: 'a@b.test', privateKey });

  it('reads a key file the gateway can sign with as ready', () => {
    expect(readVertex(PEM_KEY)).toMatchObject({ tag: 'ready' });
  });

  it('reports every empty field, so each gets its own message', () => {
    const form = credentialForm('bedrock', 'accessKeys');
    if (!form) {
      throw new Error('missing the Bedrock access-key form');
    }
    expect(
      readStructuredCredential({
        providerId: 'bedrock',
        mode: 'accessKeys',
        form,
        values: { accessKeyId: '  ' },
        rows: [],
      })
    ).toEqual({ tag: 'missing', fields: ['accessKeyId', 'secretAccessKey', 'region'] });
  });

  it('refuses an encrypted key with the passphrase cause on the private-key field', () => {
    const encrypted = fixtureKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: 'x',
    });
    const pem = typeof encrypted === 'string' ? encrypted : encrypted.toString('utf8');
    expect(pem.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----')).toBe(true);
    expect(readVertex(pem)).toEqual({
      tag: 'refused',
      field: 'privateKey',
      cause: 'key-encrypted',
    });
  });

  it('refuses a truncated key block with the block cause, not the passphrase cause', () => {
    const truncated = PEM_KEY.trim()
      .split('\n')
      .filter(line => !line.startsWith('-----END '))
      .join('\n');
    expect(readVertex(truncated)).toEqual({
      tag: 'refused',
      field: 'privateKey',
      cause: 'key-block',
    });
  });

  it('refuses a value that is not a key on the private-key field', () => {
    expect(readVertex('not a key')).toEqual({
      tag: 'refused',
      field: 'privateKey',
      cause: 'key-block',
    });
  });

  it('names the row a half-filled mapping sits in', () => {
    expect(readAzure([{ gatewayModelSlug: 'gpt-4' }])).toEqual({
      tag: 'incomplete-mapping',
      mapping: 1,
    });
    expect(
      readAzure([{ gatewayModelSlug: 'gpt-4', customModelId: 'gpt-4' }, { customModelId: 'x' }])
    ).toEqual({ tag: 'incomplete-mapping', mapping: 2 });
  });

  it('asks nothing of a row with neither side filled', () => {
    expect(readAzure([{}, { gatewayModelSlug: ' ', customModelId: '' }])).toEqual({
      tag: 'ready',
      credential: JSON.stringify({ apiKey: 'k', resourceName: 'r' }),
    });
  });

  it('keeps the complete mappings and drops the empty rows', () => {
    expect(readAzure([{}, { gatewayModelSlug: ' gpt-4 ', customModelId: ' gpt-4o ' }, {}])).toEqual(
      {
        tag: 'ready',
        credential: JSON.stringify({
          apiKey: 'k',
          resourceName: 'r',
          modelMappings: [{ gatewayModelSlug: 'gpt-4', customModelId: 'gpt-4o' }],
        }),
      }
    );
  });
});

describe('credentialProblem', () => {
  it('accepts each provider once its fields are filled', () => {
    expect(
      credentialProblem({
        providerId: 'azure',
        mode: 'apiKey',
        values: { apiKey: 'k', resourceName: 'r' },
        modelMappings: [],
      })
    ).toBeNull();
    expect(
      credentialProblem({
        providerId: 'bedrock',
        mode: 'accessKeys',
        values: { accessKeyId: 'id', secretAccessKey: 'secret', region: 'us-east-1' },
        modelMappings: [],
      })
    ).toBeNull();
    expect(
      credentialProblem({
        providerId: 'vertex',
        mode: 'apiKey',
        values: {
          project: 'project',
          location: 'global',
          clientEmail: 'service@example.test',
          privateKey: PEM_KEY,
        },
        modelMappings: [],
      })
    ).toBeNull();
  });

  it('names a mapping that is missing its deployment name', () => {
    expect(
      credentialProblem({
        providerId: 'azure',
        mode: 'apiKey',
        values: { apiKey: 'k', resourceName: 'r' },
        modelMappings: [{ gatewayModelSlug: 'anthropic/claude', customModelId: ' ' }],
      })
    ).toEqual({ code: 'invalid-model-mapping' });
  });
});
