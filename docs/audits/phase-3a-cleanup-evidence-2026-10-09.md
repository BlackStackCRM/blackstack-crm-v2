=== PRODUCTION SNAPSHOT (read-only) ===
captured      : 2026-10-09T16:26:36.019Z
content fp    : 82a156bc94a40a1aa2a283e12cf544ab
integrity     : ok
fk violations : 0

=== ROW COUNTS (non-zero only) ===
     22  account_groups
      2  accounting_audit
     24  accounts
      7  adjustment_reasons
      1  audit_fix_log
    431  audit_logs
      1  batches
      1  bill_items
      1  bills
      2  brands
      1  colours
      1  companies
      1  company_tax_configs
      1  contacts
      4  currencies
      2  financial_years
      5  godowns
      1  inventory_items
      2  inventory_voucher_headers
      2  inventory_voucher_lines
      2  item_serials
     31  journal_entries
    112  journal_entry_lines
      5  legacy_tables
      7  locations
      2  models
      6  number_sequences
      1  organizations
    126  permissions
      4  pipeline_stages
      5  products
      1  receivables
    165  role_permissions
      3  roles
     70  schema_migrations
     18  select_options
      1  sizes
     45  specification_attributes
      7  specification_templates
      7  stock_adjustment_reasons
      2  stock_balances
      3  stock_categories
      5  stock_groups
      5  stock_items
      2  stock_ledger
      1  styles
      2  system_metadata
      8  tax_account_mappings
     12  tax_components
     11  tax_masters
     12  tax_types
      2  units_of_measure
      1  user_roles
      1  users
     25  vouchers

=== A) SIX PROBE JOURNAL ENTRIES — FULL ROWS ===
  JE-1791550881603   id=je_01M4GC1ZT2GKE78T9DFZPK08HY
     date=2026-10-09  status=POSTED  fy=fy_2024  created_by=admin  created_at=2026-10-09T13:01:21.603Z
     description      : probe
     lines            : 2   debit=100 credit=100 balanced=true negatives=0
     date in FY range : false  (2024-01-01..2024-12-31)
     dependencies     : {"journal_entry_lines.journal_entry_id":2}
     synthetic because:
        - description is literally "probe"
        - no voucher linkage
        - date 2026-10-09 is OUTSIDE its declared FY 2024-01-01..2024-12-31
     line jl_01M4GC1ZT4YN2XKGYA12RWMN1J  acc_cash  dr=100 cr=0
     line jl_01M4GC1ZT4YYBTGKX6PVSVE0E3  acc_bank  dr=0 cr=100

  JE-1791550881613   id=je_01M4GC1ZTDNBVD24857PENP19C
     date=2026-10-09  status=POSTED  fy=fy_2024  created_by=admin  created_at=2026-10-09T13:01:21.613Z
     description      : probe
     lines            : 2   debit=-50 credit=-50 balanced=true negatives=2
     date in FY range : false  (2024-01-01..2024-12-31)
     dependencies     : {"journal_entry_lines.journal_entry_id":2}
     synthetic because:
        - description is literally "probe"
        - no voucher linkage
        - 2 line(s) carry NEGATIVE amounts
        - date 2026-10-09 is OUTSIDE its declared FY 2024-01-01..2024-12-31
     line jl_01M4GC1ZTDJCFN9N8P03KX4ZGJ  acc_cash  dr=-50 cr=0
     line jl_01M4GC1ZTDHW37ENAC000776WK  acc_bank  dr=0 cr=-50

  JE-1791550881618   id=je_01M4GC1ZTJNEAWT9K0J30D71K9
     date=2026-10-09  status=POSTED  fy=fy_2024  created_by=admin  created_at=2026-10-09T13:01:21.618Z
     description      : probe
     lines            : 0   debit=0 credit=0 balanced=true negatives=0
     date in FY range : false  (2024-01-01..2024-12-31)
     dependencies     : NONE
     synthetic because:
        - description is literally "probe"
        - no voucher linkage
        - zero dependent rows in any table
        - POSTED with ZERO lines (empty ledger posting)
        - date 2026-10-09 is OUTSIDE its declared FY 2024-01-01..2024-12-31

  JE-1791552166536   id=je_01M4GD96KYKMEMT04Y4SJCFFDA
     date=2024-01-01  status=POSTED  fy=fy_2024  created_by=admin  created_at=2026-10-09T13:22:46.527Z
     description      : locked-year probe
     lines            : 2   debit=100 credit=100 balanced=true negatives=0
     date in FY range : true  (2024-01-01..2024-12-31)
     dependencies     : {"journal_entry_lines.journal_entry_id":2}
     synthetic because:
        - description is literally "locked-year probe"
        - no voucher linkage
     line jl_01M4GD96M9C95QKC5PECGF2TDV  acc_cash  dr=100 cr=0
     line jl_01M4GD96MA9BX7HGKR9SHM2YRM  acc_bank  dr=0 cr=100

  JE-1791552166543   id=je_01M4GD96MFX1N2CYENWC2NKEMZ
     date=2024-01-01  status=DRAFT  fy=fy_2024  created_by=admin  created_at=2026-10-09T13:22:46.543Z
     description      : draft probe
     lines            : 2   debit=-500 credit=-500 balanced=true negatives=2
     date in FY range : true  (2024-01-01..2024-12-31)
     dependencies     : {"journal_entry_lines.journal_entry_id":2}
     synthetic because:
        - description is literally "draft probe"
        - no voucher linkage
        - 2 line(s) carry NEGATIVE amounts
        - DRAFT status
     line jl_01M4GD96MGPMKBBQRJZJMTJ5GD  acc_cash  dr=-500 cr=0
     line jl_01M4GD96MGZ7AFEYH2FFRS88Z1  acc_bank  dr=0 cr=-500

  JE-1791552765854   id=je_01M4GDVFWXKHWGY5JCJV9VVS7E
     date=2026-01-01  status=POSTED  fy=null  created_by=admin  created_at=2026-10-09T13:32:45.854Z
     description      : guard-test
     lines            : 2   debit=5 credit=5 balanced=true negatives=0
     date in FY range : null
     dependencies     : {"journal_entry_lines.journal_entry_id":2}
     synthetic because:
        - description is literally "guard-test"
        - no voucher linkage
     line jl_01M4GDVFWZSHY6YZZNGA984M15  acc_cash  dr=5 cr=0
     line jl_01M4GDVFWZ5R93MNTRJ5E560B4  acc_bank  dr=0 cr=5

  TOTAL: 6 entries, 10 lines

