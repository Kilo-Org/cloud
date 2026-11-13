import ReactNativeSsh from './ReactNativeSshModule';
import { guard } from './errors';

/**
 * Encrypts an app-defined JSON payload into an ASCII-armored age file that the
 * `age` CLI can decrypt with the same passphrase.
 *
 * Rejects with `InvalidExport` when the payload exceeds 16 MiB or the passphrase
 * is shorter than 8 characters. The key derivation runs natively, off the
 * JavaScript thread.
 */
export function encryptExport(plaintextJson: string, passphrase: string): Promise<string> {
  return guard(() => ReactNativeSsh.encryptExport(plaintextJson, passphrase));
}

/**
 * Decrypts a file produced by [`encryptExport`] or by `age -p -a`.
 *
 * Rejects with `WrongPassphrase` when the passphrase does not open the file, and
 * with `InvalidExport` when the input is not an age file, is damaged, or holds
 * more than 16 MiB.
 */
export function decryptExport(armored: string, passphrase: string): Promise<string> {
  return guard(() => ReactNativeSsh.decryptExport(armored, passphrase));
}
