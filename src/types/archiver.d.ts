declare module 'archiver' {
  type ArchiverEntryData = {
    name: string;
  };

  type ArchiverOptions = {
    zlib?: {
      level?: number;
    };
  };

  type ArchiverInstance = {
    pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
    append(source: string | Buffer, data: ArchiverEntryData): void;
    finalize(): Promise<void>;
  };

  export default function archiver(format: string, options?: ArchiverOptions): ArchiverInstance;
}