=== B) LEAKED BILL AND ALL DEPENDENT RECORDS — FULL ROWS ===
  bill_id : bill_01M4GPPH2HW3B3H56AFSR01FT5
  bill    : BILL-2026-00001  status=PENDING_APPROVAL  total=2000 INR
  created : by=admin at=2026-10-09 16:07:20   issue_date=2026-10-09
  approved_by=null  posted_by=null
  journal_entry_id=null   <-- NULL: NO ledger impact
  inventory_voucher_header_id=null
  reference_number=null  notes=""  terms=""
  synthetic because:
     - status is PENDING_APPROVAL — never approved, never posted
     - approved_by and posted_by are NULL
     - journal_entry_id is NULL, so no accounting ledger entry exists
     - reference_number, notes and terms are all empty
     - no voucher or inventory voucher linkage
     - it is the ONLY bill in production (bills count = 1)
     - created 2026-10-09 16:07:20 by admin — during the release-gate run

  dependent records:
     accounting_audit.entity_id = 2
        {"id":"aud_01M4GPPH2YTF0W98V0RPGFG9H2","company_id":"default","user_id":"admin","action":"CREATE","entity_type":"customer_bill","entity_id":"bill_01M4GPPH2HW3B3H56AFSR01FT5","old_values_json":null,"new_values_json":"{\"id\":\"bill_01M4GPPH2HW3B3H56AFSR01FT5\",\"company_id\":\"default\",\"bill_number\":\"BILL-2026-00001\",\"bill_type\":\"CUSTOMER\",\"contact_id\":\"cnt_001\",\"organization_id\":null,\"currency\":\"INR\",\"status\":\"DRAFT\",\"issue_date\":\"2026-10-09\",\"due_date\":\"2026-11-08\",\"subtotal\":2500,\"tax\":0,\"discount\":0,\"total\":2000,\"paid_amount\":0,\"balance\":2000,\"reference_number\":null,\"notes\":\"\",\"terms\":\"\",\"invoice_number\":\"BILL-2026-00001\",\"customer_gstin\":null,\"billing_address\":\"—\",\"shipping_address\":\"—\",\"place_of_supply\":\"29\",\"customer_po_number\":null,\"customer_po_date\":null,\"salesperson_id\":null,\"sales_channel\":null,\"payment_terms\":\"Net 30\",\"price_list_id\":null,\"branch_id\":null,\"warehouse_id\":null,\"project_id\":null,\"cost_centre_id\":null,\"is_tax_inclusive\":0,\"round_off\":0,\"other_charges\":0,\"other_charges_taxable\":0,\"other_charges_tax_amount\":0,\"discount_amount\":0,\"line_discount_amount\":500,\"taxable_amount\":2000,\"tax_master_id\":\"tax_exempt\",\"is_interstate\":0,\"company_state\":\"29\",\"cgst_amount\":0,\"sgst_amount\":0,\"igst_amount\":0,\"cgst_rate\":0,\"sgst_rate\":0,\"igst_rate\":0,\"idempotency_key\":null,\"created_by\":\"admin\",\"lines\":[{\"quantity\":1,\"unit_price\":2500,\"tax_rate\":0,\"discount\":0,\"discount_type\":\"fixed\",\"discount_percent\":20,\"discount_amount\":500,\"taxable_amount\":2000,\"total\":2000,\"cgst_rate\":0,\"sgst_rate\":0,\"igst_rate\":0,\"cess_rate\":0,\"cess_amount\":0,\"other_tax\":0,\"tax_master_id\":\"tax_exempt\",\"cgst_amount\":0,\"sgst_amount\":0,\"igst_amount\":0,\"line_tax\":0,\"line_total\":2000,\"warehouse_id\":null,\"batch\":null,\"batch_id\":null,\"godown_id\":\"godo_01M45H90HCHHEYK90G81DH4EJR\",\"location_id\":\"loca_01M45H846VHQBD3WXJVM3YV3JD\",\"serial_id\":null,\"serial_number\":null,\"expiry\":null,\"project_id\":null,\"cost_centre_id\":null,\"gl_account_id\":null,\"description\":\"Victus Gaming Laptop 15-fb3385AX\",\"product_id\":\"prod_01M45JAQMT43CJ5K8WWVHM7N92\",\"sku\":null,\"hsn_sac\":null,\"unit\":\"Nos\"}]}","ip_address":null,"user_agent":null,"session_id":null,"created_at":"2026-10-09T16:07:20.414Z"}
        {"id":"aud_01M4GPPH3GJJESHBQQRQG4MJZ9","company_id":"default","user_id":"admin","action":"SUBMIT","entity_type":"customer_bill","entity_id":"bill_01M4GPPH2HW3B3H56AFSR01FT5","old_values_json":null,"new_values_json":"{\"status\":\"PENDING_APPROVAL\"}","ip_address":null,"user_agent":null,"session_id":null,"created_at":"2026-10-09T16:07:20.432Z"}
     bill_items.bill_id = 1
        {"id":"bill_item_01M4GPPH2WNWSPB6VSVQ446SAN","company_id":"default","bill_id":"bill_01M4GPPH2HW3B3H56AFSR01FT5","product_id":"prod_01M45JAQMT43CJ5K8WWVHM7N92","description":"Victus Gaming Laptop 15-fb3385AX","quantity":1,"unit_price":2500,"tax_rate":null,"discount":null,"total":2000,"gl_account_id":null,"created_at":"2026-10-09 16:07:20","sku":null,"hsn_sac":null,"unit":"Nos","discount_percent":20,"discount_amount":500,"taxable_amount":2000,"cgst_rate":null,"sgst_rate":null,"igst_rate":null,"cess_rate":null,"cess_amount":null,"other_tax":null,"tax_master_id":"tax_exempt","warehouse_id":null,"batch":null,"serial_number":null,"expiry":null,"project_id":null,"cost_centre_id":null,"discount_type":"fixed","cgst_amount":null,"sgst_amount":null,"igst_amount":null,"line_total":2000,"line_tax":null,"stock_item_id":null,"godown_id":"godo_01M45H90HCHHEYK90G81DH4EJR","location_id":"loca_01M45H846VHQBD3WXJVM3YV3JD","batch_id":null,"serial_id":null}
     receivables.bill_id = 1
        {"id":"rec_01M4GPPH2WMY2J0PWASYQFNSE6","company_id":"default","bill_id":"bill_01M4GPPH2HW3B3H56AFSR01FT5","contact_id":"cnt_001","organization_id":null,"deal_id":null,"due_date":"2026-11-08","original_amount":2000,"paid_amount":0,"outstanding_amount":2000,"currency":"INR","status":"CURRENT","credit_limit":0,"credit_period_days":30,"payment_terms":null,"days_overdue":0,"created_at":"2026-10-09 16:07:20","updated_at":"2026-10-09 16:07:20"}

=== PRESERVED BY THE PROPOSED CLEANUP (must not change) ===
  audit_logs rows            : 431
  CUSTOMER_BILL sequence     : next_seq=2  <-- NOT reset, so BILL-2026-00001 is never reused
  financial_year fy_2024      : is_active=0 is_locked=1
  financial_year fy_2026      : is_active=1 is_locked=1
  genuine journal_entries    : 25
  vouchers                   : 25
  stock_ledger               : 2