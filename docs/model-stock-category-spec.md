# Model — Stock Category Relationship Specification

**Module:** Inventory Management — Model Master  
**Version:** 1.0  
**Date:** 2026-09-27  
**Status:** Implemented & E2E Verified  

---

## 1. Overview

When creating or editing a **Model**, the user must select an **already-existing Stock Category**. This establishes the full relational hierarchy:

```
Stock Group
    └── Stock Category
          └── Model
```

Each Model stores a foreign key reference (`stock_category_id`) to its parent Stock Category. The Model form **only selects** from existing Stock Categories — it does **not** create new ones.

---

## 2. Data Model

### 2.1 `models` Table Schema (Post-Migration 077)

| Column               | Type    | Nullable | Default | Description                          |
|----------------------|---------|----------|---------|--------------------------------------|
| `id`                 | TEXT    | NOT NULL | —       | Primary key (generateId prefixed)    |
| `company_id`         | TEXT    | NOT NULL | default | Company scoping                      |
| `name`               | TEXT    | NOT NULL | —       | Model name (UNIQUE per company)      |
| `brand_id`           | TEXT    | NULL     | NULL    | FK → `brands(id)` ON DELETE SET NULL |
| `stock_category_id`  | TEXT    | NULL     | NULL    | **FK → `stock_categories(id)` ON DELETE SET NULL** |
| `description`        | TEXT    | NULL     | NULL    | Optional description                 |
| `is_active`          | INTEGER | NULL     | 1       | Soft delete / active flag            |
| `created_at`         | DATETIME| NULL     | now()   | Audit: creation timestamp            |
| `updated_at`         | DATETIME| NULL     | now()   | Audit: last update timestamp         |
| `created_by`         | TEXT    | NULL     | NULL    | Audit: creator user                  |
| `updated_by`         | TEXT    | NULL     | NULL    | Audit: last modifier user            |

### 2.2 Foreign Key Constraints

```sql
FOREIGN KEY (brand_id)          REFERENCES brands(id)          ON DELETE SET NULL
FOREIGN KEY (stock_category_id) REFERENCES stock_categories(id) ON DELETE SET NULL
UNIQUE(company_id, name)
```

### 2.3 Indexes

| Index Name             | Table   | Column             | Purpose                          |
|------------------------|---------|--------------------|----------------------------------|
| `idx_models_category`  | models  | stock_category_id  | JOIN performance (Category → Model) |
| `idx_models_brand`     | models  | brand_id           | JOIN performance (Brand → Model) |

---

## 3. Field Definition: `stock_category_id`

| Attribute     | Value                          |
|---------------|--------------------------------|
| **Name**      | `stock_category_id`            |
| **Purpose**   | Links a Model to its parent Stock Category |
| **Required**  | Yes (on Model create/edit)     |
| **Data Type** | TEXT (UUID-style string, e.g. `stoc_01M3J1EVXX8K1VT9V7F5B2D5W6`) |
| **Validation**| Must reference an existing `stock_categories.id` in the same `company_id` |
| **Default**   | NULL (for backward compat with pre-existing models) |
| **Dependencies** | Stock Category must already exist; Stock Category → Stock Group hierarchy must be maintained |

---

## 4. API Endpoints

### 4.1 List Models with Joined Data

```
GET /api/inventory/masters/models?limit=20&offset=0&query=<search>
```

