-- Migration: Add name column to contacts table
-- Run this in Railway PostgreSQL console if the table already exists

-- Check if column exists before adding
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'contacts' AND column_name = 'name'
    ) THEN
        -- Add name column with temporary default
        ALTER TABLE contacts ADD COLUMN name VARCHAR(255) DEFAULT 'Anonymous';

        -- Remove default constraint
        ALTER TABLE contacts ALTER COLUMN name DROP DEFAULT;

        RAISE NOTICE 'Name column added successfully';
    ELSE
        RAISE NOTICE 'Name column already exists';
    END IF;
END $$;

-- Verify the change
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'contacts'
ORDER BY ordinal_position;
