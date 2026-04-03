import journal from './meta/_journal.json';
import m0000 from './0000_lumpy_loners.sql';
import m0001 from './0001_dear_tombstone.sql';
import m0002 from './0002_first_mephisto.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
  },
};
