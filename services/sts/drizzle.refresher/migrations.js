import journal from './meta/_journal.json';
import m0000 from './0000_skinny_azazel.sql';
import m0001 from './0001_magenta_drax.sql';
import m0002 from './0002_milky_rachel_grey.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
  },
};
