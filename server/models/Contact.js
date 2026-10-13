const { BaseModel } = require('./BaseModel');

class Contact extends BaseModel {
  static tableName = 'contacts';
  static fields = ['id', 'first_name', 'last_name', 'email', 'phone', 'job_title', 'organization_id', 'address', 'city', 'state', 'postal_code', 'country', 'notes', 'status', 'created_at', 'updated_at'];
}

module.exports = { Contact };
