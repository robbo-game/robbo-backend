ALTER TABLE app_user ADD COLUMN IF NOT EXISTS github_id text UNIQUE;
CREATE TABLE IF NOT EXISTS leaderboard_submission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  replay_hash text NOT NULL,
  replay jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','verified','rejected')),
  error text,
  attempts integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,replay_hash)
);
CREATE INDEX IF NOT EXISTS leaderboard_queue_idx ON leaderboard_submission(status,created_at);
CREATE TABLE IF NOT EXISTS leaderboard_result (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  campaign text NOT NULL,
  planet integer NOT NULL CHECK(planet > 0),
  engine text NOT NULL,
  campaign_hash text NOT NULL,
  elapsed_ticks integer NOT NULL CHECK(elapsed_ticks > 0),
  deaths integer NOT NULL CHECK(deaths >= 0),
  submission_id uuid NOT NULL REFERENCES leaderboard_submission(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,campaign,planet,engine,campaign_hash)
);
CREATE INDEX IF NOT EXISTS leaderboard_order_idx ON leaderboard_result(campaign,planet,engine,campaign_hash,elapsed_ticks,deaths,user_id);
