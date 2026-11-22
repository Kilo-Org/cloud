import {
  type GgufModelRecord,
  type GgufStorage,
  keepStoredModels,
  modelIndexFullyParsed,
} from './gguf-records';

/**
 * Writes the list the device keeps. False when the device refused it, which the
 * caller reports rather than ignoring: a list the device did not take is not a
 * list it holds, and the files it names would be orphans on the next launch.
 */
export function writeSavedModels(storage: GgufStorage, next: readonly GgufModelRecord[]): boolean {
  try {
    storage.writeIndex(JSON.stringify(next));
    return true;
  } catch {
    // A storage the OS refused (full disk, permission, I/O) is a reported
    // failure, not a rejection nobody awaits.
    return false;
  }
}

/**
 * The saved list after cleanup, or the fact that producing it failed. A caller
 * that gets `failed` keeps the list it already had and reports the failure, so
 * the empty list here is never shown.
 */
type SavedModels = {
  readonly models: readonly GgufModelRecord[];
  readonly failed: boolean;
};

/**
 * The saved models whose files are all still on the device, after deleting the
 * files the saved list never names.
 *
 * The read and the cleanup live here because both can be refused: a storage the
 * OS would not read (permission, full disk, I/O) is a state the picker reports,
 * not a crash, and this list is read while rendering.
 *
 * The pruned list is written back only when the saved one parsed in full, since
 * a rewrite of a list this build could not read would drop that entry and the
 * next launch would delete its file. That rewrite is best effort: the list just
 * read is what the picker shows, and the next download or removal writes the
 * pruned one, so a device that refuses this write still has models it can run.
 * Only a failed read or a refused delete sets `failed`.
 */
export function loadSavedModels(input: {
  readonly storage: GgufStorage;
  readonly partialNames: readonly string[];
}): SavedModels {
  try {
    const index = input.storage.readIndex();
    const models = keepStoredModels({ ...input, index });
    if (modelIndexFullyParsed(index)) {
      writeSavedModels(input.storage, models);
    }
    return { models, failed: false };
  } catch {
    // The caller keeps the list it had, so the empty one it gets back is unused.
    return { models: [], failed: true };
  }
}
