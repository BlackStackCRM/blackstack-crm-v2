-- Migration 073: Product Specification Templates
-- Enables category-based dynamic specifications for products
-- Integrates with existing inventory masters

-- Create specification templates table
CREATE TABLE IF NOT EXISTS specification_templates (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL DEFAULT 'default',
  name          TEXT NOT NULL,
  description   TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now'))
);

-- Create specification attributes table
CREATE TABLE IF NOT EXISTS specification_attributes (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL DEFAULT 'default',
  template_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  field_type    TEXT NOT NULL CHECK(field_type IN ('text', 'number', 'decimal', 'boolean', 'select', 'multiselect', 'date', 'measurement', 'currency')),
  is_required   INTEGER DEFAULT 0,
  default_value TEXT,
  options_json  TEXT,
  sort_order    INTEGER DEFAULT 0,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (template_id) REFERENCES specification_templates(id) ON DELETE CASCADE
);

-- Create product specifications table
CREATE TABLE IF NOT EXISTS product_specifications (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL,
  attribute_id TEXT NOT NULL,
  value_text   TEXT,
  value_number REAL,
  value_boolean INTEGER,
  value_json   TEXT,
  created_at   DATETIME DEFAULT (datetime('now')),
  updated_at   DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (attribute_id) REFERENCES specification_attributes(id) ON DELETE CASCADE
);

-- Add barcode and hsn_sac_code to products table
ALTER TABLE products ADD COLUMN barcode TEXT;
ALTER TABLE products ADD COLUMN hsn_sac_code TEXT;
ALTER TABLE products ADD COLUMN min_stock_level REAL DEFAULT 0;
ALTER TABLE products ADD COLUMN max_stock_level REAL DEFAULT 0;
ALTER TABLE products ADD COLUMN image_url TEXT;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_spec_templates_company ON specification_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_spec_attrs_template ON specification_attributes(template_id);
CREATE INDEX IF NOT EXISTS idx_product_specs_product ON product_specifications(product_id);
CREATE INDEX IF NOT EXISTS idx_product_specs_attr ON product_specifications(attribute_id);

-- Seed default categories with templates
-- Laptop/Computer
INSERT OR IGNORE INTO specification_templates (id, company_id, name, description, is_active) VALUES
  ('tmpl_laptop', 'default', 'Laptop/Computer', 'Specifications for laptops, computers and related devices', 1);

-- Mobile Phone
INSERT OR IGNORE INTO specification_templates (id, company_id, name, description, is_active) VALUES
  ('tmpl_mobile', 'default', 'Mobile Phone', 'Specifications for mobile phones and tablets', 1);

-- TV/Appliance
INSERT OR IGNORE INTO specification_templates (id, company_id, name, description, is_active) VALUES
  ('tmpl_appliance', 'default', 'Appliance', 'Specifications for home appliances like refrigerators, TVs, etc.', 1);

-- Electronics
INSERT OR IGNORE INTO specification_templates (id, company_id, name, description, is_active) VALUES
  ('tmpl_electronics', 'default', 'Electronics', 'Specifications for general electronics items', 1);

-- Clothing/Fashion
INSERT OR IGNORE INTO specification_templates (id, company_id, name, description, is_active) VALUES
  ('tmpl_clothing', 'default', 'Clothing/Fashion', 'Specifications for clothing and fashion items', 1);

-- Food/Beverages
INSERT OR IGNORE INTO specification_templates (id, company_id, name, description, is_active) VALUES
  ('tmpl_food', 'default', 'Food & Beverages', 'Specifications for food and beverage products', 1);

-- Industrial/Machinery
INSERT OR IGNORE INTO specification_templates (id, company_id, name, description, is_active) VALUES
  ('tmpl_industrial', 'default', 'Industrial Machinery', 'Specifications for industrial machinery and equipment', 1);

