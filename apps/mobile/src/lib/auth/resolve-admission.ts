import { toast } from 'sonner-native';

import {
  ADMISSION_CHALLENGE_FAILED,
  type AdmissionPayload,
  getAdmission,
} from '@/lib/auth/admission';
import { retryableAdmissionError } from '@/lib/auth/auth-error-messages';

export async function resolveAdmission(): Promise<
  { admission: AdmissionPayload } | { admission: undefined }
> {
  try {
    const admission = await getAdmission();
    if (admission) {
      return { admission };
    }
    return { admission: undefined };
  } catch {
    // Normalize every challenge/provider failure to the retryable message.
    // Network errors, JSON parse failures, and !response.ok all abort sign-in;
    // every path must show the retryable toast and throw a consistent sentinel.
    toast.error(retryableAdmissionError());
    throw new Error(ADMISSION_CHALLENGE_FAILED);
  }
}
