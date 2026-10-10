import * as crypto from 'crypto';

export function getRandomNumber(randomSeed: string, max: number) {
  return crypto.createHash('sha256').update(randomSeed).digest().readUInt32BE(0) % max;
}
