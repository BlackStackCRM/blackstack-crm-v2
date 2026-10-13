const { ContactRepository } = require('../repositories/contact.repository');
const { OrganizationRepository } = require('../repositories/organization.repository');
const { DealRepository } = require('../repositories/deal.repository');
const { ProductRepository } = require('../repositories/product.repository');
const { InvoiceRepository } = require('../repositories/invoice.repository');
const { BillRepository } = require('../repositories/billing-cost.repository');
const { TaskRepository } = require('../repositories/task.repository');
const { ActivityRepository } = require('../repositories/activity.repository');

class SearchService {
  constructor(conn) {
    this.conn = conn;
  }

  async globalSearch(query, context) {
    const term = `%${query.toLowerCase()}%`;
    const results = {
      contacts: [],
      organizations: [],
      deals: [],
      products: [],
      invoices: [],
      bills: [],
      tasks: [],
      activities: []
    };

    const contactRepo = new ContactRepository(this.conn);
    const contactResult = await contactRepo.search({
      companyId: context.companyId,
      query,
      limit: 10,
      offset: 0
    });
    results.contacts = contactResult.items.map(c => ({ ...c, type: 'contact', label: `${c.first_name} ${c.last_name || ''}` }));

    const orgRepo = new OrganizationRepository(this.conn);
    const orgResult = await orgRepo.search({
      companyId: context.companyId,
      query,
      limit: 10,
      offset: 0
    });
    results.organizations = orgResult.items.map(o => ({ ...o, type: 'organization', label: o.name }));

    const dealRepo = new DealRepository(this.conn);
    const dealResult = await dealRepo.search({
      companyId: context.companyId,
      query,
      limit: 10,
      offset: 0
    });
    results.deals = dealResult.items.map(d => ({ ...d, type: 'deal', label: d.title }));

    const productRepo = new ProductRepository(this.conn);
    const productResult = await productRepo.search({
      companyId: context.companyId,
      query,
      limit: 10,
      offset: 0
    });
    results.products = productResult.items.map(p => ({ ...p, type: 'product', label: p.name }));

    const invoiceRepo = new InvoiceRepository(this.conn);
    const invoiceResult = await invoiceRepo.search({
      companyId: context.companyId,
      query,
      limit: 10,
      offset: 0
    });
    results.invoices = invoiceResult.items.map(i => ({ ...i, type: 'invoice', label: i.invoice_number }));

    const billRepo = new BillRepository(this.conn);
    const billResult = await billRepo.search({
      companyId: context.companyId, query, limit: 10, offset: 0, billType: 'CUSTOMER'
    });
    results.bills = billResult.items.map(b => ({ ...b, type: 'bill', label: b.bill_number }));

    const taskRepo = new TaskRepository(this.conn);
    const taskResult = await taskRepo.search({
      companyId: context.companyId,
      query,
      limit: 10,
      offset: 0
    });
    results.tasks = taskResult.items.map(t => ({ ...t, type: 'task', label: t.title }));

    const activityRepo = new ActivityRepository(this.conn);
    const activityResult = await activityRepo.search({
      companyId: context.companyId,
      query,
      limit: 10,
      offset: 0
    });
    results.activities = activityResult.items.map(a => ({ ...a, type: 'activity', label: a.title }));

    return results;
  }
}

module.exports = { SearchService };
