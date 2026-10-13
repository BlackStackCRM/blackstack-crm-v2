const { BaseModel } = require('./BaseModel');

class Task extends BaseModel {
  static tableName = 'tasks';
  static fields = ['id', 'title', 'description', 'contact_id', 'deal_id', 'assigned_to', 'due_date', 'priority', 'status', 'completed_at', 'created_at', 'updated_at'];
}

module.exports = { Task };