**Response (camelCase):**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "mode_01...",
        "name": "iPhone 15 Pro",
        "stockCategoryId": "stoc_01...",
        "stockCategoryName": "Smartphones",
        "stockGroupName": "Electronics",
        "brandId": "bran_01...",
        "brandName": "Apple",
        "description": "Latest model",
        "isActive": 1,
        ...
      }
    ],
    "total": 1
  }
}
```

### 4.2 Get Single Model

```
GET /api/inventory/masters/models/{id}
```

Returns the model with joined `stockCategoryName`, `stockGroupName`, `brandName`.

### 4.3 Create Model

```
POST /api/inventory/masters/models
```

**Request Body (camelCase, converted to snake_case by middleware):**
```json
{
  "name": "Galaxy S24",
  "stockCategoryId": "stoc_01...",  // REQUIRED
  "brandId": "bran_01...",          // optional
  "description": "Samsung flagship"
}
```

**Validation:**
- `stock_category_id` must be present → `ValidationError` if missing
- `stock_category_id` must reference an existing category in the same company

### 4.4 Update Model

```
PUT /api/inventory/masters/models/{id}
```

Same body validation as create. Pre-existing `stock_category_id` is pre-selected in the edit form.

---

## 5. Database Migration

### 077: `model_stock_category_hierarchy.sql`

**Operation:** Table rebuild (SQLite cannot add inline FK via ALTER TABLE ADD COLUMN)

1. Back up existing `models` data (all columns from migration 070 schema)
2. Drop and recreate `models` table with `stock_category_id TEXT` + FK constraint
3. Restore data with `stock_category_id = NULL` for pre-existing models
4. Create index on `stock_category_id`
5. Enable `foreign_keys = ON`

**Idempotency:** Runs once via `schema_migrations` table (version + SHA256 tracking).

---

## 6. Backend Service Logic

### `inventory.service.js`

| Method | Behavior for `models` |
|--------|----------------------|
| `listMasters()` | Routes to `repo.listModels()` — JOINs with `stock_categories` + `stock_groups` |
| `getMaster()` | Routes to `repo.findModelWithJoin()` — single record with parent names |
| `createMaster()` | Validates `stock_category_id` is present (required), then delegates to `repo.create()` |
| `updateMaster()` | Delegates to `repo.update()` (data integrity via FK constraint) |
| `deleteMaster()` | Calls `validator.validateMasterNotReferenced()` — blocks if Models reference the Category |

### `inventory.repository.js`

| Method | SQL Pattern |
|--------|-------------|
| `listModels()` | `SELECT m.*, sc.name AS stock_category_name, sg.name AS stock_group_name FROM models m LEFT JOIN stock_categories sc ON m.stock_category_id = sc.id LEFT JOIN stock_groups sg ON sc.stock_group_id = sg.id WHERE m.company_id = ? [AND m.is_active = ?] [AND m.name LIKE ?] ORDER BY m.created_at DESC LIMIT ? OFFSET ?` |
| `findModelWithJoin()` | Same JOIN as above, single record by `id` |
| `list()` (generic) | Adds `stock_category_id` filter for `models` table (for search/filter) |

### `inventory.validator.js`

| Method | Behavior |
|--------|----------|
| `validateMasterNotReferenced('stock_categories', id, companyId)` | Checks `stock_items.category_id` **AND** `models.stock_category_id` — throws if either references the category |

---

## 7. Frontend UI Behavior

### 7.1 Create Model Form

```
┌─────────────────────────────────────────┐
│  Add Model                              │
├─────────────────────────────────────────┤
│  Model Name *       [_______________]  │
│  Brand               [▼ Select Brand  ] │  ← dynamic dropdown from /stock_categories... wait, /brands
│  Stock Category *   [▼ Select ...     ] │  ← REQUIRED, dynamic dropdown
│                                      ↓ │
│  Description         [_________________]│
│                      [_________________]│
├─────────────────────────────────────────┤
│  [Cancel]  [Create Model]               │
└─────────────────────────────────────────┘
```

**Dropdown behavior:**
- Calls `GET /api/inventory/masters/stock_categories?limit=200` on form open
- Displays existing Stock Categories only (no inline creation)
- Empty state: "No Stock Categories available" if none exist
- `required` attribute enforced — form won't submit without selection

### 7.2 Edit Model Form

- Opens with current `stock_category_id` pre-selected in the dropdown
- Displays current value as text below the dropdown for reference
- User can change to another existing Stock Category
- Save via `PUT /api/inventory/masters/models/{id}`

### 7.3 Model List / Table View

| Column | Source |
|--------|--------|
| Model Name | `models.name` |
| Brand | `brands.name` (JOIN) |
| **Stock Category** | `stock_categories.name` (JOIN) — **new column** |
| Stock Group | `stock_groups.name` (JOIN, hidden by default) |
| Description | `models.description` |
| Status | `models.is_active` (Active/Inactive) |

### 7.4 ModelPage Class Architecture

```
ModelPage extends MasterPage
├── constructor() → sets apiBase = '/api/inventory/masters/models'
├── load() → fetches models with JOIN, maps camelCase fields
├── renderTable() → columns: Name, Brand, Stock Category, Stock Group(hidden), Description(hidden), Status, Actions
├── openForm(row) → opens modal with Stock Category required dropdown
│   ├── Loads stock_categories dynamically (limit=200)
│   ├── Loads brands dynamically (limit=200)
│   ├── Pre-selects current category on edit (handles snake_case + camelCase)
│   └── Submits via POST (create) / PUT (update)
└── _resolveName() → resolves display name for edit mode
```

---

## 8. Validation Tables

### 8.1 Create/Edit Model Validation

| Field | Rule | Error Message |
|-------|------|---------------|
| `name` | Required, non-empty | "Model Name is required" |
| `stock_category_id` | Required, must reference existing category | "stock_category_id is required — every Model must belong to a Stock Category" |
| `name` | Unique per company | "Model name already exists" (UNIQUE constraint) |
| `brand_id` | If provided, must reference existing brand | FK constraint |

### 8.2 Delete Stock Category Validation (V16)

| Condition | Behavior |
|-----------|----------|
| Stock Category referenced by Models | Deletion blocked: "Cannot delete this record because it is referenced by Models or Stock Items. Use Deactivate instead." |
| Stock Category referenced by Stock Items | Deletion blocked: same message |
| No references | Deletion allowed (soft-delete) |

---

## 9. User Workflows

### 9.1 Full Hierarchy Creation Flow

```
1. Create Stock Group (e.g., "Electronics")
   → Stock Group saved to stock_groups table

