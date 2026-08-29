BEGIN;

ALTER TABLE drones_devices
  DROP CONSTRAINT IF EXISTS drones_devices_platform_check;

ALTER TABLE drones_devices
  ADD CONSTRAINT drones_devices_platform_check
  CHECK (platform IN ('ios', 'web'));

ALTER TABLE drones_playbacks
  ADD COLUMN IF NOT EXISTS source_kind varchar(16) NOT NULL DEFAULT 'phone'
    CHECK (source_kind IN ('phone', 'computer')),
  ADD COLUMN IF NOT EXISTS distance_m double precision
    CHECK (distance_m IS NULL OR distance_m BETWEEN 0.1 AND 100),
  ADD COLUMN IF NOT EXISTS volume_percent smallint
    CHECK (volume_percent IS NULL OR volume_percent BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS environment varchar(24) NOT NULL DEFAULT 'unspecified'
    CHECK (environment IN ('unspecified', 'quiet-room', 'traffic', 'wind', 'other'));

INSERT INTO drones_schema_migrations (version) VALUES (3)
ON CONFLICT (version) DO NOTHING;

COMMIT;
