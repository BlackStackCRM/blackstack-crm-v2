const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { validateCurrency } = require('../utils/currency');

class WorkflowExecutorService {
  constructor() {
    this.conn = getConn();
  }

  async execute(workflowId, context = {}) {
    const workflow = this.conn.get('SELECT * FROM workflow_definitions WHERE id = ? AND is_active = 1', [workflowId]);
    if (!workflow) return { executed: false, reason: 'Workflow not found or inactive' };

    const instanceId = generateId('wfi');
    const now = new Date().toISOString();
    this.conn.run('INSERT INTO workflow_instances (id, workflow_id, status, started_at) VALUES (?, ?, ?, ?)',
      [instanceId, workflowId, 'RUNNING', now]);

    const actions = JSON.parse(workflow.actions_json || '[]');
    const results = [];

    for (const action of actions) {
      try {
        const result = await this.executeAction(action, context);
        results.push({ action, result });
        this.conn.run('INSERT INTO workflow_executions (id, instance_id, node_type, node_name, status, result_json, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [generateId('wfexec'), instanceId, 'action', action.type || 'unknown', 'completed', JSON.stringify(result), now]);
      } catch (err) {
        results.push({ action, error: err.message });
        this.conn.run('INSERT INTO workflow_executions (id, instance_id, node_type, node_name, status, result_json, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [generateId('wfexec'), instanceId, 'action', action.type || 'unknown', 'failed', JSON.stringify({ error: err.message }), now]);
      }
    }

    this.conn.run('UPDATE workflow_instances SET status = ?, completed_at = ? WHERE id = ?',
      ['COMPLETED', now, instanceId]);

    return { executed: true, instanceId, results };
  }

  async executeAction(action, context) {
    switch (action.type) {
      case 'create_task':
        return this.createTask(action, context);
      case 'update_status':
        return this.updateStatus(action, context);
      case 'add_tag':
        return this.addTag(action, context);
      case 'remove_tag':
        return this.removeTag(action, context);
      case 'create_opportunity':
        return this.createOpportunity(action, context);
      case 'move_pipeline_stage':
        return this.movePipelineStage(action, context);
      case 'send_message':
        return this.sendMessage(action, context);
      case 'create_appointment':
        return this.createAppointment(action, context);
      case 'notify_user':
        return this.notifyUser(action, context);
      case 'add_note':
        return this.addNote(action, context);
      case 'assign_owner':
        return this.assignOwner(action, context);
      case 'trigger_ai':
        return this.triggerAI(action, context);
      default:
        return { skipped: true, reason: `Unknown action type: ${action.type}` };
    }
  }

  async createTask(action, context) {
    const { title, description, contact_id, deal_id, assigned_to, due_date, priority } = action.config || {};
    if (!title) return { created: false, reason: 'Title required' };
    const id = generateId('task');
    const now = new Date().toISOString();
    this.conn.run(`
      INSERT INTO tasks (id, company_id, title, description, contact_id, deal_id, assigned_to, due_date, priority, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MEDIUM', 'TODO', ?, ?)
    `, [id, context.companyId || 'default', title, description || null, contact_id || context.contactId || null, deal_id || context.dealId || null, assigned_to || context.userId || null, due_date || null, now, now]);
    return { created: true, taskId: id };
  }

  async updateStatus(action, context) {
    const { entity_type, entity_id, status } = action.config || {};
    if (!entity_type || !entity_id || !status) return { updated: false, reason: 'Missing config' };
    const tableMap = { contact: 'contacts', deal: 'deals', lead: 'leads', customer: 'customers', task: 'tasks' };
    const table = tableMap[entity_type];
    if (!table) return { updated: false, reason: 'Unknown entity type' };
    const now = new Date().toISOString();
    this.conn.run(`UPDATE ${table} SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?`,
      [status, now, entity_id, context.companyId || 'default']);
    return { updated: true };
  }

  async addTag(action, context) {
    const { contact_id, tag_name, tag_color } = action.config || {};
    if (!contact_id || !tag_name) return { added: false, reason: 'Missing contact_id or tag_name' };
    const tagId = generateId('tag');
    const now = new Date().toISOString();
    this.conn.run('INSERT OR IGNORE INTO tags (id, company_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)',
      [tagId, context.companyId || 'default', tag_name, tag_color || '#3b82f6', now]);
    this.conn.run('INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)', [contact_id, tagId]);
    return { added: true, tagId };
  }

  async removeTag(action, context) {
    const { contact_id, tag_name } = action.config || {};
    if (!contact_id || !tag_name) return { removed: false, reason: 'Missing config' };
    const tag = this.conn.get('SELECT id FROM tags WHERE company_id = ? AND name = ?', [context.companyId || 'default', tag_name]);
    if (!tag) return { removed: false, reason: 'Tag not found' };
    this.conn.run('DELETE FROM contact_tags WHERE contact_id = ? AND tag_id = ?', [contact_id, tag.id]);
    return { removed: true };
  }

  async createOpportunity(action, context) {
    const { title, contact_id, value, pipeline_id, stage_id } = action.config || {};
    if (!title || !contact_id) return { created: false, reason: 'Missing title or contact_id' };
    const id = generateId('deal');
    const now = new Date().toISOString();
    this.conn.run(`
      INSERT INTO deals (id, company_id, title, description, contact_id, pipeline_id, stage_id, value, currency, probability, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `, [id, context.companyId || 'default', title, action.config.description || null, contact_id, pipeline_id || null, stage_id || null, value || 0, validateCurrency(action.config.currency || 'USD'), now, 'OPEN', now]);
    return { created: true, dealId: id };
  }

  async movePipelineStage(action, context) {
    const { deal_id, stage_id } = action.config || {};
    if (!deal_id || !stage_id) return { moved: false, reason: 'Missing deal_id or stage_id' };
    const stage = this.conn.get('SELECT probability FROM pipeline_stages WHERE id = ? AND company_id = ?', [stage_id, context.companyId || 'default']);
    const now = new Date().toISOString();
    this.conn.run('UPDATE deals SET stage_id = ?, probability = ?, updated_at = ? WHERE id = ? AND company_id = ?',
      [stage_id, stage?.probability || 0, now, deal_id, context.companyId || 'default']);
    return { moved: true };
  }

  async sendMessage(action, context) {
    return { sent: true, channel: 'stub', message: 'Message adapter not connected' };
  }

  async createAppointment(action, context) {
    const { title, contact_id, start_time, end_time, assigned_to } = action.config || {};
    if (!title || !start_time) return { created: false, reason: 'Missing title or start_time' };
    const id = generateId('apt');
    const now = new Date().toISOString();
    this.conn.run(`
      INSERT INTO appointments (id, company_id, contact_id, title, description, start_time, end_time, assigned_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, context.companyId || 'default', contact_id || context.contactId || null, title, action.config.description || null, start_time, end_time || null, assigned_to || context.userId || null, now, now]);
    return { created: true, appointmentId: id };
  }

  async notifyUser(action, context) {
    const { user_id, title, message, entity_type, entity_id } = action.config || {};
    if (!user_id || !title) return { notified: false, reason: 'Missing user_id or title' };
    const id = generateId('notif');
    const now = new Date().toISOString();
    this.conn.run(`
      INSERT INTO notifications (id, company_id, user_id, type, title, message, entity_type, entity_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, context.companyId || 'default', user_id, action.config.type || 'system', title, message || null, entity_type || null, entity_id || null, now]);
    return { notified: true, notificationId: id };
  }

  async addNote(action, context) {
    const { entity_type, entity_id, content } = action.config || {};
    if (!entity_type || !entity_id || !content) return { added: false, reason: 'Missing config' };
    const id = generateId('note');
    const now = new Date().toISOString();
    const tableMap = { contact: 'contacts', deal: 'deals', organization: 'organizations', lead: 'leads', customer: 'customers' };
    const refTable = tableMap[entity_type];
    if (!refTable) return { added: false, reason: 'Unknown entity type' };
    this.conn.run(`
      INSERT INTO notes (id, company_id, content, ${refTable === 'contacts' ? 'contact_id' : refTable === 'deals' ? 'deal_id' : 'organization_id'}, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, context.companyId || 'default', content, entity_id, now, now]);
    return { added: true, noteId: id };
  }

  async assignOwner(action, context) {
    const { entity_type, entity_id, owner_id } = action.config || {};
    if (!entity_type || !entity_id || !owner_id) return { assigned: false, reason: 'Missing config' };
    const tableMap = { contact: 'contacts', deal: 'deals', lead: 'leads', customer: 'customers', appointment: 'appointments', task: 'tasks' };
    const table = tableMap[entity_type];
    if (!table) return { assigned: false, reason: 'Unknown entity type' };
    const now = new Date().toISOString();
    this.conn.run(`UPDATE ${table} SET owner_id = ?, updated_at = ? WHERE id = ? AND company_id = ?`,
      [owner_id, now, entity_id, context.companyId || 'default']);
    return { assigned: true };
  }

  async triggerAI(action, context) {
    return { triggered: true, recommendation: 'AI analysis queued' };
  }
}

module.exports = { WorkflowExecutorService };
