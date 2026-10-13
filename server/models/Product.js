const { BaseModel } = require('./BaseModel');

class Product extends BaseModel {
  static tableName = 'products';
  static fields = ['id', 'name', 'description', 'category', 'sku', 'price', 'cost', 'tax_rate', 'is_service', 'is_active', 'created_at', 'updated_at'];
}

module.exports = { Product };
