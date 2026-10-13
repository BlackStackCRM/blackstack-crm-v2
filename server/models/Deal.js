const { BaseModel } = require('./BaseModel');

class Deal extends BaseModel {
  static tableName = 'deals';
  static fields = ['id', 'title', 'description', 'contact_id', 'organization_id', 'pipeline_id', 'stage_id', 'value', 'currency', 'probability', 'expected_close_date', 'actual_close_date', 'status', 'lost_reason', 'notes', 'created_at', 'updated_at'];
}

module.exports = { Deal };