-- Laptop/Computer Attributes
INSERT OR IGNORE INTO specification_attributes (id, template_id, name, display_name, field_type, is_required, sort_order) VALUES
  ('attr_processor_brand_lap', 'tmpl_laptop', 'processor_brand', 'Processor Brand', 'select', 1, 1),
  ('attr_processor_lap', 'tmpl_laptop', 'processor', 'Processor', 'text', 1, 2),
  ('attr_processor_gen_lap', 'tmpl_laptop', 'processor_generation', 'Processor Generation', 'text', 0, 3),
  ('attr_ram_lap', 'tmpl_laptop', 'ram', 'RAM', 'number', 1, 4),
  ('attr_ram_type_lap', 'tmpl_laptop', 'ram_type', 'RAM Type', 'select', 0, 5),
  ('attr_storage_type_lap', 'tmpl_laptop', 'storage_type', 'Storage Type', 'select', 1, 6),
  ('attr_storage_cap_lap', 'tmpl_laptop', 'storage_capacity', 'Storage Capacity', 'number', 1, 7),
  ('attr_gpu_lap', 'tmpl_laptop', 'gpu', 'GPU', 'text', 0, 8),
  ('attr_gpu_mem_lap', 'tmpl_laptop', 'gpu_memory', 'GPU Memory', 'text', 0, 9),
  ('attr_display_size_lap', 'tmpl_laptop', 'display_size', 'Display Size', 'decimal', 1, 10),
  ('attr_display_res_lap', 'tmpl_laptop', 'display_resolution', 'Display Resolution', 'text', 0, 11),
  ('attr_display_type_lap', 'tmpl_laptop', 'display_type', 'Display Type', 'select', 0, 12),
  ('attr_refresh_rate_lap', 'tmpl_laptop', 'refresh_rate', 'Refresh Rate', 'number', 0, 13),
  ('attr_os_lap', 'tmpl_laptop', 'operating_system', 'Operating System', 'select', 1, 14),
  ('attr_touchscreen_lap', 'tmpl_laptop', 'touchscreen', 'Touchscreen', 'boolean', 0, 15),
  ('attr_fingerprint_lap', 'tmpl_laptop', 'fingerprint', 'Fingerprint Sensor', 'boolean', 0, 16),
  ('attr_webcam_lap', 'tmpl_laptop', 'webcam', 'Webcam', 'boolean', 0, 17),
  ('attr_wifi_lap', 'tmpl_laptop', 'wifi', 'Wi-Fi', 'boolean', 0, 18),
  ('attr_bluetooth_lap', 'tmpl_laptop', 'bluetooth', 'Bluetooth', 'boolean', 0, 19),
  ('attr_usb_ports_lap', 'tmpl_laptop', 'usb_ports', 'USB Ports', 'number', 0, 20),
  ('attr_hdmi_lap', 'tmpl_laptop', 'hdmi', 'HDMI Ports', 'number', 0, 21),
  ('attr_audio_lap', 'tmpl_laptop', 'audioJack', 'Audio Jack', 'boolean', 0, 22),
  ('attr_battery_lap', 'tmpl_laptop', 'battery_capacity', 'Battery Capacity (mAh)', 'number', 0, 23),
  ('attr_battery_life_lap', 'tmpl_laptop', 'battery_life', 'Battery Life (hours)', 'number', 0, 24),
  ('attr_weight_lap', 'tmpl_laptop', 'weight', 'Weight (kg)', 'decimal', 0, 25),
  ('attr_dimensions_lap', 'tmpl_laptop', 'dimensions', 'Dimensions (L×W×H cm)', 'text', 0, 26),
  ('attr_colour_lap', 'tmpl_laptop', 'colour', 'Colour', 'text', 0, 27);

