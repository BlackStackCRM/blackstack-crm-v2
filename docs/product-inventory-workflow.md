# Product & Inventory Management Workflow — Blackstack CRM V2

## Overview

Products and Inventory in Blackstack CRM V2 share a **single canonical Product Master**.
Every product can optionally become a **Stock Item** (inventory-enabled) with a FK
link (`product_id`). There is no duplicate product database — the `products` table
is the source of truth, and `stock_items` extends it with inventory-specific fields.

---

## 1. Product Master (`/#products`)

**Entry point:** Navigate to `#products` from the left sidebar.

### Product Table Columns
| Column | Source | Notes |
|--------|--------|-------|
| Name | `products.name` | Clickable link → product detail page |
| SKU | `products.sku` | Monospace font |
| Category | `products.category` | Free-text field (e.g., "Gaming Computers") |
| Price | `products.price` | Formatted as currency |
| Cost | `products.cost` | Formatted as currency |
| Margin | Calculated | `(price - cost) / price * 100` |
| Status | `products.is_active` | Badge: Active / Inactive |

### Actions
- **New Product** (`#prod-new` button): Opens a modal form
- **Row menu** (⋮): Edit, Activate/Deactivate, Delete
- **View Inventory** (row menu): Navigates to `#inventory/stocks/<stockItemId>`

### Product Form (New/Edit Modal)
Fields:
- **Name** *(required)* — `input[name="name"]`
- **SKU** — `input[name="sku"]`
- **Category** — `input[name="category"]` (text, not FK dropdown)
- **Price** — `input[name="price"]` (number)
- **Cost** — `input[name="cost"]` (number)

#### Inventory Settings (collapsible section)
- **Track Inventory** — `input[name="track_inventory"]` (checkbox)
  - When checked → backend creates a `stock_items` row linked to this product
- **Serial Tracked** — `input[name="is_serial_tracked"]` (checkbox)
  - When checked → `is_serial_tracked = 1` on the stock_item
- **Batch Tracked** — `input[name="is_batch_tracked"]` (checkbox)
  - When checked → `is_batch_tracked = 1` on the stock_item

#### Status
- **Active/Inactive** — `select[name="is_active"]` (dropdown: "1" = Active, "0" = Inactive)

### Form Submission Flow
1. User clicks **Create** or **Save**
2. Frontend converts checkbox values: `"on"` → `1`, unchecked → `0`
3. `POST /api/products` (create) or `PUT /api/products/:id` (edit)
4. Backend:
   - Inserts/updates the `products` table
   - If `track_inventory` is set → creates/updates linked `stock_items` row
   - Resolves `category` text → `stock_categories(id)` FK via lookup query
   - Auto-assigns default `uom_id` from `units_of_measure` if not provided
5. On success → toast notification, modal closes, table reloads

---

## 2. Inventory Management (`/#inventory`)

**Entry point:** Navigate to `#inventory` from the left sidebar.

### Dashboard Structure
The inventory page is a **dashboard** with 4 sections, each containing cards:

1. **Inventory Masters** — Stock Groups, Stock Categories, Stock Items, Units of Measure,
   Compound Units, Alternate Units, Brand, Model, Colour, Size, Style, Rate, Price Levels

2. **Storage & Locations** — Godowns, Locations

3. **Batch & Tracking** — Batches, Batch-wise Stock, Batch Management, Expiry Management,
   Manufacturing Date, Expiry Date, Serial Number Tracking, Godown-wise Stock,
   Location-wise Stock, Batch-wise Stock

4. **Stock Transactions** — Opening Stock, Stock Inward, Stock Outward, Stock Transfer,
   Stock Adjustment, Physical Stock, Stock Journal

5. **Reports** — Stock Valuation

### Card Click Flow
Clicking a card dispatches to `handleCardClick()` in `inventory.js`:
- **Master cards** (e.g., "Stock Items", "Brands"): Navigate to `#inventory/stocks`,
  `#inventory/brands`, etc. → renders a master grid via `inventory-sub.js`
- **Report cards** (e.g., "Stock Valuation"): Navigate to `#inventory/reports/stock_valuation`
  → fetches report data from report API endpoints
- **Transaction cards** (e.g., "Stock Inward"): Navigate to
  `#inventory/stocks/inward` → opens a voucher form

### Master Grid (e.g., Stock Items)
When navigating to `#inventory/stocks`:
1. Fetches `GET /api/inventory/stocks?limit=20&offset=0`
2. Renders a DataTable with columns:
   - Name, SKU, Product, Category, UOM, Batch/Serial flags, On Hand Qty, Avg Rate, Stock Value
3. Each row has: Edit, Delete, View Product actions
4. **View Product** action → navigates to `#products/<productId>`

---

## 3. Product ↔ Inventory Relationship

```
Product (products table)
   ↓ (product_id FK)
Stock Item (stock_items table)
   ↓ (item_id FK)
Stock Balance (stock_balances table)
   ↓
Stock Transactions (stock_ledger table)
```

### Key Integration Points

| From Product Page | Action | Result |
|-------------------|--------|--------|
| Create product with `track_inventory=on` | → | `stock_items` row created with `product_id` set |
| Product edit (name/sku/price/cost change) | → | Linked `stock_items` row updated automatically |
| Row menu → "View Inventory" | → | Opens `#inventory/stocks/<stockItemId>` |

