import { NextResponse } from 'next/server';
import { CODE_INDEXING_ENABLED } from '@kilocode/web-shared/lib/config.server';

export const CODE_INDEXING_GONE_MESSAGE = 'Managed code indexing is no longer available.';

export function isCodeIndexingEnabled(): boolean {
  return CODE_INDEXING_ENABLED;
}

export function codeIndexingGoneResponse() {
  return NextResponse.json(
    { error: 'gone', message: CODE_INDEXING_GONE_MESSAGE },
    { status: 410 }
  );
}
