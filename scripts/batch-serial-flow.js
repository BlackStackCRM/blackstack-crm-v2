/**
 * Batch-tracked and serial-tracked bill flows for the visible UI regression.
 *
 * Phases 6 and 7. Runs inside the already-authenticated browser page, driving
 * the running application's own HTTP API — the same origin, session and token a
 * user would use — then reading the resulting stock and ledger state back.
 *
 * Fixtures come from scripts/seed-regression-tracked.js:
 *   TEST-BATCH-001  batch-tracked, 100 units in batch TEST-BATCH-001
 *   TEST-SERIAL-001 serial-tracked, 2 serials, both `available`
 *
 * NOTHING here writes stock directly. Bills are created, submitted, approved,
 * posted and cancelled through the real endpoints, and every quantity change is
 * checked against the API's view of stock and, afterwards, against the database.
 *
 * Business rules are asserted as they are implemented, not as imagined. The
 * serial phase in particular asserts that saving WITHOUT a serial is rejected —
 * if that ever stops being enforced, this reports FAIL rather than passing.
 */

/** Runs entirely in the browser. Returns a plain result object for the caller. */
const batchSerialFlow = async (page, phase) => page.evaluate(async (mode) => {
  const t = localStorage.getItem('crm_token');
  const h = t ? { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } : {};
  const api = async (m, ep, b) => {
    const r = await fetch(ep, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { /* non-JSON */ }
    return { s: r.status, d };
  };
  const body = (r) => JSON.stringify(r && r.d || {}).slice(0, 240);

  // ── Fixtures ───────────────────────────────────────────────────────────
  const contacts = await api('GET', '/api/contacts?limit=1');
  const contact = contacts.d?.data?.items?.[0] || contacts.d?.items?.[0];
  const godowns = await api('GET', '/api/inventory/masters/godowns?limit=50');
  const allGodowns = godowns.d?.data?.items || godowns.d?.items || [];
  if (!contact || !allGodowns.length) {
    return { error: `missing fixture contact=${!!contact} godowns=${allGodowns.length}` };
  }

  const wantedSku = mode === 'batch' ? 'TEST-BATCH-001' : 'TEST-SERIAL-001';
  const products = await api('GET', '/api/products?limit=200');
  const all = products.d?.data?.items || products.d?.items || [];
  const prod = all.find((p) => p.sku === wantedSku);
  if (!prod) return { error: `seeded product ${wantedSku} not found (seed ran?)` };
  const itemId = prod.stockItemId || prod.stock_item_id || null;

  /**
   * The bill must be issued from the godown the stock actually sits in.
   *
   * BillInventoryBridge validates that the batch/serial is held in the same
   * godown as the line, and availability is per-godown, so taking godowns[0]
   * blindly produces a false "insufficient stock" / "different godown" failure
   * whenever the list is not ordered the way the seed placed the stock.
   * Resolve it from the stock row instead of guessing.
   */
  const placement = await api('GET', '/api/inventory/stocks?limit=300');
  const placementRows = placement.d?.data?.items || placement.d?.items || [];
  const myStock = placementRows.find((x) => x.id === itemId
    || x.stockItemId === itemId || x.stock_item_id === itemId);
  const godown = (myStock && (myStock.godownId || myStock.godown_id))
    ? allGodowns.find((g) => g.id === (myStock.godownId || myStock.godown_id))
    : null;
  if (!godown) {
    return { error: `could not resolve the godown holding ${wantedSku} (stock row: ${JSON.stringify(myStock)})` };
  }

  /** On-hand for a stock item, from the canonical stock list endpoint. */
  const stockOf = async () => {
    if (!itemId) return null;
    const r = await api('GET', '/api/inventory/stocks?limit=300');
    const items = r.d?.data?.items || r.d?.items || [];
    const row = items.find((x) => x.id === itemId || x.stockItemId === itemId || x.stock_item_id === itemId);
    if (!row) return null;
    return parseFloat(row.onHandQty ?? row.on_hand_qty ?? row.quantity ?? 0);
  };
  /**
   * On-hand restricted to the batch rows of this item, proving batch isolation.
   * Real route: /api/inventory/reports/batch-stock (server/routes/inventory.js:90).
   * Rows are one-per-batch and carry item_id / batch_number / quantity.
   */
  const batchStockOf = async () => {
    const r = await api('GET', '/api/inventory/reports/batch-stock');
    if (r.s >= 400) return { error: `batch-stock HTTP ${r.s}: ${body(r)}` };
    const items = r.d?.data?.items || r.d?.items || [];
    const row = items.find((x) => (x.item_id || x.itemId) === itemId);
    if (!row) return null;
    return parseFloat(row.quantity ?? row.onHandQty ?? 0);
  };

  /**
   * Serial rows for this item.
   * Real route: /api/inventory/reports/serials (server/routes/inventory.js:102),
   * which accepts ?item_id=. There is no /api/inventory/serials endpoint.
   */
  const serialsOf = async () => {
    const r = await api('GET', `/api/inventory/reports/serials?item_id=${encodeURIComponent(itemId)}&limit=200`);
    if (r.s >= 400) return { error: `serials HTTP ${r.s}: ${body(r)}` };
    const items = r.d?.data?.items || r.d?.items || [];
    return items.map((s) => ({
      serial: s.serial_number || s.serialNumber,
      status: s.status,
    }));
  };

  /**
   * Batches for this item. Batches have no dedicated route; the generic master
   * route /api/inventory/masters/batches lists them and each row carries item_id.
   */
  const batchesOf = async () => {
    const r = await api('GET', '/api/inventory/masters/batches?limit=300');
    if (r.s >= 400) return { error: `masters/batches HTTP ${r.s}: ${body(r)}` };
    const items = r.d?.data?.items || r.d?.items || [];
    return items
      .filter((b) => (b.item_id || b.itemId) === itemId)
      .map((b) => ({ id: b.id, number: b.batch_number || b.batchNumber }));
  };

  const before = await stockOf();
  const beforeBatch = mode === 'batch' ? await batchStockOf() : null;
  const beforeSerials = mode === 'serial' ? await serialsOf() : null;
  // The helpers report endpoint failures as {error} rather than throwing.
  if (beforeBatch && beforeBatch.error) return { error: beforeBatch.error };
  if (beforeSerials && beforeSerials.error) return { error: beforeSerials.error };

  const today = new Date().toISOString().slice(0, 10);
  const baseItem = {
    product_id: prod.id,
    description: prod.name,
    quantity: 1,
    unit_price: parseFloat(prod.price) || 100,
    discount: 0,
    tax_rate: 0,
    godown_id: godown.id,
    location_id: godown.location_id || null,
  };
  const mkBill = (items) => ({
    company_id: 'default',
    contact_id: contact.id,
    bill_type: 'CUSTOMER',
    issue_date: today,
    due_date: today,
    currency: 'INR',
    items,
  });

  // ═══ SERIAL PHASE ═══
  // Step 1: posting a serial-tracked bill WITHOUT a serial must be rejected.
  //
  // Note WHERE this is enforced: creation succeeds and the rejection happens at
  // POST, inside BillInventoryBridge, which is where stock actually moves. So
  // the probe must drive create -> submit -> approve -> post and assert the POST
  // is refused. Asserting that CREATE fails would be testing a rule that does
  // not exist.
  if (mode === 'serial') {
    const badBill = await api('POST', '/api/customer-bills', mkBill([{ ...baseItem }]));
    if (badBill.s >= 400) {
      var noSerialGuard = { rejected: true, at: 'create', status: badBill.s, detail: body(badBill) };
    } else {
      const badId = badBill.d?.data?.id || badBill.d?.data?.bill?.id || badBill.d?.id;
      if (!badId) return { error: 'no bill id returned for the no-serial probe' };
      await api('POST', `/api/customer-bills/${badId}/submit`, {});
      await api('POST', `/api/customer-bills/${badId}/approve`, {});
      const badPost = await api('POST', `/api/customer-bills/${badId}/post`, {});
      const refused = badPost.s >= 400 || /serial/i.test(body(badPost));
      // Leave the refused draft cancelled so it cannot linger in the test data.
      await api('POST', `/api/customer-bills/${badId}/cancel`, { reason: 'regression no-serial probe' });
      if (!refused) {
        return {
          error: `serial validation MISSING: posting a bill for ${wantedSku} with no serial `
            + `was accepted (HTTP ${badPost.s}). Expected BillInventoryBridge to refuse it.`,
        };
      }
      var noSerialGuard = { rejected: true, at: 'post', status: badPost.s, detail: body(badPost) };
    }
  }

  // ═══ BATCH PHASE: resolve the batch to sell from ═══
  let batchId = null;
  let batchNumber = null;
  if (mode === 'batch') {
    const batches = await batchesOf();
    if (!batches.length) return { error: `no batch found for ${wantedSku}` };
    // Prefer the seeded batch explicitly.
    const seeded = batches.find((b) => b.number === 'TEST-BATCH-001') || batches[0];
    batchId = seeded.id; batchNumber = seeded.number;
  }

  // ═══ SERIAL PHASE: pick an available serial ═══
  let serialNumber = null;
  if (mode === 'serial') {
    const available = (beforeSerials || []).find((s) => s.status === 'available');
    if (!available) return { error: `no available serial for ${wantedSku}: ${JSON.stringify(beforeSerials)}` };
    serialNumber = available.serial;
  }

  // ── Create -> submit -> approve -> post ────────────────────────────────
  const line = { ...baseItem };
  if (mode === 'batch') {
    line.batch_id = batchId;
    line.batch_number = batchNumber;   // bridge also resolves by number
  }
  if (mode === 'serial') line.serial_number = serialNumber;

  const created = await api('POST', '/api/customer-bills', mkBill([line]));
  if (created.s >= 400) return { error: `create failed ${created.s}: ${body(created)}` };
  const billId = created.d?.data?.id || created.d?.data?.bill?.id || created.d?.id;
  if (!billId) return { error: 'no bill id returned' };

  await api('POST', `/api/customer-bills/${billId}/submit`, {});
  await api('POST', `/api/customer-bills/${billId}/approve`, {});
  const posted = await api('POST', `/api/customer-bills/${billId}/post`, {});
  if (posted.s >= 400) {
    return { error: `post failed ${posted.s}: ${body(posted)}`, billId, before, beforeSerials, batchId, batchNumber, serialNumber, noSerialGuard };
  }

  const afterPost = await stockOf();
  const afterPostBatch = mode === 'batch' ? await batchStockOf() : null;
  const afterPostSerials = mode === 'serial' ? await serialsOf() : null;

  const billRes = await api('GET', `/api/customer-bills/${billId}`);
  const bill = billRes.d?.data?.bill || billRes.d?.data || billRes.d;

  // ── Cancel ─────────────────────────────────────────────────────────────
  const cancelled = await api('POST', `/api/customer-bills/${billId}/cancel`, { reason: 'regression test' });
  const afterCancel = await stockOf();
  const afterCancelBatch = mode === 'batch' ? await batchStockOf() : null;
  const afterCancelSerials = mode === 'serial' ? await serialsOf() : null;

  return {
    billId, itemId, batchId, batchNumber, serialNumber,
    before, afterPost, afterCancel,
    beforeBatch, afterPostBatch, afterCancelBatch,
    beforeSerials, afterPostSerials, afterCancelSerials,
    postedStatus: bill?.status,
    cancelStatus: cancelled.s,
    noSerialGuard: typeof noSerialGuard !== 'undefined' ? noSerialGuard : null,
  };
}, phase);

module.exports = { batchSerialFlow };
