import journal from './meta/_journal.json';
import m0000 from './0000_rapid_thanos.sql';
import m0001 from './0001_lean_redwing.sql';
import m0002 from './0002_nosy_alice.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
  },
};
