import { GetObjectCommand, NoSuchKey, PutObjectCommand } from '@aws-sdk/client-s3';

/** In-memory stand-in for `r2Client` that supports string-bodied puts and gets. */
export function createFakeR2Client() {
  const objects = new Map<string, string>();
  return {
    objects,
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
