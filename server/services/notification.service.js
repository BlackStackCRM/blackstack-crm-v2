const { getConn } = require('../utils/db');
const { generateId } = require('../utils/generateId');
const { NotificationRepository } = require('../repositories/notification.repository');
const { WorkflowExecutorService } = require('./workflow-executor.service');

class NotificationService {
  constructor() {
    this.conn = getConn();
    this.repo = new NotificationRepository(this.conn);
    this.executor = new WorkflowExecutorService();
  }

  async create(companyId, data) {
    if (!data.user_id) return { skipped: true, reason: 'No user_id' };
    const id = data.id || generateId('notif');
    const now = new Date().toISOString();
    this.conn.run(`
      INSERT INTO notifications (id, company_id, user_id, type, title, message, entity_type, entity_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, companyId, data.user_id, data.type || 'system', data.title, data.message || null, data.entity_type || null, data.entity_id || null, now]);
    return { id, ...data, created_at: now };
  }

  async list(companyId, userId, options = {}) {
    return this.repo.search({ ...options, companyId, userId });
  }

  async markRead(companyId, id) {
    await this.repo.markRead(id, companyId);
    return { success: true };
  }

  async markAllRead(companyId, userId) {
    await this.repo.markAllRead(companyId, userId);
    return { success: true };
  }

  async unreadCount(companyId, userId) {
    return this.repo.unreadCount(companyId, userId);
  }

  notifyLeadCreated(companyId, lead) {
    if (!lead.assigned_to && !lead.owner_id) return { skipped: true, reason: 'No owner for lead' };
    return this.create(companyId, {
      user_id: lead.assigned_to || lead.owner_id,
      type: 'lead_created',
      title: 'New Lead Created',
      message: `Lead ${lead.first_name || ''} ${lead.last_name || ''} was created.`,
      entity_type: 'lead',
      entity_id: lead.id
    });
  }

  notifyDealWon(companyId, deal) {
    if (!deal.assigned_to && !deal.owner_id) return { skipped: true, reason: 'No owner for deal' };
    return this.create(companyId, {
      user_id: deal.assigned_to || deal.owner_id,
      type: 'deal_won',
      title: 'Deal Won!',
      message: `Deal "${deal.title}" has been marked as won.`,
      entity_type: 'deal',
      entity_id: deal.id
    });
  }

  notifyDealLost(companyId, deal) {
    if (!deal.assigned_to && !deal.owner_id) return { skipped: true, reason: 'No owner for deal' };
    return this.create(companyId, {
      user_id: deal.assigned_to || deal.owner_id,
      type: 'deal_lost',
      title: 'Deal Lost',
      message: `Deal "${deal.title}" has been marked as lost.`,
      entity_type: 'deal',
      entity_id: deal.id
    });
  }

  notifyAppointment(companyId, appointment) {
    if (!appointment.assigned_to) return { skipped: true, reason: 'No assigned user' };
    return this.create(companyId, {
      user_id: appointment.assigned_to,
      type: 'appointment',
      title: 'Upcoming Appointment',
      message: `Appointment "${appointment.title}" is scheduled.`,
      entity_type: 'appointment',
      entity_id: appointment.id
    });
  }

  notifyOverdueTask(companyId, task) {
    if (!task.assigned_to) return { skipped: true, reason: 'No assigned user' };
    return this.create(companyId, {
      user_id: task.assigned_to,
      type: 'overdue_task',
      title: 'Overdue Task',
      message: `Task "${task.title}" is overdue.`,
      entity_type: 'task',
      entity_id: task.id
    });
  }
}

module.exports = { NotificationService };
