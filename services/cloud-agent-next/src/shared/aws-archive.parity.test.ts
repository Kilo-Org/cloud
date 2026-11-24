import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { awsEcsByocConfigurationSchema } from '@kilocode/worker-utils/aws-ecs';
import { awsArchiveIdentityFields } from './aws-archive.js';

describe('AWS archive identity parity', () => {
  it.each(Object.entries(awsArchiveIdentityFields))(
    'validates %s like the ECS BYOC configuration',
    (field, schema) => {
      const configurationField =
        awsEcsByocConfigurationSchema.shape[field as keyof typeof awsArchiveIdentityFields];
      expect(z.toJSONSchema(schema)).toEqual(z.toJSONSchema(configurationField));
    }
  );
});
