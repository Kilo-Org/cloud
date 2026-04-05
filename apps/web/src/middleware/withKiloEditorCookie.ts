import { type NextFetchEvent, NextResponse } from 'next/server';
import type { MiddlewareFactory } from '@/middleware/types';
import { EDITOR_SOURCE_COOKIE_NAME } from '@/lib/editorSource.client';
import type { NextMiddlewareWithAuth, NextRequestWithAuth } from 'next-auth/middleware';

export const withKiloEditorCookie: MiddlewareFactory = (nextMiddleware: NextMiddlewareWithAuth) => {
  return async (request: NextRequestWithAuth, nextFetchEvent: NextFetchEvent) => {
    const result = await nextMiddleware(request, nextFetchEvent);
    const source = request.nextUrl.searchParams.get('source');
    if (source && result) {
      // Wrap in NextResponse if needed so we can use the cookie API
      const response =
        result instanceof NextResponse ? result : NextResponse.next({ headers: result.headers });
      response.cookies.set({
        name: EDITOR_SOURCE_COOKIE_NAME,
        value: source,
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      });
      return response;
    }
    return result;
  };
};
