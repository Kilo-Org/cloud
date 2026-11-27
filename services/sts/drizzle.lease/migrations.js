import journal from './meta/_journal.json';
import m0000 from './0000_mighty_miss_america.sql';
import m0001 from './0001_curvy_iron_lad.sql';
import m0002 from './0002_drop_lease_run_id.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
  },
};
