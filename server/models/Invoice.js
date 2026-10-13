const { BaseModel } = require('./BaseModel');

class Invoice extends BaseModel {
  static tableName = 'invoices';
  static fields = ['id', 'invoice_number', 'contact_id', 'organization_id', 'deal_id', 'status', 'issue_date', 'due_date', 'subtotal', 'tax', 'discount', 'total', 'paid_amount', 'balance', 'notes', 'terms', 'created_at', 'updated_at'];
}

module.exports = { Invoice };
