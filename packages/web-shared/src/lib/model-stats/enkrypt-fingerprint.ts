import { createHash } from 'node:crypto';
import { EnkryptScoreSchema, type EnkryptScore } from '@kilocode/db/schema-types';

export function fingerprintEnkryptScore(score: EnkryptScore): string {
  return createHash('sha256')
    .update(JSON.stringify(EnkryptScoreSchema.parse(score)))
    .digest('hex');
}
