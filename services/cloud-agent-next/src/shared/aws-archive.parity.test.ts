import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { awsByocConfigurationSchema } from '@kilocode/worker-utils/aws-byoc';
import { awsArchiveIdentityFields } from './aws-archive.js';

describe('AWS archive identity parity', () => {
  it.each(Object.entries(awsArchiveIdentityFields))(
    'validates %s like the BYOC configuration',
    (field, schema) => {
      const configurationField =
        awsByocConfigurationSchema.shape[field as keyof typeof awsArchiveIdentityFields];
      expect(z.toJSONSchema(schema)).toEqual(z.toJSONSchema(configurationField));
    }
  );
});
