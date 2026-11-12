const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/blackstack-crm.db');

console.log('integrity_check:', db.prepare('PRAGMA integrity_check').get().integrity_check);
console.log('foreign_key violations:', db.prepare('PRAGMA foreign_key_check').all().length);

const counts = db.prepare(`
  SELECT 'users' AS t, COUNT(*) AS n FROM users
  UNION ALL SELECT 'roles', COUNT(*) FROM roles
  UNION ALL SELECT 'permissions', COUNT(*) FROM permissions
  UNION ALL SELECT 'companies', COUNT(*) FROM companies
  UNION ALL SELECT 'contacts', COUNT(*) FROM contacts
  UNION ALL SELECT 'organizations', COUNT(*) FROM organizations
  UNION ALL SELECT 'products', COUNT(*) FROM products
  UNION ALL SELECT 'stock_items', COUNT(*) FROM stock_items
  UNION ALL SELECT 'stock_ledger', COUNT(*) FROM stock_ledger
  UNION ALL SELECT 'stock_balances', COUNT(*) FROM stock_balances
  UNION ALL SELECT 'inventory_items', COUNT(*) FROM inventory_items
  UNION ALL SELECT 'bills', COUNT(*) FROM bills
  UNION ALL SELECT 'bill_items', COUNT(*) FROM bill_items
  UNION ALL SELECT 'journal_entries', COUNT(*) FROM journal_entries
`).all();
console.log(JSON.stringify(counts, null, 2));
