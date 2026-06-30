-- ============================================================
-- Migration 027: Allow arbitrary branch keys for the Switch step
--
-- The original CHECK (branch IN ('yes', 'no')) only supported
-- binary Condition branches. The new Switch step uses per-case
-- string IDs (e.g. "case_1718000000000", "default") as branch
-- keys, so we drop the restrictive constraint from both tables
-- that carry a `branch` column.
-- ============================================================

ALTER TABLE automation_steps
  DROP CONSTRAINT IF EXISTS automation_steps_branch_check;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'automation_pending_steps'
  ) THEN
    ALTER TABLE automation_pending_steps
      DROP CONSTRAINT IF EXISTS automation_pending_steps_branch_check;
  END IF;
END $$;
