import * as SecureStore from '@/lib/auth/secure-store';
import * as z from 'zod';

import { PICKER_LAUNCH_CONTEXT_KEY, PICKER_RESTORE_RECORD_KEY } from '@/lib/storage-keys';

/**
 * The composer surfaces that can launch an image picker. One named union so the
 * stored launch context, the picker entry points, and the Android recovery hook
 * cannot drift; a surface missing here is a pending result the recovery hook
 * can never match.
 */
const ATTACHMENT_SURFACES = ['agent-new', 'agent-chat', 'agent-picture'] as const;

export type AttachmentSurface = (typeof ATTACHMENT_SURFACES)[number];

/**
 * How long a stored launch context or restore record stays meaningful. Longer
 * than any picker interaction, short enough that a launch whose composer never
 * came back cannot reopen (or attach to) a much later start.
 */
export const PICKER_LAUNCH_CONTEXT_TTL_MS = 10 * 60 * 1000;

export type PickerLaunchContext = {
  userId: string;
  surface: AttachmentSurface;
  sessionId: string | null;
  /**
   * The organization the launching composer was scoped to, when it had one.
   * The agent composers record it, so reopening the composer from a launch
   * lands on the same organization. Null when the composer had none.
   */
  organizationId: string | null;
  launchedAt: number;
};

const pickerLaunchContextSchema = z.object({
  userId: z.string(),
  surface: z.enum(ATTACHMENT_SURFACES),
  sessionId: z.string().nullable(),
  // Written after this field existed: a context stored by an earlier build
  // still reads, it just restores the personal new-session route.
  organizationId: z.string().nullable().default(null),
  launchedAt: z.number(),
});

async function readStoredContext(key: string): Promise<PickerLaunchContext | null> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    if (!raw) {
      return null;
    }
    const result = pickerLaunchContextSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Persist the launching composer + account before the picker opens. */
export async function writePickerLaunchContext(context: PickerLaunchContext): Promise<void> {
  await SecureStore.setItemAsync(PICKER_LAUNCH_CONTEXT_KEY, JSON.stringify(context));
}

/** Read and parse the stored context. Returns `null` on absence or a bad shape. */
export async function readPickerLaunchContext(): Promise<PickerLaunchContext | null> {
  const context = await readStoredContext(PICKER_LAUNCH_CONTEXT_KEY);
  return context;
}

/** Remove the stored context once it has been consumed or discarded. */
export async function clearPickerLaunchContext(): Promise<void> {
  await SecureStore.deleteItemAsync(PICKER_LAUNCH_CONTEXT_KEY);
}

/**
 * Persist the composer a launch belongs to, beside the launch context. The
 * composer removes it when the picker returns, so a record still here at the
 * next start is a composer the app lost and can reopen.
 */
export async function writePickerRestoreRecord(context: PickerLaunchContext): Promise<void> {
  await SecureStore.setItemAsync(PICKER_RESTORE_RECORD_KEY, JSON.stringify(context));
}

/** Read the composer record left by a launch, or `null` when there is none. */
export async function readPickerRestoreRecord(): Promise<PickerLaunchContext | null> {
  const record = await readStoredContext(PICKER_RESTORE_RECORD_KEY);
  return record;
}

/** Remove the composer record once the app decided what to do with it. */
export async function clearPickerRestoreRecord(): Promise<void> {
  await SecureStore.deleteItemAsync(PICKER_RESTORE_RECORD_KEY);
}
