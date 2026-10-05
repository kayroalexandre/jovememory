ALTER TABLE workspaces DROP CONSTRAINT workspaces_name_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_name_check CHECK(name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$');
CREATE TABLE projects (workspace text PRIMARY KEY REFERENCES workspaces, repository_id text NOT NULL UNIQUE CHECK(repository_id ~ '^[a-f0-9]{64}$'),
  repository_name text NOT NULL, credential_epoch integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sources (workspace text NOT NULL REFERENCES workspaces, locator text NOT NULL, sha256 text,
  present boolean NOT NULL, revision text, observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace,locator));
CREATE TABLE telemetry (workspace text NOT NULL REFERENCES workspaces, sequence bigint GENERATED ALWAYS AS IDENTITY,
  tool text NOT NULL, success boolean NOT NULL, error_code text, duration_ms integer NOT NULL,
  model text, route text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace,sequence));
CREATE INDEX telemetry_time ON telemetry(workspace,created_at);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['projects','sources','telemetry'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY workspace_scope ON %I USING (workspace = current_setting(''app.workspace'',true)) WITH CHECK (workspace = current_setting(''app.workspace'',true))',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON projects,sources TO jovememory_app;
GRANT SELECT,INSERT,DELETE ON telemetry TO jovememory_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO jovememory_app;
