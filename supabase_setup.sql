-- ==============================================================================
-- ATTENDPRO — DATABASE SETUP & MIGRATION
-- Version 5.0 — Historical Import + Reset Feature
-- ==============================================================================
--
-- INSTRUCTIONS:
--   1. Open your Supabase Dashboard → SQL Editor → New Query
--   2. Paste this entire file and click Run
--
-- SAFETY — NON-DESTRUCTIVE:
--   • All existing attendance records are preserved.
--   • New columns use IF NOT EXISTS / DEFAULT so existing rows are unaffected.
--   • The UPDATE for legacy half_day rows is a no-op if already migrated.
--   • New tables use CREATE TABLE IF NOT EXISTS.
--
-- CHANGES IN v5.0:
--   • attendance.source column added (TEXT DEFAULT 'manual')
--   • historical_summary table created for preserving reported percentages
-- ==============================================================================


-- ==============================================================================
-- STEP 1 — CREATE ATTENDANCE TABLE (only if it does not already exist)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.attendance (
    id          UUID                     DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID                     NOT NULL
                    REFERENCES auth.users(id) ON DELETE CASCADE,
    date        DATE                     NOT NULL,
    status      TEXT                     NOT NULL,
    duration    TEXT                     NOT NULL DEFAULT 'full',
    source      TEXT                     NOT NULL DEFAULT 'manual',
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT attendance_user_date_unique UNIQUE (user_id, date)
);

-- ==============================================================================
-- STEP 2 — ADD MISSING COLUMNS TO EXISTING TABLE
-- ==============================================================================

-- duration column (added in v4.0)
ALTER TABLE public.attendance
    ADD COLUMN IF NOT EXISTS duration TEXT NOT NULL DEFAULT 'full';

-- source column (new in v5.0): 'manual' | 'historical_import'
ALTER TABLE public.attendance
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

-- ==============================================================================
-- STEP 3 — MIGRATE LEGACY half_day RECORDS (idempotent — safe to re-run)
-- ==============================================================================

UPDATE public.attendance
SET    status   = 'present',
       duration = 'half'
WHERE  status   = 'half_day';

-- ==============================================================================
-- STEP 4 — UPDATE / ADD CHECK CONSTRAINTS
-- ==============================================================================

ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS attendance_status_check;
ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS status_check;
ALTER TABLE public.attendance
    ADD CONSTRAINT attendance_status_check
    CHECK (status IN ('present', 'absent', 'holiday', 'medical'));

ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS attendance_duration_check;
ALTER TABLE public.attendance
    ADD CONSTRAINT attendance_duration_check
    CHECK (duration IN ('full', 'half'));

ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS attendance_source_check;
ALTER TABLE public.attendance
    ADD CONSTRAINT attendance_source_check
    CHECK (source IN ('manual', 'historical_import'));

-- ==============================================================================
-- STEP 5 — ENABLE ROW LEVEL SECURITY ON ATTENDANCE
-- ==============================================================================

ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;

-- ==============================================================================
-- STEP 6 — ATTENDANCE RLS POLICIES
-- ==============================================================================

DROP POLICY IF EXISTS "Users can view their own attendance"   ON public.attendance;
DROP POLICY IF EXISTS "Users can insert their own attendance" ON public.attendance;
DROP POLICY IF EXISTS "Users can update their own attendance" ON public.attendance;
DROP POLICY IF EXISTS "Users can delete their own attendance" ON public.attendance;
DROP POLICY IF EXISTS "Users can upsert their own attendance" ON public.attendance;

CREATE POLICY "Users can view their own attendance"
    ON public.attendance FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own attendance"
    ON public.attendance FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own attendance"
    ON public.attendance FOR UPDATE
    USING      (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own attendance"
    ON public.attendance FOR DELETE
    USING (auth.uid() = user_id);

-- ==============================================================================
-- STEP 7 — PERFORMANCE INDEX ON ATTENDANCE
-- ==============================================================================

CREATE INDEX IF NOT EXISTS attendance_user_date_idx
    ON public.attendance (user_id, date ASC);

-- ==============================================================================
-- STEP 8 — HISTORICAL SUMMARY TABLE (new in v5.0)
--
-- Stores the user's school-reported attendance percentage for a historical
-- period. This preserves the authoritative reported figure even when the
-- generated daily records cannot reproduce it exactly with whole/half days.
--
-- UNIQUE on user_id: one historical summary per user at a time.
-- If the user re-imports, the row is upserted (replaced).
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.historical_summary (
    id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id              UUID NOT NULL
                             REFERENCES auth.users(id) ON DELETE CASCADE,
    start_date           DATE NOT NULL,
    end_date             DATE NOT NULL,
    reported_attendance  NUMERIC(5,2) NOT NULL,   -- e.g. 72.50
    total_school_days    NUMERIC(6,1) NOT NULL,   -- e.g. 90.0
    medical_leave_days   NUMERIC(6,1) NOT NULL DEFAULT 0,
    source               TEXT NOT NULL DEFAULT 'historical_import',
    created_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT historical_summary_user_unique UNIQUE (user_id)
);

-- ==============================================================================
-- STEP 9 — RLS ON HISTORICAL SUMMARY
-- ==============================================================================

ALTER TABLE public.historical_summary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own summary"   ON public.historical_summary;
DROP POLICY IF EXISTS "Users can insert their own summary" ON public.historical_summary;
DROP POLICY IF EXISTS "Users can update their own summary" ON public.historical_summary;
DROP POLICY IF EXISTS "Users can delete their own summary" ON public.historical_summary;

CREATE POLICY "Users can view their own summary"
    ON public.historical_summary FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own summary"
    ON public.historical_summary FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own summary"
    ON public.historical_summary FOR UPDATE
    USING      (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own summary"
    ON public.historical_summary FOR DELETE
    USING (auth.uid() = user_id);

-- ==============================================================================
-- STEP 10 — GRANT PERMISSIONS
-- ==============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.historical_summary TO authenticated;

-- ==============================================================================
-- VERIFICATION QUERIES
-- ==============================================================================
--
-- 1. Confirm attendance columns:
--    SELECT column_name, data_type, column_default
--    FROM information_schema.columns
--    WHERE table_name = 'attendance'
--    ORDER BY ordinal_position;
--
-- 2. Confirm no legacy half_day rows remain:
--    SELECT COUNT(*) FROM public.attendance WHERE status = 'half_day';
--    -- Expected: 0
--
-- 3. Confirm historical_summary table exists:
--    SELECT COUNT(*) FROM public.historical_summary;
--
-- 4. Confirm source check constraint:
--    SELECT conname, pg_get_constraintdef(oid)
--    FROM pg_constraint
--    WHERE conrelid = 'public.attendance'::regclass AND contype = 'c';
--
-- ==============================================================================


-- ==============================================================================
-- ATTENDANCE MODEL REFERENCE (v5.0)
-- ==============================================================================
--
--   attendance columns:
--     id, user_id, date, status, duration, source, created_at
--
--   Valid status values:  present | absent | holiday | medical
--   Valid duration values: full | half
--   Valid source values:  manual | historical_import
--
--   historical_summary stores the user's school-reported figure, e.g.:
--     reported_attendance: 72.50
--     total_school_days:   90
--     medical_leave_days:  13
--
--   The Reset feature deletes:
--     DELETE FROM attendance      WHERE user_id = $1
--     DELETE FROM historical_summary WHERE user_id = $1
--
-- ==============================================================================
-- END OF SCRIPT
-- ==============================================================================
