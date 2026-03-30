ALTER TABLE account_billing ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;
ALTER TABLE account_billing ADD COLUMN IF NOT EXISTS onboarding_skipped boolean NOT NULL DEFAULT false;
