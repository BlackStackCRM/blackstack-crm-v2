-- Migration 079: Remove soft-delete columns for permanent deletion
-- All deletions in the CRM are now permanent (physical DELETE).
-- This migration removes deleted_at, deleted_by, delete_reason, version
-- from all tables that previously supported soft-delete.
-- Uses ALTER TABLE DROP COLUMN (available since SQLite 3.35.0).

PRAGMA foreign_keys = ON;

-- Drop indexes that reference the soft-delete columns
DROP INDEX IF EXISTS idx_contacts_deleted_at;
DROP INDEX IF EXISTS idx_organizations_deleted_at;
DROP INDEX IF EXISTS idx_leads_deleted_at;
DROP INDEX IF EXISTS idx_deals_deleted_at;
DROP INDEX IF EXISTS idx_products_deleted_at;
DROP INDEX IF EXISTS idx_tasks_deleted_at;
DROP INDEX IF EXISTS idx_notes_deleted_at;
DROP INDEX IF EXISTS idx_appointments_deleted_at;
DROP INDEX IF EXISTS idx_pipelines_deleted_at;

-- ── contacts ──
ALTER TABLE contacts DROP COLUMN deleted_at;
ALTER TABLE contacts DROP COLUMN deleted_by;
ALTER TABLE contacts DROP COLUMN delete_reason;
ALTER TABLE contacts DROP COLUMN version;
ALTER TABLE contacts DROP COLUMN updated_by;

-- ── organizations ──
ALTER TABLE organizations DROP COLUMN deleted_at;
ALTER TABLE organizations DROP COLUMN deleted_by;
ALTER TABLE organizations DROP COLUMN delete_reason;
ALTER TABLE organizations DROP COLUMN version;
ALTER TABLE organizations DROP COLUMN updated_by;

-- ── leads ──
ALTER TABLE leads DROP COLUMN deleted_at;
ALTER TABLE leads DROP COLUMN deleted_by;
ALTER TABLE leads DROP COLUMN delete_reason;
ALTER TABLE leads DROP COLUMN version;
ALTER TABLE leads DROP COLUMN updated_by;

-- ── deals ──
ALTER TABLE deals DROP COLUMN deleted_at;
ALTER TABLE deals DROP COLUMN deleted_by;
ALTER TABLE deals DROP COLUMN delete_reason;
ALTER TABLE deals DROP COLUMN version;
ALTER TABLE deals DROP COLUMN updated_by;

-- ── products ──
ALTER TABLE products DROP COLUMN deleted_at;
ALTER TABLE products DROP COLUMN deleted_by;
ALTER TABLE products DROP COLUMN delete_reason;
ALTER TABLE products DROP COLUMN version;
ALTER TABLE products DROP COLUMN updated_by;

-- ── tasks ──
ALTER TABLE tasks DROP COLUMN deleted_at;
ALTER TABLE tasks DROP COLUMN deleted_by;
ALTER TABLE tasks DROP COLUMN delete_reason;
ALTER TABLE tasks DROP COLUMN version;
ALTER TABLE tasks DROP COLUMN updated_by;

-- ── appointments ──
ALTER TABLE appointments DROP COLUMN deleted_at;
ALTER TABLE appointments DROP COLUMN deleted_by;
ALTER TABLE appointments DROP COLUMN delete_reason;
ALTER TABLE appointments DROP COLUMN version;
ALTER TABLE appointments DROP COLUMN updated_by;

-- ── pipelines ──
ALTER TABLE pipelines DROP COLUMN deleted_at;
ALTER TABLE pipelines DROP COLUMN deleted_by;
ALTER TABLE pipelines DROP COLUMN delete_reason;
ALTER TABLE pipelines DROP COLUMN version;
ALTER TABLE pipelines DROP COLUMN updated_by;

-- ── workflow_definitions ──
ALTER TABLE workflow_definitions DROP COLUMN deleted_at;
ALTER TABLE workflow_definitions DROP COLUMN deleted_by;
ALTER TABLE workflow_definitions DROP COLUMN delete_reason;
ALTER TABLE workflow_definitions DROP COLUMN version;
ALTER TABLE workflow_definitions DROP COLUMN updated_by;

-- ── relationships ──
ALTER TABLE relationships DROP COLUMN deleted_at;
ALTER TABLE relationships DROP COLUMN deleted_by;
ALTER TABLE relationships DROP COLUMN delete_reason;
ALTER TABLE relationships DROP COLUMN version;
ALTER TABLE relationships DROP COLUMN updated_by;

-- ── notes ──
ALTER TABLE notes DROP COLUMN deleted_at;
ALTER TABLE notes DROP COLUMN deleted_by;
ALTER TABLE notes DROP COLUMN delete_reason;
ALTER TABLE notes DROP COLUMN version;
ALTER TABLE notes DROP COLUMN updated_by;
