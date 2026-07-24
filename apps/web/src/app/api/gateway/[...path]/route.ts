export { POST } from '@/app/api/openrouter/[...path]/route';

// Route segment config is not inherited through a handler re-export,
// so this must match maxDuration in '@/app/api/openrouter/[...path]/route'.
export const maxDuration = 1800;
