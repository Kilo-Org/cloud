import { GetObjectCommand, NoSuchKey, PutObjectCommand } from '@aws-sdk/client-s3';

type R2Credentials = { accessKeyId: string; secretAccessKey: string };

/** In-memory stand-in for an R2 client that supports string-bodied puts and gets. */
export function createFakeR2Client() {
  const objects = new Map<string, string>();
  return {
    objects,
    credentials: null as R2Credentials | null,
    async send(command: unknown) {
      if (command instanceof PutObjectCommand) {
        const { Bucket, Key, Body } = command.input;
        if (typeof Body !== 'string') {
          throw new Error('Fake R2 client only supports string bodies');
        }
        objects.set(`${Bucket}/${Key}`, Body);
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const body = objects.get(`${command.input.Bucket}/${command.input.Key}`);
        if (body === undefined) {
          throw new NoSuchKey({ message: 'The specified key does not exist.', $metadata: {} });
        }
        return { Body: { transformToString: async () => body } };
      }
      throw new Error('Unsupported fake R2 command');
    },
  };
}

export type FakeR2Client = ReturnType<typeof createFakeR2Client>;

/**
 * Replacement for `@/lib/r2/client` whose `createR2Client` always returns the
 * same fake and records the credentials it was created with. Retrieve the fake
 * with `jest.requireMock<FakeR2ClientModule>('@/lib/r2/client').fakeR2`.
 */
export function createFakeR2ClientModule() {
  const fakeR2 = createFakeR2Client();
  return {
    fakeR2,
    createR2Client(credentials: R2Credentials) {
      fakeR2.credentials = credentials;
      return fakeR2;
    },
  };
}

export type FakeR2ClientModule = ReturnType<typeof createFakeR2ClientModule>;
