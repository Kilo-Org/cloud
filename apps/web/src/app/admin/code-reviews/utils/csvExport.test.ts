import { exportCodeReviewsToCSV } from './csvExport';

const baseRow = {
  id: 'review-1',
  owned_by_organization_id: null,
  owned_by_user_id: 'user-1',
  repo_full_name: 'example/repo',
  pr_number: 12,
  pr_title: 'Add widget',
  pr_author: 'author',
  status: 'completed',
  error_message: null,
  started_at: '2026-10-20T10:00:00.000Z',
  completed_at: '2026-10-20T10:05:00.000Z',
  created_at: '2026-10-20T09:59:00.000Z',
  session_id: 'session-1',
};

type ExportRow = Parameters<typeof exportCodeReviewsToCSV>[0][number];

type LinkStub = {
  setAttribute: jest.Mock;
  click: jest.Mock;
  style: Record<string, string>;
};

const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

let emittedBlob: Blob | undefined;
let appendedLink: LinkStub | undefined;

beforeEach(() => {
  emittedBlob = undefined;
  appendedLink = {
    setAttribute: jest.fn(),
    click: jest.fn(),
    style: {},
  };
  const link = appendedLink;

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: jest.fn(() => link),
      body: { appendChild: jest.fn(), removeChild: jest.fn() },
    },
  });
  Object.defineProperty(globalThis.URL, 'createObjectURL', {
    configurable: true,
    value: jest.fn((blob: Blob) => {
      emittedBlob = blob;
      return 'blob:test';
    }),
  });
  Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
    configurable: true,
    value: jest.fn(),
  });
});

afterEach(() => {
  Object.defineProperty(globalThis.URL, 'createObjectURL', {
    configurable: true,
    value: originalCreateObjectUrl,
  });
  Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
    configurable: true,
    value: originalRevokeObjectUrl,
  });
  Reflect.deleteProperty(globalThis, 'document');
});

/** Minimal RFC 4180 reader for the exported CSV. */
function parseCsv(csv: string): { header: string[]; records: string[][] } {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];

    if (inQuotes) {
      if (character !== '"') {
        cell += character;
      } else if (csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = false;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      record.push(cell);
      cell = '';
    } else if (character === '\r' || character === '\n') {
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
    } else {
      cell += character;
    }
  }

  record.push(cell);
  records.push(record);

  const [header, ...rows] = records;
  return { header, records: rows };
}

async function exportRows(
  rows: ExportRow[]
): Promise<{ csv: string; header: string[]; records: string[][] }> {
  exportCodeReviewsToCSV(rows, '2026-10-20T09:00:00.000Z', '2026-10-20T11:00:00.000Z');

  expect(emittedBlob).toBeDefined();
  expect(appendedLink?.click).toHaveBeenCalled();

  const csv = await emittedBlob!.text();
  const parsed = parseCsv(csv);
  return { csv, ...parsed };
}

function cellOf(record: string[], header: string[], column: string): string {
  const index = header.indexOf(column);
  expect(index).toBeGreaterThanOrEqual(0);
  return record[index];
}

describe('exportCodeReviewsToCSV', () => {
  it('quotes a value that contains a carriage return', async () => {
    const value = 'first\rsecond';
    const { csv, header, records } = await exportRows([{ ...baseRow, pr_title: value }]);

    expect(records).toHaveLength(1);
    expect(cellOf(records[0], header, 'pr_title')).toBe(value);
    expect(csv).toContain(`"${value}"`);
  });

  it('keeps each exported row in one record', async () => {
    const { header, records } = await exportRows([
      { ...baseRow, pr_title: 'first\rsecond' },
      { ...baseRow, id: 'review-2', pr_title: 'plain' },
    ]);

    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toHaveLength(header.length);
    }
    expect(records[0][header.indexOf('pr_title')]).toBe('first\rsecond');
  });

  it.each(['=SUM(A1)', '+1', '-1', '@SUM(A1)', '\tformula'])(
    'prefixes a leading formula character in %j with a single quote',
    async value => {
      const { header, records } = await exportRows([{ ...baseRow, pr_title: value }]);

      expect(cellOf(records[0], header, 'pr_title')).toBe(`'${value}`);
    }
  );

  it('prefixes and quotes a value that begins with a carriage return', async () => {
    const { csv, header, records } = await exportRows([{ ...baseRow, pr_title: '\rtext' }]);

    expect(records).toHaveLength(1);
    expect(cellOf(records[0], header, 'pr_title')).toBe("'\rtext");
    expect(csv).toContain('"\'\rtext"');
  });

  const carriageReturnColumns: Array<[string, (payload: string) => ExportRow]> = [
    ['pr_author', payload => ({ ...baseRow, pr_author: payload })],
    ['error_message', payload => ({ ...baseRow, error_message: payload })],
    ['retry_reason', payload => ({ ...baseRow, attempt_id: 'attempt-1', retry_reason: payload })],
    [
      'attempt_error_message',
      payload => ({ ...baseRow, attempt_id: 'attempt-1', attempt_error_message: payload }),
    ],
  ];

  it.each(carriageReturnColumns)(
    'quotes a carriage return in column %s',
    async (column, makeRow) => {
      const value = 'value\rsecond';
      const { csv, header, records } = await exportRows([makeRow(value)]);

      expect(records).toHaveLength(1);
      expect(cellOf(records[0], header, column)).toBe(value);
      expect(csv).toContain(`"${value}"`);
    }
  );

  it.each([
    ['comma,value', '"comma,value"'],
    ['quote"value', '"quote""value"'],
    ['line\nbreak', '"line\nbreak"'],
    ['plain value', 'plain value'],
  ])('quotes values containing %j as %j', async (value, quoted) => {
    const { csv, header, records } = await exportRows([{ ...baseRow, pr_title: value }]);

    expect(records).toHaveLength(1);
    expect(cellOf(records[0], header, 'pr_title')).toBe(value);
    expect(csv).toContain(quoted);
  });

  it('adds attempt columns to the header only when a row has attempt data', async () => {
    const withoutAttempts = await exportRows([baseRow]);
    expect(withoutAttempts.header).not.toContain('attempt_id');

    const withAttempts = await exportRows([{ ...baseRow, attempt_id: 'attempt-1' }]);
    expect(withAttempts.header).toContain('attempt_id');
  });
});
