import { protectedResourceMetadata } from '@/lib/credential-admission';

// The answer follows the deployment's configuration, read on each request.
export const dynamic = 'force-dynamic';
export const GET = protectedResourceMetadata;
