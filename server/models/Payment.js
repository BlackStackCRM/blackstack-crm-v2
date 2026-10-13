const { BaseModel } = require('./BaseModel');

class Payment extends BaseModel {
  static tableName = 'payments';
  static fields = ['id', 'invoice_id', 'contact_id', 'amount', 'payment_method', 'status', 'reference_number', 'notes', 'payment_date', 'created_at', 'updated_at'];
}

module.exports = { Payment };
