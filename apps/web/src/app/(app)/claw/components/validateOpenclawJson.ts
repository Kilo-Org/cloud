import { toast } from 'sonner';

/**
 * Client-side validation for openclaw.json before saving.
 * Returns true if valid, false (with a toast error) if not.
 */
export function validateOpenclawJsonForSave(filePath: string, content: string): boolean {
  if (filePath !== 'openclaw.json') return true;
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      toast.error('Config must be a JSON object');
      return false;
    }
  } catch {
    toast.error('Invalid JSON — fix syntax errors before saving');
    return false;
  }
  return true;
}
