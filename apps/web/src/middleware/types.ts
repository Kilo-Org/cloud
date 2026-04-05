import type { NextMiddlewareWithAuth } from 'next-auth/middleware';

export type MiddlewareFactory = (middleware: NextMiddlewareWithAuth) => NextMiddlewareWithAuth;
