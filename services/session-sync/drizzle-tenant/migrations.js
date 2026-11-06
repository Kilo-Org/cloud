import journal from './meta/_journal.json';
import m0000 from './0000_furry_senator_kelly.sql';
import m0001 from './0001_superb_pandemic.sql';
import m0002 from './0002_creator_session_order.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
  },
};
