import { assessWatchwoodSignup, prepareWatchwoodSignupSession } from '@/lib/auth/watchwood';

export const GET = prepareWatchwoodSignupSession;
export const POST = assessWatchwoodSignup;
