BEGIN;

ALTER TABLE drones_devices DROP COLUMN IF EXISTS token_hash;

INSERT INTO drones_schema_migrations (version) VALUES (2)
ON CONFLICT (version) DO NOTHING;

COMMIT;
