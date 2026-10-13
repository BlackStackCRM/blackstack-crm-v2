# BlackStack CRM V2 — Inventory Management Plan
*Based on existing codebase audit, not AI-generated reference*

## Status: IMPLEMENTED (core product ↔ inventory integration + fixes)
## Last Updated: 2026-09-27

## Fixes Applied
1. **Default godown seed** added to `server/database/seed.js` — creates `god_001` (Main Warehouse)
   - Required because `stock_balances.godown_id` has FK to `godowns(id)`
2. **Controller fallback** in `products.controller.js` changed from `godown_id || 'default'` → `godown_id || 'god_001'`
3. **stock_items INSERT** column count fixed (36 columns, 36 placeholders)
4. **Add Stock Item form** (`inventory-sub.js` StockItemPage.openForm) rewritten to match Products New Product form:
   - Sectioned layout: Basic Information, Pricing, Stock Settings
   - Added `<label>` + wrapping `<div>` for all fields (Name, SKU, Unit, Category, Stock Group, Brand, Model, Colour, Size, Style)
   - Added Description textarea (full-width)
   - Cost Price, Selling Rate, MRP inputs with ₹ currency prefix
   - Min Stock Level, Max Stock Level inputs
   - Batch Tracked / Serial Tracked as checkbox-style selects with labels
   - Fixed dropdown placeholder text ("Select Unit of Measure" instead of "Select uomId")
   - Premium Tailwind styling: `rounded-xl`, `px-3 py-2.5`, `bg-surface-container-low`, etc.
   - Modal size changed from `xl` → `2xl` to match products form
   - Dropdown options loaded via `API.get()` with display name resolution for edit mode
   - Removed `inventory_2` icon from Stock Items card in `inventory.js` (replaced with `warehouse`), removed description text
5. **Stock item table** (`StockItemPage.renderTable`) enhanced:
   - Added Cost, Selling, On Hand, Value, Serial, Batch, Status columns
   - Added View Product action button
6. **Stock item DELETE endpoint** added:
   - `DELETE /api/inventory/stocks/:id` route
   - `InventoryController.deleteStockItem` controller method
   - `InventoryService.deleteStockItem` service method (soft-delete via is_active=0)
   - Validates no posted vouchers reference the item before deleting
7. **Stock item create API response** standardized to `{ success: true, data: {...} }` format


---

## 1. Current Architecture (EXISTING)

### Database Schema
```text
products          ← Canonical product master (source of truth)
  id, company_id, name, sku, category, price, cost, is_active, is_service

stock_items        ← Inventory extension of products
  id, company_id, name, sku, product_id (FK → products.id),
  uom_id (FK → units_of_measure.id), category_id (FK → stock_categories.id),
  is_serial_tracked, is_batch_tracked, is_active, cost_price, mrp, selling_rate

stock_categories   ← Master data for product categories
  id, company_id, name, description, is_active

units_of_measure   ← Master data for measurement units
  id, company_id, name, symbol, decimal_places, is_active

stock_groups       ← Hierarchical product grouping
  id, company_id, name, parent_id, description

brands             ← Brand masters
  id, company_id, name, code, description

stock_balances     ← Current stock quantities
  item_id (FK → stock_items.id), company_id, quantity, avg_rate, batch_id

stock_ledger       ← Transaction history
  id, company_id, item_id, quantity, rate, batch_id, type, reference_id
```

### API Endpoints (EXISTING)
| Method | Endpoint | Controller Action | Description |
|--------|----------|-------------------|-------------|
| GET | `/api/products` | `list` | Products with joined inventory data |
| GET | `/api/products/:id` | `getOne` | Single product with nested stockItem |
| POST | `/api/products` | `create` | Create product + auto-create stock_item |
| PUT | `/api/products/:id` | `update` | Update product + sync to stock_item |
| DELETE | `/api/products/:id` | `remove` | Delete product |
| GET | `/api/inventory/stocks` | `listStockItems` | List all stock items |
| GET | `/api/inventory/stocks/product/:productId` | `getStockItemByProduct` | Stock item by product FK |
| GET | `/api/inventory/stocks/sku/:sku` | `getItemBySku` | Stock item by SKU |
| POST | `/api/inventory/stocks` | `createStockItem` | Create a new stock item (auto-creates linked product) |
| DELETE | `/api/inventory/stocks/:id` | `deleteStockItem` | Soft-delete a stock item (is_active=0) |
| GET | `/api/inventory/masters/:table` | `listMasters` | Master data CRUD |
| POST | `/api/inventory/masters/:table` | `createMaster` | Create master record |

