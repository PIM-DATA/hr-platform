-- Rows created by the OJT handoff before the semantics correction carried the program objective in observed_level.
-- An objective is what the OJT aimed at, not a level anybody observed: move it to objective_level_snapshot and clear observed_level.
UPDATE "competency_evidence"
SET "objective_level_snapshot" = COALESCE("objective_level_snapshot", "observed_level"), "observed_level" = NULL
WHERE "source_type" = 'OJT' AND "observed_level" IS NOT NULL;