| From Inventory Page | Action | Result |
|---------------------|--------|--------|
| View Stock Items grid | → | Shows all stock_items with product info via `product_id` join |
| Stock item row → "View Product" | → | Opens `#products/<productId>` |
| `GET /api/inventory/stocks/product/:productId` | → | Returns the stock_item linked to a product |

---

## 4. API Endpoints

### Products (`/api/products`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/products` | List products (with inventory joins) |
| GET | `/api/products/:id` | Get single product (with nested `stockItem`) |
| POST | `/api/products` | Create product (auto-creates `stock_items` if `track_inventory`) |
| PUT | `/api/products/:id` | Update product (syncs to `stock_items`) |
| DELETE | `/api/products/:id` | Delete product |

### Inventory (`/api/inventory/stocks`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/inventory/stocks` | List all stock items with balances |
| GET | `/api/inventory/stocks?product_id=:pid` | List items by product |
| GET | `/api/inventory/stocks/product/:productId` | Get single stock item by product |
| GET | `/api/inventory/stocks/sku/:sku` | Get stock item by SKU |
| POST | `/api/inventory/stocks` | Create stock item independently |

### Inventory Masters (`/api/inventory/masters/:table`)
| Master | Description |
|--------|-------------|
| `stock_groups` | Hierarchical product grouping |
| `stock_categories` | Category classification |
| `units_of_measure` | UOM definitions (e.g., "Nos", "Box") |
| `compound_units` | Compound UOM with base unit + quantity |
| `alternate_units` | Alternate UOM with conversion factor |
| `brands` | Brand masters |
| `models` | Model masters (linked to brand) |
| `colours` | Colour masters |
| `sizes` | Size masters |
| `styles` | Style masters |
| `rate` | Rate definitions |
| `price_levels` | Price level configurations |

---

## 5. Database Schema (Key Tables)

### `products`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | `prod_...` |
| `company_id` | TEXT | Tenant ID |
| `name` | TEXT | Product name |
| `description` | TEXT | Optional description |
| `category` | TEXT | Category name (free text, resolved to FK) |
| `sku` | TEXT (UNIQUE) | Stock Keeping Unit |
| `price` | REAL | Selling price |
| `cost` | REAL | Cost price |
| `tax_rate` | REAL | Tax rate (%) |
| `is_service` | INTEGER | 1 if service, 0 if physical |
| `is_active` | INTEGER | 0/1 |
| `is_batch_tracked` | INTEGER | Batch tracking flag |
| `is_serial_tracked` | INTEGER | Serial tracking flag |
| `created_at` | DATETIME | |
| `updated_at` | DATETIME | |

### `stock_items`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | `stoc_...` |
| `company_id` | TEXT | Tenant ID |
| `name` | TEXT | Stock item name (mirrors product name) |
| `sku` | TEXT | SKU (mirrors product SKU) |
| `product_id` | TEXT (FK → products.id) | Links to canonical product |
| `uom_id` | TEXT (FK → units_of_measure.id) | Default UOM |
| `category_id` | TEXT (FK → stock_categories.id) | Resolved category |
| `brand_id` | TEXT (FK → brands.id) | Optional brand |
| `is_batch_tracked` | INTEGER | 0/1 |
| `is_serial_tracked` | INTEGER | 0/1 |
| `is_active` | INTEGER | 0/1 |
| `cost_price` | REAL | Cost price |
| `mrp` | REAL | Maximum retail price |
| `selling_rate` | REAL | Selling rate |
| `min_stock_level` | REAL | Reorder level |
| `max_stock_level` | REAL | Maximum level |
| `UNIQUE(company_id, sku)` | | |
| `UNIQUE(company_id, name)` | | |

### `stock_balances`
| Column | Type | Description |
|--------|------|-------------|
| `item_id` | TEXT (FK → stock_items.id) | |
| `company_id` | TEXT | Tenant ID |
| `quantity` | REAL | On-hand quantity |
| `avg_rate` | REAL | Average cost |
| `batch_id` | TEXT | NULL for non-batch items |

---

## 6. User Workflow: Creating an Inventory-Tracked Product

1. **Navigate** to `#products`
2. **Click** "New Product" button
3. **Fill form:**
   - Name: "Samsung Galaxy S25 Black"
   - SKU: "SAM-S25-BLK-V4"
   - Category: "Gaming Computers"
   - Price: 1000
   - Cost: 800
   - Check "Track Inventory" ✅
   - Check "Serial Tracked" ✅
   - Check "Batch Tracked" ✅
   - Status: Active
4. **Click Create**
5. **Backend creates:**
   - `products` row with `category = "Gaming Computers"`
   - `stock_items` row linked via `product_id`, with:
     - `category_id` resolved from "Gaming Computers" → `stock_categories.id`
     - `uom_id` auto-assigned from default UOM
     - `is_serial_tracked = 1`, `is_batch_tracked = 1`
6. **Table reloads** showing the new product
7. **Navigate** to `#inventory` → dashboard shows inventory modules
8. **Click "Stock Items" card** → grid shows the new stock item with:
   - Linked product info
   - Category, UOM, tracking flags
   - On-hand quantity (0 until stock transactions are recorded)