### Frontend Pages (EXISTING)
| Page | URL | Description |
|------|-----|-------------|
| Products | `#products` | Product list + create/edit form |
| Inventory Dashboard | `#inventory` | Master/transaction/report cards |
| Inventory Master Grid | `#inventory/stocks`, `#inventory/brands`, etc. | CRUD grids for masters |

---

## 2. What Was Already Implemented

### Product ↔ Inventory Linking
✅ **Product.create:** When `track_inventory` is set, automatically creates a `stock_items` row with `product_id` FK

✅ **Product.list:** SQL JOIN with `stock_items` and `stock_balances` returns inventory fields in product list

✅ **Product.getOne:** Returns nested `stockItem` object with `on_hand_qty`, `avg_rate`, `stock_value`

✅ **Product.update:** Syncs `name`, `sku`, `price` → `selling_rate`, `cost` → `cost_price`, `is_active` to linked `stock_items`

✅ **Inventory.getStockItemByProduct:** `GET /api/inventory/stocks/product/:productId` returns stock_item + nested product

### Category Resolution
✅ When creating a product, the `category` text name (e.g., "Gaming Computers") is resolved to `stock_categories(id)` FK via:
```sql
SELECT id FROM stock_categories WHERE company_id = ? AND (id = ? OR name = ?) LIMIT 1
```

### UOM Auto-Assignment
✅ When no `uom_id` is provided, auto-assigns the first active UOM from `units_of_measure`:
```sql
SELECT id FROM units_of_measure WHERE company_id = ? AND is_active = 1 ORDER BY created_at LIMIT 1
```

### Orphaned Product Cleanup
✅ If stock_item creation fails, the product is deleted in the catch block to prevent orphaned records

---

## 3. How to Apply: Current Workflow

### Creating an Inventory-Tracked Product

#### Via Browser UI (Visible Browser)
1. Navigate to `http://localhost:3000/index.html#products`
2. Click **"New Product"** button (`#prod-new`)
3. Fill the form:
   - **Name:** Product name
   - **SKU:** Stock keeping unit
   - **Category:** Category name (e.g., "Gaming Computers")
   - **Price:** Selling price
   - **Cost:** Cost price
   - **Track Inventory:** ✅ (checkbox) → creates `stock_items` row
   - **Serial Tracked:** ✅ (checkbox) → sets `is_serial_tracked = 1`
   - **Batch Tracked:** ✅ (checkbox) → sets `is_batch_tracked = 1`
   - **Status:** Active/Inactive dropdown
4. Click **Create**
5. Backend creates:
   - `products` table row
   - `stock_items` row with:
     - `product_id` → links to product
     - `category_id` → resolved from category name
     - `uom_id` → auto-assigned from default UOM
     - `is_serial_tracked`, `is_batch_tracked` → from checkboxes
     - `cost_price`, `mrp`, `selling_rate` → from cost/price inputs
6. Product appears in table immediately

#### Via API
```bash
# Login
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@blackstack.local","password":"admin123"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['token'])")

# Create product with inventory tracking
curl -s -X POST http://localhost:3000/api/products \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Gaming Laptop",
    "sku": "ELE-LAP-0001",
    "category": "Electronics",
    "price": 1500,
    "cost": 1000,
    "track_inventory": "on",
    "is_serial_tracked": "on",
    "is_active": "1"
  }'
```

### Navigating Between Products and Inventory
- **From Product → Inventory:** Click ⋮ menu on product row → "View Inventory" → navigates to `#inventory/stocks/<stockItemId>`
- **From Inventory → Product:** Click stock item's "View Product" action → navigates to `#products/<productId>`
- **By API:** `GET /api/inventory/stocks/product/<productId>` returns the stock_item linked to that product

---

## 4. What Needs To Be Done Next

