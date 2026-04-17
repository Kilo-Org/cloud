import journal from './meta/_journal.json';
import m0000 from './0000_melted_orphan.sql';
import m0001 from './0001_chemical_deadpool.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
};
