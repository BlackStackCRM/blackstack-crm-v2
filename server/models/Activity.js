const { BaseModel } = require('./BaseModel');

class Activity extends BaseModel {
  static tableName = 'activities';
  static fields = ['id', 'type', 'title', 'description', 'contact_id', 'organization_id', 'deal_id', 'user_id', 'metadata_json', 'created_at'];
}

module.exports = { Activity };
