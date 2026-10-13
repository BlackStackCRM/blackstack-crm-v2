const { BaseRepository } = require('./BaseRepository');

class PipelineRepository extends BaseRepository {
  constructor(conn) {
    super(conn, 'pipelines');
  }

  async getStages(companyId) {
    return this.conn.all('SELECT * FROM pipeline_stages WHERE company_id = ? ORDER BY stage_order ASC', [companyId]);
  }

  async getStageById(id, companyId) {
    return this.conn.get('SELECT * FROM pipeline_stages WHERE id = ? AND company_id = ? LIMIT 1', [id, companyId]);
  }

  async createStage(stage, companyId) {
    const id = stage.id || require('../utils/generateId').generateId('stage');
    const now = new Date().toISOString();
    this.conn.run(
      `INSERT INTO pipeline_stages (id, name, stage_order, probability, color, is_won, is_lost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, stage.name, stage.stage_order || 0, stage.probability || 0, stage.color || '#64748b', stage.is_won ? 1 : 0, stage.is_lost ? 1 : 0, now]
    );
    return { id, ...stage, created_at: now };
  }
}

module.exports = { PipelineRepository };
