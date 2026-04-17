import journal from './meta/_journal.json';
import m0000 from './0000_high_trish_tilby.sql';
import m0001 from './0001_dry_synch.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
};
