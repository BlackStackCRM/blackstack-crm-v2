const { getConn } = require('../utils/db');
const { WorkflowExecutorService } = require('./workflow-executor.service');
const { NotificationService } = require('./notification.service');

class EventHooksService {
  constructor() {
    this.conn = getConn();
    this.executor = new WorkflowExecutorService();
    this.notifications = new NotificationService();
  }

  async onLeadCreated(companyId, lead) {
    const workflows = this.conn.all(
      'SELECT * FROM workflow_definitions WHERE company_id = ? AND trigger_type = ? AND is_active = 1',
      [companyId, 'lead_created']
    );
    for (const wf of workflows) {
      await this.executor.execute(wf.id, { companyId, leadId: lead.id, contactId: lead.contact_id });
    }
    await this.notifications.notifyLeadCreated(companyId, lead);
  }

  async onLeadStatusChanged(companyId, leadId, oldStatus, newStatus) {
    const workflows = this.conn.all(
      'SELECT * FROM workflow_definitions WHERE company_id = ? AND trigger_type = ? AND is_active = 1',
      [companyId, 'lead_status_changed']
    );
    for (const wf of workflows) {
      const conditions = JSON.parse(wf.conditions_json || '{}');
      if (conditions.status && conditions.status !== newStatus) continue;
      await this.executor.execute(wf.id, { companyId, leadId, oldStatus, newStatus });
    }
  }

  async onDealCreated(companyId, deal) {
    const workflows = this.conn.all(
      'SELECT * FROM workflow_definitions WHERE company_id = ? AND trigger_type = ? AND is_active = 1',
      [companyId, 'deal_created']
    );
    for (const wf of workflows) {
      await this.executor.execute(wf.id, { companyId, dealId: deal.id, contactId: deal.contact_id });
    }
  }

  async onDealStageChanged(companyId, dealId, oldStage, newStage) {
    const stage = this.conn.get('SELECT * FROM pipeline_stages WHERE id = ?', [newStage]);
    const deal = this.conn.get('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return;

    if (stage?.is_won) {
      this.conn.run(`UPDATE deals SET status = 'WON', actual_close_date = ?, updated_at = ? WHERE id = ?`,
        [new Date().toISOString().split('T')[0], new Date().toISOString(), dealId]);
      await this.onDealWon(companyId, dealId);
    } else if (stage?.is_lost) {
      this.conn.run(`UPDATE deals SET status = 'LOST', actual_close_date = ?, updated_at = ? WHERE id = ?`,
        [new Date().toISOString().split('T')[0], new Date().toISOString(), dealId]);
      await this.onDealLost(companyId, dealId);
    }

    const workflows = this.conn.all(
      'SELECT * FROM workflow_definitions WHERE company_id = ? AND trigger_type = ? AND is_active = 1',
      [companyId, 'deal_stage_changed']
    );
    for (const wf of workflows) {
      await this.executor.execute(wf.id, { companyId, dealId, oldStage, newStage });
    }
  }

  async onDealWon(companyId, dealId) {
    const deal = this.conn.get('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return;
    await this.notifications.notifyDealWon(companyId, deal);

    const workflows = this.conn.all(
      'SELECT * FROM workflow_definitions WHERE company_id = ? AND trigger_type = ? AND is_active = 1',
      [companyId, 'deal_won']
    );
    for (const wf of workflows) {
      await this.executor.execute(wf.id, { companyId, dealId, contactId: deal.contact_id });
    }
  }

  async onDealLost(companyId, dealId) {
    const deal = this.conn.get('SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return;
    await this.notifications.notifyDealLost(companyId, deal);

    const workflows = this.conn.all(
      'SELECT * FROM workflow_definitions WHERE company_id = ? AND trigger_type = ? AND is_active = 1',
      [companyId, 'deal_lost']
    );
    for (const wf of workflows) {
      await this.executor.execute(wf.id, { companyId, dealId, contactId: deal.contact_id });
    }
  }

  async onTaskCompleted(companyId, taskId) {
    const task = this.conn.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) return;
    const workflows = this.conn.all(
      'SELECT * FROM workflow_definitions WHERE company_id = ? AND trigger_type = ? AND is_active = 1',
      [companyId, 'task_completed']
    );
    for (const wf of workflows) {
      await this.executor.execute(wf.id, { companyId, taskId, contactId: task.contact_id, dealId: task.deal_id });
    }
  }

  async onAppointmentCreated(companyId, appointmentId) {
    const appointment = this.conn.get('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
    if (!appointment) return;
    await this.notifications.notifyAppointment(companyId, appointment);

    const workflows = this.conn.all(
      'SELECT * FROM workflow_definitions WHERE company_id = ? AND trigger_type = ? AND is_active = 1',
      [companyId, 'appointment_created']
    );
    for (const wf of workflows) {
      await this.executor.execute(wf.id, { companyId, appointmentId, contactId: appointment.contact_id });
    }
  }

  async onContactCreated(companyId, contact) {
    const workflows = this.conn.all(
      'SELECT * FROM workflow_definitions WHERE company_id = ? AND trigger_type = ? AND is_active = 1',
      [companyId, 'contact_created']
    );
    for (const wf of workflows) {
      await this.executor.execute(wf.id, { companyId, contactId: contact.id });
    }
  }
}

module.exports = { EventHooksService };
