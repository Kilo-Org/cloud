import journal from './meta/_journal.json';
import m0000 from './0000_happy_zaladane.sql';
import m0001 from './0001_cynical_karen_page.sql';
import m0002 from './0002_square_the_spike.sql';
import m0003 from './0003_wandering_colleen_wing.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
  },
};
