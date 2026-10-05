import { ensure, safeError } from '../src/config.mjs';
import { verifyRestore } from './backup-lib.mjs';
try {ensure(process.argv[2] && process.env.RESTORE_DATABASE_URL,'CONFIG','Supply backup directory and an explicit RESTORE_DATABASE_URL.');
  console.log(JSON.stringify(await verifyRestore(process.argv[2],process.env.RESTORE_DATABASE_URL)));
} catch(error) {console.error(JSON.stringify(safeError(error)));process.exitCode=1;}
