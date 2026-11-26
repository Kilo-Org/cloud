import { createHash, randomUUID } from 'node:crypto';

/**
 * A fresh credential pepper and a stable identifier of the change that
 * installs it. The identifier is the SHA-256 digest of the pepper, computed in
 * process: two rotations never share one, a repeat of one rotation always
 * does, and it reveals nothing about the pepper, which stays in the statement
 * that writes it and is never stored or logged anywhere else.
 */
export type PepperRotation = { pepper: string; rotationId: string };

export function newPepperRotation(): PepperRotation {
  const pepper = randomUUID();
  return { pepper, rotationId: createHash('sha256').update(pepper).digest('hex') };
}
