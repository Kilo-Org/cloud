import journal from './meta/_journal.json';
import m0000 from './0000_lumpy_loners.sql';
import m0001 from './0001_dear_tombstone.sql';
import m0002 from './0002_first_mephisto.sql';
import m0003 from './0003_sparkling_kate_bishop.sql';
import m0004 from './0004_bumpy_firebird.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
  },
};
