const { BaseModel } = require('./BaseModel');

class WorkflowDefinition extends BaseModel {
  static tableName = 'workflow_definitions';
  static fields = ['id', 'name', 'trigger_type', 'conditions_json', 'actions_json', 'is_active', 'created_at', 'updated_at'];
}

module.exports = { WorkflowDefinition };
