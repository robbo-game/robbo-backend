CREATE TABLE IF NOT EXISTS app_user (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS progress_record (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  campaign text NOT NULL CHECK (char_length(campaign) <= 64),
  slot text NOT NULL CHECK (char_length(slot) <= 64),
  revision bigint NOT NULL CHECK (revision > 0),
  schema_version integer NOT NULL,
  game_version text NOT NULL CHECK (char_length(game_version) <= 128),
  device_id text NOT NULL CHECK (char_length(device_id) <= 128),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, campaign, slot)
);
CREATE INDEX IF NOT EXISTS progress_record_user_updated_idx ON progress_record (user_id, updated_at);

CREATE TABLE IF NOT EXISTS idempotency_key (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 128),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
