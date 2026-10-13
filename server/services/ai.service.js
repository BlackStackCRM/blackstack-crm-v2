const { getConn } = require('../utils/db');

class AIService {
  constructor() {
    this.conn = getConn();
    this.ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    this.model = process.env.OLLAMA_MODEL || 'llama3.2';
  }

  async getLeadRecommendations(companyId, leadId) {
    try {
      const lead = this.conn.get(`
        SELECT l.*, c.first_name, c.last_name, c.email, c.phone
        FROM leads l
        JOIN contacts c ON c.id = l.contact_id
        WHERE l.id = ? AND l.company_id = ?
      `, [leadId, companyId]);
      if (!lead) return { recommendations: [], error: 'Lead not found' };

      const activities = this.conn.all(`
        SELECT type, title, created_at FROM activities
        WHERE company_id = ? AND contact_id = ?
        ORDER BY created_at DESC LIMIT 10
      `, [companyId, lead.contact_id]);

      const tasks = this.conn.all(`
        SELECT title, status, due_date FROM tasks
        WHERE company_id = ? AND contact_id = ?
        ORDER BY created_at DESC LIMIT 5
      `, [companyId, lead.contact_id]);

      const prompt = `You are a CRM assistant. Analyze this lead and provide 3 specific next actions.
Lead: ${lead.first_name} ${lead.last_name}
Email: ${lead.email}
Status: ${lead.lead_status}
Score: ${lead.lead_score}
Interest: ${lead.interest_level || 'unknown'}
Budget: ${lead.budget || 'unknown'}
Timeline: ${lead.timeline || 'unknown'}
Recent activities: ${activities.map(a => a.type + ': ' + a.title).join(', ') || 'none'}
Pending tasks: ${tasks.map(t => t.title + ' (' + t.status + ')').join(', ') || 'none'}

Provide exactly 3 actionable recommendations in JSON format:
{"recommendations": [{"action": "...", "priority": "high|medium|low", "reason": "...", "expectedResult": "..."}]}`;

      const response = await this.queryOllama(prompt);
      const parsed = this.parseJSON(response);
      return { recommendations: parsed.recommendations || [], raw: response };
    } catch (err) {
      return { recommendations: [], error: err.message };
    }
  }

  async getDealRecommendations(companyId, dealId) {
    try {
      const deal = this.conn.get('SELECT * FROM deals WHERE id = ? AND company_id = ?', [dealId, companyId]);
      if (!deal) return { recommendations: [], error: 'Deal not found' };

      const contact = this.conn.get('SELECT first_name, last_name, email FROM contacts WHERE id = ?', [deal.contact_id]);
      const activities = this.conn.all('SELECT type, title, created_at FROM activities WHERE company_id = ? AND deal_id = ? ORDER BY created_at DESC LIMIT 10', [companyId, dealId]);
      const tasks = this.conn.all('SELECT title, status, due_date FROM tasks WHERE company_id = ? AND deal_id = ? ORDER BY created_at DESC LIMIT 5', [companyId, dealId]);

      const prompt = `You are a CRM assistant. Analyze this deal and provide 3 specific next actions to close it.
Deal: ${deal.title}
Value: ${deal.value}
Stage: ${deal.stage_id}
Status: ${deal.status}
Probability: ${deal.probability}%
Contact: ${contact?.first_name || ''} ${contact?.last_name || ''}
Recent activities: ${activities.map(a => a.type + ': ' + a.title).join(', ') || 'none'}
Pending tasks: ${tasks.map(t => t.title + ' (' + t.status + ')').join(', ') || 'none'}

Provide exactly 3 actionable recommendations in JSON format:
{"recommendations": [{"action": "...", "priority": "high|medium|low", "reason": "...", "expectedResult": "..."}]}`;

      const response = await this.queryOllama(prompt);
      const parsed = this.parseJSON(response);
      return { recommendations: parsed.recommendations || [], raw: response };
    } catch (err) {
      return { recommendations: [], error: err.message };
    }
  }

