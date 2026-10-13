const { BaseModel } = require('./BaseModel');

class PipelineStage extends BaseModel {
  static tableName = 'pipeline_stages';
  static fields = ['id', 'name', 'stage_order', 'probability', 'color', 'is_won', 'is_lost', 'created_at'];
}

module.exports = { PipelineStage };
