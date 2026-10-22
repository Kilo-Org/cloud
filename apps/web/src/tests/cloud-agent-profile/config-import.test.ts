/**
 * The import UI decodes the archive in the browser and sends the same bytes to
 * the server as base64. This exercises that transport contract against a real
 * representative archive so a broken encoding cannot silently invalidate the
 * preview or the apply payload.
 */
import { describe, expect, test } from '@jest/globals';
import { buildRepresentativeImportArchive } from '@kilocode/cloud-agent-profile/import/testing';
import {
  createSelectionGuard,
  decodeArchiveLocally,
  encodeArchiveBody,
} from '@/components/cloud-agent/profile-editor/config-import';

function decodeServerSide(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('config import archive transport', () => {
  test('encodes bytes the server decodes back to the same archive', () => {
    const archive = buildRepresentativeImportArchive();
    const encoded = encodeArchiveBody(archive);
    expect(Buffer.from(decodeServerSide(encoded))).toEqual(Buffer.from(archive));
  });

  test('parses the transported archive into every supported category', () => {
    const archive = buildRepresentativeImportArchive();
    const preview = decodeArchiveLocally(decodeServerSide(encodeArchiveBody(archive)));

    expect(preview.hasErrors).toBe(false);
    expect(preview.config.agents.map(agent => agent.slug).sort()).toEqual([
      'auditor',
      'reviewer',
      'triage',
    ]);
    expect(preview.config.commands.map(command => command.name).sort()).toEqual([
      'explain',
      'fix',
      'ship',
    ]);
    expect(preview.config.skills.map(skill => skill.name)).toEqual(['deploy']);
    expect(preview.config.instructions.map(instruction => instruction.name).sort()).toEqual([
      'agents',
      'coding-style',
    ]);
  });

  test('encodes payloads larger than one chunk identically to Buffer', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 1234);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index * 31 + 7) % 256;
    }
    expect(encodeArchiveBody(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('import selection guard', () => {
  test('an out-of-order preview response cannot replace the newest selection', async () => {
    const guard = createSelectionGuard();
    let activePreview: string | null = null;
    const commitPreview = (token: number, preview: string) => {
      if (guard.isCurrent(token)) activePreview = preview;
    };

    const tokenA = guard.begin();
    const deferredA = deferred<string>();
    const tokenB = guard.begin();
    const deferredB = deferred<string>();

    const pendingB = deferredB.promise.then(preview => commitPreview(tokenB, preview));
    const pendingA = deferredA.promise.then(preview => commitPreview(tokenA, preview));

    deferredB.resolve('archive-b');
    await pendingB;
    deferredA.resolve('archive-a');
    await pendingA;

    expect(activePreview).toBe('archive-b');
  });

  test('invalidate drops a pending selection', () => {
    const guard = createSelectionGuard();
    const token = guard.begin();
    guard.invalidate();
    expect(guard.isCurrent(token)).toBe(false);
  });
});
