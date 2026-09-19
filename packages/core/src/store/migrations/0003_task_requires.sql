-- `requires` distinguishes "must have settled" from "must have succeeded".
--
-- A separate migration rather than an edit to 0001, because 0001 has already run
-- somewhere and the runner refuses a file whose checksum has changed. That refusal is
-- the point: two environments quietly holding different schemas is worse than a loud
-- failure at deploy time.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS requires TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN tasks.depends_on IS
  'Keys that must have settled (succeeded or skipped) before this task becomes ready.';
COMMENT ON COLUMN tasks.requires IS
  'Keys that must have SUCCEEDED. A skipped requirement skips this task too, which is what stops a rejected approval being followed by the send it was gating.';
