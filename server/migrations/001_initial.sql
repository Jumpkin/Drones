BEGIN;

CREATE TABLE IF NOT EXISTS drones_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drones_devices (
  id uuid PRIMARY KEY,
  label varchar(80) NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  token_hash char(64) NOT NULL UNIQUE,
  app_version varchar(40) NOT NULL,
  platform varchar(24) NOT NULL CHECK (platform = 'ios'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drones_sessions (
  id uuid PRIMARY KEY,
  code char(6) NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES drones_devices(id),
  status varchar(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS drones_session_memberships (
  session_id uuid NOT NULL REFERENCES drones_sessions(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES drones_devices(id) ON DELETE CASCADE,
  role varchar(12) NOT NULL CHECK (role IN ('source', 'listener')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, device_id)
);

CREATE TABLE IF NOT EXISTS drones_playbacks (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES drones_sessions(id) ON DELETE CASCADE,
  source_device_id uuid NOT NULL REFERENCES drones_devices(id),
  sound_id varchar(80) NOT NULL,
  expected_label varchar(12) NOT NULL CHECK (expected_label IN ('drone', 'background')),
  scheduled_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 250 AND 120000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drones_observations (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES drones_devices(id),
  session_id uuid REFERENCES drones_sessions(id) ON DELETE SET NULL,
  playback_id uuid REFERENCES drones_playbacks(id) ON DELETE SET NULL,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  latitude double precision,
  longitude double precision,
  horizontal_accuracy_m double precision,
  altitude_m double precision,
  sample_rate integer NOT NULL CHECK (sample_rate BETWEEN 8000 AND 192000),
  window_duration_ms integer NOT NULL CHECK (window_duration_ms BETWEEN 100 AND 10000),
  consensus_detected boolean NOT NULL,
  positive_detectors smallint NOT NULL CHECK (positive_detectors BETWEEN 0 AND 3),
  classification_profile varchar(40),
  classification_label varchar(80),
  classification_confidence double precision CHECK (classification_confidence BETWEEN 0 AND 1),
  detectors jsonb NOT NULL CHECK (jsonb_typeof(detectors) = 'array'),
  CHECK ((latitude IS NULL AND longitude IS NULL) OR
         (latitude IS NOT NULL AND longitude IS NOT NULL AND
          latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)),
  CHECK (horizontal_accuracy_m IS NULL OR horizontal_accuracy_m BETWEEN 0 AND 100000),
  CHECK (altitude_m IS NULL OR altitude_m BETWEEN -1000 AND 100000)
);

CREATE INDEX IF NOT EXISTS drones_sessions_code_idx
  ON drones_sessions (code) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS drones_memberships_device_idx
  ON drones_session_memberships (device_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS drones_playbacks_session_idx
  ON drones_playbacks (session_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS drones_observations_session_idx
  ON drones_observations (session_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS drones_observations_device_idx
  ON drones_observations (device_id, captured_at DESC);

INSERT INTO drones_schema_migrations (version) VALUES (1)
ON CONFLICT (version) DO NOTHING;

COMMIT;
