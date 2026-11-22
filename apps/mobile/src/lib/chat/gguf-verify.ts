import {
  type GgufDownloadProblem,
  type GgufInspect,
  type GgufInspection,
  type GgufModelRecord,
  type GgufStorage,
  type Settled,
} from './gguf-records';
import { type GgufTransfer, moveIntoPlace, PASSES, readVerified } from './gguf-transfers';

/**
 * Every failure a check can report, derived from the download's own problems so
 * the caller can report it unchecked. The store decides when space or the
 * network failed; a check only ever judges the files.
 */
type GgufVerificationProblem = Extract<
  GgufDownloadProblem,
  'checksum' | 'unreadable' | 'invalidFile' | 'writeFailed'
>;

export type GgufVerification =
  | { readonly ok: true; readonly model: GgufModelRecord }
  | { readonly ok: false; readonly problem: GgufVerificationProblem };

/**
 * Reads the finished files, moves them to their model names, and describes the
 * model they are. One refused read is no verdict on the bytes - a load refused
 * while the device is short of memory says nothing about the file, and hashing a
 * file again costs far less than downloading it again - so the read runs once
 * more. A checksum mismatch is the verdict itself and is never read again, and a
 * model whose projector does not read images is not the model the catalog
 * promised: that verdict cannot change between reads, so it ends the check.
 * The move that follows has three outcomes: a file in place ends the check with
 * the model's record, a move the device refused is `writeFailed`, and a file
 * that is neither partial nor in place is `invalidFile`.
 *
 * A read refused on the last pass ends the check with the refusal it was: a hash
 * the device would not compute is `unreadable`, which says nothing about the
 * bytes, and a load it refused is `invalidFile`.
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
  /** The last pass's answer, which decides what the final refusal reports. */
  let last: Settled<GgufInspection> | 'unreadable' = { ok: false };
  for (let pass = 0; pass < PASSES; pass += 1) {
    // eslint-disable-next-line no-await-in-loop -- one file at a time bounds memory and CPU
    const read = await readVerified(storage, inspect, transfers);
    if (read === 'checksum') {
      return { ok: false, problem: 'checksum' };
    }
    last = read;
    if (read !== 'unreadable' && read.ok) {
      // A projector that reads no images cannot change between passes, so it ends
      // verification here instead of hashing and loading the model again.
      if (projector !== undefined && !read.value.vision) {
        return { ok: false, problem: 'invalidFile' };
      }
      const move = moveIntoPlace(storage, transfers);
      if (move === 'refused') {
        return { ok: false, problem: 'writeFailed' };
      }
      if (move === 'missing') {
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
  return last === 'unreadable'
    ? { ok: false, problem: 'unreadable' }
    : { ok: false, problem: 'invalidFile' };
}
