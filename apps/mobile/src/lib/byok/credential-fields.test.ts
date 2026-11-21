import { describe, expect, it } from 'vitest';

import {
  credentialForm,
  credentialPayload,
  credentialProblem,
  type CredentialValues,
  firstMissingField,
  type ModelMapping,
  readStructuredCredential,
} from './credential-fields';

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
    expect(form?.fields.map(field => [field.id, field.multiline])).toEqual([
      ['project', false],
      ['location', false],
      ['clientEmail', false],
      ['privateKey', true],
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

describe('firstMissingField', () => {
  const form = credentialForm('vertex', 'apiKey');

  it('names the first field the form still needs', () => {
    if (!form) {
      throw new Error('missing the Vertex form');
    }
    const values: CredentialValues = { project: 'p', location: '  ' };
    expect(firstMissingField(form, values)).toBe('location');
  });

  it('accepts a complete form', () => {
    if (!form) {
      throw new Error('missing the Vertex form');
    }
    const values: CredentialValues = {
      project: 'p',
      location: 'global',
      clientEmail: 'service@example.test',
      privateKey: 'pem',
    };
    expect(firstMissingField(form, values)).toBeNull();
  });
});

describe('credentialPayload', () => {
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
          privateKey: 'pem',
        },
        modelMappings: [],
      })
    ).toEqual({
      project: 'project',
      location: 'global',
      googleCredentials: { clientEmail: 'service@example.test', privateKey: 'pem' },
    });
  });
});

describe('readStructuredCredential', () => {
  const form = credentialForm('azure', 'apiKey');

  function readAzure(rows: readonly Partial<ModelMapping>[]) {
    if (!form) {
      throw new Error('missing the Azure form');
    }
    return readStructuredCredential({
      providerId: 'azure',
      mode: 'apiKey',
      form,
      values: { apiKey: 'k', resourceName: 'r' },
      rows,
    });
  }

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
          privateKey: 'pem',
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
