import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { hash, ensure, runtimeDatabaseUrl } from '../src/config.mjs';
export async function migrate(url, {bootstrap=false}={}) {
  ensure(url, 'CONFIG','MIGRATION_DATABASE_URL is required.');
  const client = new pg.Client({connectionString:url});
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(724381)");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) {
      const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
      const prior=await client.query('SELECT sha256 FROM schema_migrations WHERE name=$1',[name]);
      if (prior.rowCount) { ensure(prior.rows[0].sha256===hash(sql),'MIGRATION','Applied migration checksum changed.'); continue; }
      await client.query('BEGIN');
      try { await client.query(sql); await client.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,hash(sql)]); await client.query('COMMIT'); }
      catch(error) { await client.query('ROLLBACK'); throw error; }
    }
    await client.query('GRANT SELECT ON schema_migrations TO jovememory_app');
    if(bootstrap) {const password=runtimeDatabaseUrl(url,process.env.APP_DATABASE_PASSWORD).password;
      await client.query(`ALTER ROLE jovememory_app LOGIN PASSWORD '${password}'`);
    }
  } finally { await client.query('SELECT pg_advisory_unlock(724381)').catch(()=>{}); await client.end(); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  await migrate(process.env.MIGRATION_DATABASE_URL,{bootstrap:!process.env.DATABASE_URL || Boolean(process.env.APP_DATABASE_PASSWORD)}); console.log('Migrations applied.');
}
