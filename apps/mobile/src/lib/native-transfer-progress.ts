import * as z from 'zod';

// expo-file-system types transfer progress counts as `number`, but iOS sends the
// native Int64 values as `bigint`. Mixing them with number math throws, so every
// progress event is parsed at the native boundary instead of trusted.
const ByteCount = z.union([z.number(), z.bigint().transform(Number)]);

/** Upload task progress, with each byte count as a number. */
export const NativeUploadProgress = z.object({ bytesSent: ByteCount, totalBytes: ByteCount });

/** Download task progress, with each byte count as a number. */
export const NativeDownloadProgress = z.object({ bytesWritten: ByteCount, totalBytes: ByteCount });
