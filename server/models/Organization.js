const { BaseModel } = require('./BaseModel');

class Organization extends BaseModel {
  static tableName = 'organizations';
  static fields = ['id', 'name', 'industry', 'website', 'email', 'phone', 'address', 'city', 'state', 'country', 'postal_code', 'status', 'notes', 'created_at', 'updated_at'];
}

module.exports = { Organization };
