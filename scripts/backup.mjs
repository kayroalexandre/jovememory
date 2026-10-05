import { config, ensure, safeError } from '../src/config.mjs';
import { createBackup } from './backup-lib.mjs';
try {ensure(process.argv[2] && process.env.MIGRATION_DATABASE_URL,'CONFIG','Supply an external destination and MIGRATION_DATABASE_URL.');
  console.log(JSON.stringify(await createBackup(process.env.MIGRATION_DATABASE_URL,config().s3,process.argv[2])));
} catch(error) {console.error(JSON.stringify(safeError(error)));process.exitCode=1;}
