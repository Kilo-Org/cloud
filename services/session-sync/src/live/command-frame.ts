export type CommandFrameRow = {
  commandID: string;
  from: string;
  type: string;
  payload: string;
  expiresAt: number;
  liveOnly: boolean;
  createdAt: number;
};

/**
 * Encodes one command frame. The stored payload text is immutable, so it is spliced into the
 * envelope verbatim: repeat sends parse, validate and re-serialize nothing. Key order and value
 * encoding match the historical object form exactly, which `command-frame.test.ts` pins.
 */
export function commandFrame(row: CommandFrameRow, seq: number): string {
  return (
    '{"v":1,"channel":"commands","seq":' +
    seq +
    ',"from":' +
    JSON.stringify(row.from) +
    ',"at":' +
    row.createdAt +
    ',"type":' +
    JSON.stringify(row.type) +
    ',"body":{"commandID":' +
    JSON.stringify(row.commandID) +
    ',"payload":' +
    row.payload +
    ',"expiresAt":' +
    JSON.stringify(new Date(row.expiresAt).toISOString()) +
    ',"liveOnly":' +
    (row.liveOnly ? 'true' : 'false') +
    '}}'
  );
}
