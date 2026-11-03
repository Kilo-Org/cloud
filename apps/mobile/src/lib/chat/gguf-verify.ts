import { type GgufInspect, type GgufModelRecord, type GgufStorage } from './gguf-records';
import { type GgufTransfer, moveIntoPlace, PASSES, readVerified } from './gguf-transfers';

export type GgufVerification =
  | { readonly ok: true; readonly model: GgufModelRecord }
  | { readonly ok: false; readonly problem: 'checksum' | 'invalidFile' };

/**
 * Reads the finished files, moves them to their model names, and describes the
 * model they are. One refused read is no verdict on the bytes - a load refused
 * while the device is short of memory says nothing about the file, and hashing a
 * file again costs far less than downloading it again - so the read runs once
 * more. A checksum mismatch is the verdict itself and is never read again, and a
 * model whose projector does not read images is not the model the catalog promised.
 */
export async function verifyModel(
  storage: GgufStorage,
  inspect: GgufInspect,
  input: {
    readonly fileId: string;
    readonly name: string;
    readonly transfers: readonly GgufTransfer[];
    /** Every file of the model, as they arrived. */
    readonly sizeBytes: number;
  }
): Promise<GgufVerification> {
  const { transfers } = input;
  const [model, projector] = transfers;
  if (model === undefined) {
    return { ok: false, problem: 'invalidFile' };
  }
  for (let pass = 0; pass < PASSES; pass += 1) {
    // eslint-disable-next-line no-await-in-loop -- one file at a time bounds memory and CPU
    const read = await readVerified(storage, inspect, transfers);
    if (read === 'checksum') {
      return { ok: false, problem: 'checksum' };
    }
    if (read.ok && (projector === undefined || read.value.vision)) {
      if (!moveIntoPlace(storage, transfers)) {
        return { ok: false, problem: 'invalidFile' };
      }
      return {
        ok: true,
        model: {
          fileId: input.fileId,
          name: input.name,
          url: model.url,
          sizeBytes: input.sizeBytes,
          contextWindow: read.value.contextWindow,
          tools: read.value.tools,
          vision: projector !== undefined,
          thinking: read.value.thinking,
        },
      };
    }
  }
  return { ok: false, problem: 'invalidFile' };
}
