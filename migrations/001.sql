CREATE EXTENSION IF NOT EXISTS vector;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jovememory_app') THEN
  CREATE ROLE jovememory_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
END IF; END $$;
CREATE TABLE workspaces (name text PRIMARY KEY CHECK(name ~ '^[a-z0-9][a-z0-9_-]{0,62}$'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE nodes (workspace text NOT NULL REFERENCES workspaces, id text NOT NULL, parent text,
  label text NOT NULL, PRIMARY KEY(workspace,id), FOREIGN KEY(workspace,parent) REFERENCES nodes(workspace,id));
CREATE TABLE items (workspace text NOT NULL REFERENCES workspaces, id uuid NOT NULL,
  node text, content text NOT NULL, content_hash text NOT NULL, kind text NOT NULL DEFAULT 'note',
  metadata jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','active','invalidated','deleted','rejected')),
  proposer text NOT NULL, reviewer text, reason text, importance double precision NOT NULL DEFAULT 0.5 CHECK(importance BETWEEN 0 AND 1),
  supersedes uuid, created_at timestamptz NOT NULL DEFAULT now(), valid_from timestamptz, valid_until timestamptz,
  embedding vector, embedding_model text, search tsvector GENERATED ALWAYS AS (to_tsvector('portuguese',content)) STORED,
  PRIMARY KEY(workspace,id), FOREIGN KEY(workspace,node) REFERENCES nodes(workspace,id),
  FOREIGN KEY(workspace,supersedes) REFERENCES items(workspace,id),
  CHECK(valid_until IS NULL OR valid_from IS NULL OR valid_until>valid_from));
CREATE INDEX items_search ON items USING gin(search);
CREATE INDEX items_page ON items(workspace,created_at DESC,id DESC);
CREATE UNIQUE INDEX items_pending_replacement ON items(workspace,supersedes) WHERE status='proposed' AND supersedes IS NOT NULL;
CREATE TABLE links (workspace text NOT NULL REFERENCES workspaces, id uuid NOT NULL, target_workspace text NOT NULL REFERENCES workspaces,
  source_id uuid, target_id uuid, relation text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace,id),
  FOREIGN KEY(workspace,source_id) REFERENCES items(workspace,id), FOREIGN KEY(target_workspace,target_id) REFERENCES items(workspace,id));
CREATE TABLE media (workspace text NOT NULL, id uuid NOT NULL, item_id uuid NOT NULL, object_key text NOT NULL,
  sha256 text NOT NULL, mime text NOT NULL, size integer NOT NULL, extracted_text text NOT NULL DEFAULT '',
  embedding vector, embedding_model text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace,id), FOREIGN KEY(workspace,item_id) REFERENCES items(workspace,id));
CREATE TABLE audit (workspace text NOT NULL REFERENCES workspaces, sequence bigint GENERATED ALWAYS AS IDENTITY,
  operation text NOT NULL, item_id uuid, actor text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(sequence));
CREATE FUNCTION immutable_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit is append-only'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION immutable_audit();
CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['nodes','items','links','media','audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY workspace_scope ON %I USING (workspace = current_setting(''app.workspace'',true)) WITH CHECK (workspace = current_setting(''app.workspace'',true))',t);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO jovememory_app;
GRANT SELECT ON workspaces,settings TO jovememory_app;
GRANT SELECT,INSERT,UPDATE ON nodes,items,links,media TO jovememory_app;
GRANT SELECT,INSERT ON audit TO jovememory_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO jovememory_app;