-- Mobile Phone Attributes
INSERT OR IGNORE INTO specification_attributes (id, template_id, name, display_name, field_type, is_required, sort_order) VALUES
  ('attr_ram_mobile', 'tmpl_mobile', 'ram', 'RAM', 'number', 1, 1),
  ('attr_storage_mobile', 'tmpl_mobile', 'storage', 'Storage', 'number', 1, 2),
  ('attr_storage_type_mobile', 'tmpl_mobile', 'storage_type', 'Storage Type', 'select', 0, 3),
  ('attr_display_size_mobile', 'tmpl_mobile', 'display_size', 'Display Size (inches)', 'decimal', 1, 4),
  ('attr_display_res_mobile', 'tmpl_mobile', 'display_resolution', 'Display Resolution', 'text', 0, 5),
  ('attr_processor_mobile', 'tmpl_mobile', 'processor', 'Processor', 'text', 1, 6),
  ('attr_rear_cam_mobile', 'tmpl_mobile', 'rear_camera', 'Rear Camera', 'text', 0, 7),
  ('attr_front_cam_mobile', 'tmpl_mobile', 'front_camera', 'Front Camera', 'text', 0, 8),
  ('attr_battery_mobile', 'tmpl_mobile', 'battery_capacity', 'Battery Capacity (mAh)', 'number', 0, 9),
  ('attr_os_mobile', 'tmpl_mobile', 'operating_system', 'Operating System', 'select', 1, 10),
  ('attr_sim_mobile', 'tmpl_mobile', 'sim_type', 'SIM Type', 'select', 0, 11),
  ('attr_5g_mobile', 'tmpl_mobile', 'is_5g', '5G Support', 'boolean', 0, 12),
  ('attr_bluetooth_mobile', 'tmpl_mobile', 'bluetooth', 'Bluetooth', 'boolean', 0, 13),
  ('attr_wifi_mobile', 'tmpl_mobile', 'wifi', 'Wi-Fi', 'boolean', 0, 14),
  ('attr_colour_mobile', 'tmpl_mobile', 'colour', 'Colour', 'text', 0, 15),
  ('attr_weight_mobile', 'tmpl_mobile', 'weight', 'Weight (g)', 'decimal', 0, 16),
  ('attr_dimensions_mobile', 'tmpl_mobile', 'dimensions', 'Dimensions (L×W×D cm)', 'text', 0, 17),
  ('attr_imei_mobile', 'tmpl_mobile', 'imei_tracking', 'IMEI Tracking', 'boolean', 0, 18);

-- Create options tables for select fields
CREATE TABLE IF NOT EXISTS select_options (
  id          TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  value       TEXT NOT NULL,
  label       TEXT NOT NULL,
  sort_order  INTEGER DEFAULT 0
);

-- Seed select options for Laptop
INSERT OR IGNORE INTO select_options (id, category, value, label, sort_order) VALUES
  ('opt_proc_intel', 'processor_brand', 'intel', 'Intel', 1),
  ('opt_proc_amd', 'processor_brand', 'amd', 'AMD', 2),
  ('opt_proc_apple', 'processor_brand', 'apple', 'Apple', 3),
  ('opt_ram_ddr4', 'ram_type', 'DDR4', 'DDR4', 1),
  ('opt_ram_ddr5', 'ram_type', 'DDR5', 'DDR5', 2),
  ('opt_storage_sdd', 'storage_type', 'SSD', 'SSD', 1),
  ('opt_storage_hdd', 'storage_type', 'HDD', 'HDD', 2),
  ('opt_storage_nvme', 'storage_type', 'NVMe', 'NVMe', 3),
  ('opt_display_igb', 'display_type', 'IPS', 'IPS', 1),
  ('opt_display_oled', 'display_type', 'OLED', 'OLED', 2),
  ('opt_display_tn', 'display_type', 'TN', 'TN', 3),
  ('opt_os_windows', 'operating_system', 'Windows 11', 'Windows 11', 1),
  ('opt_os_macos', 'operating_system', 'macOS', 'macOS', 2),
  ('opt_os_linux', 'operating_system', 'Linux', 'Linux', 3);

-- Seed select options for Mobile
INSERT OR IGNORE INTO select_options (id, category, value, label, sort_order) VALUES
  ('opt_sim_single', 'sim_type', 'Single SIM', 'Single SIM', 1),
  ('opt_sim_dual', 'sim_type', 'Dual SIM', 'Dual SIM', 2),
  ('opt_os_android', 'os_mobile', 'Android', 'Android', 1),
  ('opt_os_ios', 'os_mobile', 'iOS', 'iOS', 2);

-- Update products table constraints if needed
-- Note: ALTER TABLE in SQLite has limitations, we may need to recreate table