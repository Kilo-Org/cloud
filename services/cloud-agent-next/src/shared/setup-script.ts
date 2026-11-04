import { z } from 'zod';

// Wrapper builds only include src/shared and standalone wrapper dependencies.
// Keep these wire limits aligned with cloud-agent-profile/setup-script.
export const setupCommandsSchema = z.array(z.string().max(16_000)).max(20);
