-- ==============================================================================
-- ATTENDPRO PRODUCTION DATABASE SECURITY SCHEMA
-- ==============================================================================
-- INSTRUCTIONS:
-- 1. Open your Supabase Dashboard
-- 2. Go to the "SQL Editor" section on the left sidebar
-- 3. Click "New Query" and paste this entire file
-- 4. Click "Run" (this will eliminate the major backend vulnerabilities)
-- ==============================================================================

-- 1. Create the attendance table (if you haven't already, or alter to add security)
CREATE TABLE IF NOT EXISTS public.attendance (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    date DATE NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'holiday', 'medical')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, date)
);

-- 2. ENABLE ROW LEVEL SECURITY (CRITICAL VULNERABILITY FIX)
-- This ensures that a malicious user cannot access or modify other users' data 
-- even if they have the public anonymous key.
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;

-- 3. DROP EXISTING POLICIES (Just in case you are re-running this script)
DROP POLICY IF EXISTS "Users can view their own attendance" ON public.attendance;
DROP POLICY IF EXISTS "Users can insert their own attendance" ON public.attendance;
DROP POLICY IF EXISTS "Users can update their own attendance" ON public.attendance;
DROP POLICY IF EXISTS "Users can delete their own attendance" ON public.attendance;

-- 4. CREATE POLICIES

-- Policy: Select (Users can only see rows where the user_id matches their auth ID)
CREATE POLICY "Users can view their own attendance"
ON public.attendance FOR SELECT
USING (auth.uid() = user_id);

-- Policy: Insert (Users can only insert rows with their own user_id)
CREATE POLICY "Users can insert their own attendance"
ON public.attendance FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Policy: Update (Users can only update rows where the user_id matches their auth ID)
CREATE POLICY "Users can update their own attendance"
ON public.attendance FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Policy: Delete (Users can only delete their own rows)
CREATE POLICY "Users can delete their own attendance"
ON public.attendance FOR DELETE
USING (auth.uid() = user_id);

-- ==============================================================================
-- DONE! Your database is now secured.
-- ==============================================================================
