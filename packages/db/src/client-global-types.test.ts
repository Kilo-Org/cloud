import { describe, expect, it } from '@jest/globals';
import pg from 'pg';
// Importing the client used to install an int8 parser on the shared `pg` module. The
// assertions below run after this import for that reason, and this file deliberately
// mocks nothing so it observes the real process-wide parsers.
import { databaseTypeParsers } from './client';

describe('importing the database client', () => {
  it('leaves the process-wide int8 parser alone', () => {
    const parse = pg.types.getTypeParser(pg.types.builtins.INT8, 'text');

    expect(parse('9223372036854775807')).toBe('9223372036854775807');
  });

  it('offers the int8 BigInt parser per pool instead', () => {
    const parse = databaseTypeParsers.getTypeParser(pg.types.builtins.INT8, 'text');

    expect(parse('9223372036854775807')).toBe(BigInt('9223372036854775807'));
  });

  it('delegates the other types to pg', () => {
    for (const oid of [pg.types.builtins.INT4, pg.types.builtins.NUMERIC, pg.types.builtins.BOOL]) {
      expect(databaseTypeParsers.getTypeParser(oid, 'text')).toBe(
        pg.types.getTypeParser(oid, 'text')
      );
    }
  });
});