2. Create Stock Category (e.g., "Smartphones") assigned to "Electronics"
   → Stock Category saved with stock_group_id FK

3. Create Model (e.g., "iPhone 15 Pro")
   → Stock Category dropdown shows "Smartphones" (loaded from existing data)
   → User selects "Smartphones" (required)
   → Model saved with stock_category_id = <category.id>

4. View Model List
   → Table shows: Model Name | Brand | Stock Category | Stock Group | ...
```

### 9.2 Edit Model Stock Category

```
1. Open Model list → click Edit on a Model
2. Form opens with current Stock Category pre-selected
3. User changes selection to a different existing Stock Category
4. Click "Save Changes" → PUT request sent
5. Table refreshes, new Stock Category name appears
```

### 9.3 Search/Filter by Stock Category

```
GET /api/inventory/masters/models?stock_category_id=<cat_id>
→ Returns only models belonging to that Stock Category
```

---

## 10. QA Test Cases

### Test Suite: `tests/model-stock-category-e2e.js`

| # | Test Scenario | Expected Result | Status |
|---|--------------|-----------------|--------|
| 1 | Create Stock Group | Visible in table | ✅ PASS |
| 2 | Create Stock Category under group | Visible, Stock Group column shows correct group | ✅ PASS |
| 3 | Create 2nd Stock Category | Both exist | ✅ PASS |
| 4 | Open Create Model form | Stock Category dropdown present | ✅ PASS |
| 5 | Stock Category dropdown has `required` attr | `required` attribute is set | ✅ PASS |
| 6 | Dropdown has dynamic options | 13 options (11 seeded + 2 created) | ✅ PASS |
| 7 | Created category appears in dropdown | Text match found | ✅ PASS |
| 8 | Submit Model without Stock Category | Form rejected, model NOT created | ✅ PASS |
| 9 | Create Model with Stock Category | Model created, visible in table | ✅ PASS |
| 10 | Table shows Stock Category column | Category name visible in row | ✅ PASS |
| 11 | DB: Model has correct FK | `stock_category_id` matches | ✅ PASS |
| 12 | Hierarchy JOIN works | Model → Category → Group query succeeds | ✅ PASS |
| 13 | Edit form pre-selects category | Select value matches current FK | ✅ PASS |
| 14 | Change category and save | Table shows new category | ✅ PASS |
| 15 | DB shows updated FK | `stock_category_id` updated | ✅ PASS |
| 16 | No duplicate categories | Exactly 2 categories exist | ✅ PASS |
| 17 | Cleanup | All E2E records removed from DB | ✅ PASS |

**Result: 17 passed, 0 failed**

---

## 11. Worked Example

### Scenario: Creating a Model under "Electronics > Smartphones"

```
-- 1. Create Stock Group
POST /api/inventory/masters/stock_groups
{ "name": "Electronics", "description": "Electronic items" }

-- 2. Create Stock Category under Electronics
POST /api/inventory/masters/stock_categories
{ "name": "Smartphones", "stock_group_id": "stoc_01GR..." }

-- 3. Create Model under Smartphones
POST /api/inventory/masters/models
{ "name": "iPhone 15 Pro", "stock_category_id": "stoc_01M3..." }

-- 4. Query: Get model with full hierarchy
GET /api/inventory/masters/models
Response:
{
  "items": [
    {
      "id": "mode_01...",
      "name": "iPhone 15 Pro",
      "stockCategoryId": "stoc_01M3...",
      "stockCategoryName": "Smartphones",
      "stockGroupName": "Electronics",
      "brandName": "—",
      ...
    }
  ]
}

-- 5. Hierarchy verification (SQL):
SELECT m.name, sc.name, sg.name
FROM models m
JOIN stock_categories sc ON m.stock_category_id = sc.id
JOIN stock_groups sg ON sc.stock_group_id = sg.id
WHERE m.name = 'iPhone 15 Pro';
-- → iPhone 15 Pro | Smartphones | Electronics
```

---

## 12. Backward Compatibility & Non-Regression

- **Pre-existing Model fields**: All unchanged (`id`, `name`, `brand_id`, `description`, `is_active`, audit columns)
- **Stock Category creation**: Unchanged — still requires a Stock Group
- **Stock Group creation**: Unchanged
- **Existing Model records**: `stock_category_id` defaults to NULL (no data loss)
- **Other masters**: Unaffected (brands, colours, sizes, styles, etc.)

---

## 13. Files Modified

| File | Change Type |
|------|-------------|
| `server/database/migrations/077_model_stock_category_hierarchy.sql` | **NEW** — migration |
| `server/services/inventory.service.js` | Modified — models list/get/create with joins |
| `server/repositories/inventory.repository.js` | Modified — `listModels()`, `findModelWithJoin()`, `stock_category_id` filter |
| `server/validators/inventory.validator.js` | Modified — category deletion check includes models |
| `public/js/pages/inventory-sub.js` | Modified — `ModelPage` class, init routing |
| `tests/model-stock-category-e2e.js` | **NEW** — E2E test suite |
