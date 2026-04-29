import { describe, expect, it } from 'vitest';
import { getNorthflankConfig, northflankClientConfig, NORTHFLANK_API_BASE } from './config';

const baseEnv = {
  NF_API_TOKEN: 'nf-token',
  NF_REGION: 'us-central',
  NF_DEPLOYMENT_PLAN: 'nf-compute-200',
  NF_EDGE_HEADER_NAME: 'x-kiloclaw-edge',
  NF_EDGE_HEADER_VALUE: 'edge-secret',
};

describe('getNorthflankConfig', () => {
  it('reads required Northflank env and applies defaults', () => {
    expect(getNorthflankConfig(baseEnv as never)).toEqual({
      apiToken: 'nf-token',
      apiBase: NORTHFLANK_API_BASE,
      teamId: null,
      region: 'us-central',
      deploymentPlan: 'nf-compute-200',
      storageClassName: 'nf-multi-rw',
      storageAccessMode: 'ReadWriteMany',
      volumeSizeMb: 10240,
      ephemeralStorageMb: 10240,
      edgeHeaderName: 'x-kiloclaw-edge',
      edgeHeaderValue: 'edge-secret',
      imagePathTemplate: null,
      imageCredentialsId: null,
    });
  });

  it('accepts optional Northflank overrides', () => {
    expect(
      getNorthflankConfig({
        ...baseEnv,
        NF_API_BASE: 'https://northflank.test/v1',
        NF_TEAM_ID: 'team-1',
        NF_STORAGE_CLASS_NAME: 'nf-ssd-rwo',
        NF_STORAGE_ACCESS_MODE: 'ReadWriteOnce',
        NF_VOLUME_SIZE_MB: '20480',
        NF_EPHEMERAL_STORAGE_MB: '4096',
        NF_IMAGE_PATH_TEMPLATE: 'ghcr.io/kilo-org/kiloclaw:{tag}',
        NF_IMAGE_CREDENTIALS_ID: 'credential-1',
      } as never)
    ).toEqual({
      apiToken: 'nf-token',
      apiBase: 'https://northflank.test/v1',
      teamId: 'team-1',
      region: 'us-central',
      deploymentPlan: 'nf-compute-200',
      storageClassName: 'nf-ssd-rwo',
      storageAccessMode: 'ReadWriteOnce',
      volumeSizeMb: 20480,
      ephemeralStorageMb: 4096,
      edgeHeaderName: 'x-kiloclaw-edge',
      edgeHeaderValue: 'edge-secret',
      imagePathTemplate: 'ghcr.io/kilo-org/kiloclaw:{tag}',
      imageCredentialsId: 'credential-1',
    });
  });

  it('rejects missing required Northflank env', () => {
    expect(() => getNorthflankConfig({ ...baseEnv, NF_API_TOKEN: '' } as never)).toThrow(
      'NF_API_TOKEN is not configured'
    );
  });

  it('rejects invalid numeric overrides', () => {
    expect(() => getNorthflankConfig({ ...baseEnv, NF_VOLUME_SIZE_MB: 'ten' } as never)).toThrow(
      'NF_VOLUME_SIZE_MB must be a positive integer'
    );
  });
});

describe('northflankClientConfig', () => {
  it('redacts the ingress edge header value from every Northflank client', () => {
    expect(northflankClientConfig(baseEnv as never)).toEqual({
      ...getNorthflankConfig(baseEnv as never),
      redactValues: ['edge-secret'],
    });
  });
});