  async getActionCenter(companyId, userId) {
    try {
      const actions = [];

      const overdueTasks = this.conn.all(`
        SELECT t.*, c.first_name, c.last_name, d.title as deal_title
        FROM tasks t
        LEFT JOIN contacts c ON c.id = t.contact_id
        LEFT JOIN deals d ON d.id = t.deal_id
        WHERE t.company_id = ? AND t.status != 'COMPLETED'
        AND t.due_date IS NOT NULL AND t.due_date < datetime('now')
        ORDER BY t.due_date ASC
      `, [companyId]);
      overdueTasks.forEach(t => actions.push({
        type: 'overdue_task',
        priority: 'high',
        title: t.title,
        reason: 'Overdue task',
        dueDate: t.due_date,
        contactId: t.contact_id,
        dealId: t.deal_id,
        entityType: 'task',
        entityId: t.id,
        expectedResult: 'Complete task'
      }));

      const dealsNoNextAction = this.conn.all(`
        SELECT d.*, c.first_name, c.last_name
        FROM deals d
        LEFT JOIN contacts c ON c.id = d.contact_id
        WHERE d.company_id = ? AND d.status = 'OPEN'
        AND (d.next_action IS NULL OR d.next_action = '')
        ORDER BY d.updated_at ASC
      `, [companyId]);
      dealsNoNextAction.forEach(d => actions.push({
        type: 'no_next_action',
        priority: 'medium',
        title: d.title,
        reason: 'No next action defined',
        contactId: d.contact_id,
        dealId: d.id,
        entityType: 'deal',
        entityId: d.id,
        expectedResult: 'Define next action'
      }));

      const staleLeads = this.conn.all(`
        SELECT l.*, c.first_name, c.last_name
        FROM leads l
        JOIN contacts c ON c.id = l.contact_id
        WHERE l.company_id = ? AND l.lead_status NOT IN ('CONVERTED', 'LOST')
        AND l.updated_at < datetime('now', '-7 days')
        ORDER BY l.updated_at ASC
      `, [companyId]);
      staleLeads.forEach(l => actions.push({
        type: 'stale_lead',
        priority: 'medium',
        title: l.first_name + ' ' + l.last_name,
        reason: 'No activity for 7+ days',
        contactId: l.contact_id,
        entityType: 'lead',
        entityId: l.id,
        expectedResult: 'Re-engage lead'
      }));

      const upcomingAppointments = this.conn.all(`
        SELECT a.*, c.first_name, c.last_name
        FROM appointments a
        LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE a.company_id = ? AND a.outcome IS NULL
        AND a.start_time >= datetime('now')
        AND a.start_time <= datetime('now', '+24 hours')
        ORDER BY a.start_time ASC
      `, [companyId]);
      upcomingAppointments.forEach(a => actions.push({
        type: 'upcoming_appointment',
        priority: 'high',
        title: a.title + ' with ' + (a.first_name || 'Unknown'),
        reason: 'Appointment within 24 hours',
        dueDate: a.start_time,
        contactId: a.contact_id,
        entityType: 'appointment',
        entityId: a.id,
        expectedResult: 'Prepare for appointment'
      }));

      actions.sort((a, b) => {
        const p = { high: 0, medium: 1, low: 2 };
        return (p[a.priority] || 1) - (p[b.priority] || 1);
      });

      return { actions, total: actions.length };
    } catch (err) {
      return { actions: [], total: 0, error: err.message };
    }
  }

  async queryOllama(prompt) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt: prompt,
          stream: false,
          options: { temperature: 0.3, max_tokens: 500 }
        }),
        signal: controller.signal
      });
      const data = await response.json();
      return data.response || '';
    } finally {
      clearTimeout(timeout);
    }
  }

  parseJSON(text) {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch {}
    return { recommendations: [] };
  }

  isAvailable() {
    return !!process.env.OLLAMA_URL;
  }
}

module.exports = { AIService };
