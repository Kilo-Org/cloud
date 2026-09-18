import journal from './meta/_journal.json';
import m0000 from './0000_happy_zaladane.sql';
import m0001 from './0001_cynical_karen_page.sql';
import m0002 from './0002_square_the_spike.sql';
import m0003 from './0003_wandering_colleen_wing.sql';
import m0004 from './0004_refresh_token_history.sql';
import m0005 from './0005_approval_queue.sql';
import m0006 from './0006_lovely_hammerhead.sql';
import m0007 from './0007_drop_approval_queue.sql';
import m0008 from './0008_watery_jazinda.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
    m0005,
    m0006,
    m0007,
    m0008,
  },
};
