CREATE TABLE IF NOT EXISTS game_checkpoint (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  campaign text NOT NULL CHECK(char_length(campaign) BETWEEN 1 AND 64),
  slot text NOT NULL CHECK(char_length(slot) BETWEEN 1 AND 64),
  revision integer NOT NULL CHECK(revision > 0),
  device_id text NOT NULL CHECK(char_length(device_id) BETWEEN 1 AND 128),
  attempt jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,campaign,slot)
);
CREATE TABLE IF NOT EXISTS checkpoint_history (
  user_id uuid NOT NULL,
  campaign text NOT NULL,
  slot text NOT NULL,
  revision integer NOT NULL,
  device_id text NOT NULL,
  attempt jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,campaign,slot,revision),
  FOREIGN KEY(user_id,campaign,slot) REFERENCES game_checkpoint(user_id,campaign,slot) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS checkpoint_request (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key text NOT NULL CHECK(char_length(key) BETWEEN 16 AND 128),
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,key)
);
