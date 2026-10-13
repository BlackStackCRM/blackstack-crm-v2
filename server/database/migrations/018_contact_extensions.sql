ALTER TABLE contacts ADD COLUMN lead_status TEXT DEFAULT 'NEW';
ALTER TABLE contacts ADD COLUMN customer_status TEXT DEFAULT 'PROSPECT';
ALTER TABLE contacts ADD COLUMN source TEXT DEFAULT 'manual';
ALTER TABLE contacts ADD COLUMN lead_score INTEGER DEFAULT 0;
ALTER TABLE contacts ADD COLUMN next_action TEXT;
ALTER TABLE contacts ADD COLUMN next_action_due DATETIME;
ALTER TABLE contacts ADD COLUMN owner_id TEXT;
