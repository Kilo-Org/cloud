import { z } from 'zod';

// Wrapper builds only include src/shared and standalone wrapper dependencies.
// Keep these wire limits aligned with worker-utils/setup-script.
export const setupScriptSchema = z.string().max(16_000);
export const setupCommandsSchema = z.array(setupScriptSchema).max(20);

export const environmentSetupCommandCountSchema = z.number().int().nonnegative().max(20);
