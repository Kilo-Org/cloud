import { TRPCClientError } from '@trpc/client';
import { isDefinitiveSessionNotFoundError } from './app-builder-service';

describe('isDefinitiveSessionNotFoundError', () => {
  it.each([
    new TRPCClientError('Missing', {
      result: {
        error: {
          code: -32004,
          message: 'Missing',
          data: { code: 'NOT_FOUND', httpStatus: 404 },
        },
      },
    }),
    { code: 'NOT_FOUND' },
    { data: { httpStatus: 404 } },
    { shape: { data: { code: 'NOT_FOUND' } } },
  ])('classifies definitive tRPC not-found errors', error => {
    expect(isDefinitiveSessionNotFoundError(error)).toBe(true);
  });

  it.each([
    new Error('Not Found'),
    { data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 } },
    { data: { code: 'TIMEOUT' } },
  ])('leaves transient or unstructured failures unknown', error => {
    expect(isDefinitiveSessionNotFoundError(error)).toBe(false);
  });
});
