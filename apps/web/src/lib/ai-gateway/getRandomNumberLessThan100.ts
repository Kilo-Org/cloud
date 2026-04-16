import * as crypto from 'crypto';

export function getRandomNumberLessThan100(randomSeed: string) {
  return crypto.createHash('sha256').update(randomSeed).digest().readUInt32BE(0) % 100;
}