### Phase A: Serial & Batch Transaction Screens
- **Status:** NOT YET IMPLEMENTED
- **Need:** Stock Inward/Outward vouchers that handle serial & batch assignment
- **Approach:** Extend `inventory-sub.js` MasterPage to support transaction forms
- **API:** `POST /api/inventory/vouchers` already exists — needs frontend form
- **Key requirement:** Serial state machine (Available → Reserved → Sold → etc.)

### Phase B: Warehouse & Location Stock Tracking
- **Status:** Masters exist (`godowns`, `locations` tables via `/api/inventory/masters/godowns`), but stock is not yet godown-wise
- **Need:** Add `godown_id` and `location_id` to `stock_balances` for warehouse-level tracking
- **Approach:** Extend `stock_balances` table with godown/location FKs

### Phase C: Opening Stock
- **Status:** Not implemented
- **Need:** Voucher-type screen for recording initial stock balances
- **API:** `POST /api/inventory/vouchers` with type `opening_stock`
- **Frontend:** Form with quantity selection (no serial/batch for no-tracking products)

### Phase D: Stock Adjustments & Transfers
- **Status:** Not implemented (beyond basic framework)
- **Need:** Forms for stock transfer between godowns, stock adjustment with reason
- **API:** `POST /api/inventory/vouchers` supports types: `stock_inward`, `stock_outward`, `stock_transfer`, `stock_adjustment`

### Phase E: Accounting Integration
- **Status:** Basic — stock_items has account FK fields (`stock_asset_account_id`, `cogs_account_id`, etc.)
- **Need:** Wire stock transactions to existing accounting ledger
- **Check existing:** `server/routes/accounting.js` for ledger/account architecture

### Phase F: Stock Valuation Reports
- **Status:** Report endpoint exists (`/api/inventory/reports/valuation`)
- **Need:** UI screen and full FIFO/weighted-average logic in repository layer

---

## 5. What NOT To Do

Per the 70-section reference document's operating instructions:

1. **Do NOT create duplicate Product or Inventory tables** — the existing schema is sufficient
2. **Do NOT create a separate accounting engine** — use existing `accounts` and ledger
3. **Do NOT implement every feature from the reference document** — only what the existing architecture supports
4. **Do NOT auto-create purchase orders** — no auto-reorder unless explicitly required
5. **Do NOT add industry-specific columns** (RAM, Processor, etc.) — use configurable custom attributes
6. **Do NOT delete the successful test Product** — only delete if testing deletion specifically
7. **Never silently overwrite existing data** — use controlled deactivation

---

## 6. Testing Pattern (Follow This)

```text
Create Product (UI)
  → Verify in table
  → Reload browser
  → Verify still present
  → Stop server
  → Restart server
  → Reload
  → Verify persistence
  → Check stock_item via API
  → Check FK relationships in DB
  → Verify tenant isolation (different companyId)
```

Test data cleanup command:
```bash
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('./data/blackstack-crm.db'); db.exec('DELETE FROM stock_items; DELETE FROM products;')"
```

Server start:
```bash
DEMO_MODE=true DB_PATH=./data/blackstack-crm.db NODE_ENV=development PORT=3000 node server/app.js
```

Visible Chrome for E2E testing:
```bash
# Start Chrome with remote debugging
"C:/Program Files/Google/Chrome/Application/chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:/Users/BLACK STACK/AppData/Local/Google/Chrome/User/AutomationProfile"
# Then open http://localhost:3000 in it
```

---

## 7. Key Files

| File | Purpose |
|------|---------|
| `server/controllers/products.controller.js` | Product CRUD + stock_item creation/sync |
| `server/controllers/inventory.controller.js` | Stock items, masters, vouchers |
| `server/repositories/inventory.repository.js` | Inventory data access |
| `server/services/inventory.service.js` | Inventory business logic |
| `server/routes/products.js` | Product routes |
| `server/routes/inventory.js` | Inventory routes |
| `server/database/migrations/` | Schema migrations |
| `public/js/pages/products.js` | Products UI (table, form) |
| `public/js/pages/inventory.js` | Inventory dashboard |
| `public/js/pages/inventory-sub.js` | Inventory master/transaction grids |
| `public/js/api/client.js` | API client (axios wrapper) |
| `public/js/lib/utils/caseConverter.js` | snake_case → camelCase conversion |
