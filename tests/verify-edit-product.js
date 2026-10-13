/**
 * Test: Edit product with only location_id and godown_id (no inventory_group_id/item_group_id)
 */
const http = require('http');

function apiRequest(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const options = {
      hostname: '127.0.0.1', port: 3000, path: path, method: method,
      headers: data ? { ...headers, 'Content-Length': Buffer.byteLength(data) } : headers,
    };
    const req = http.request(options, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // Login
  console.log('[1] Logging in...');
  const loginResp = await apiRequest('/api/auth/login', 'POST', {
    email: 'admin@blackstack.local', password: 'admin123'
  });
  const loginData = JSON.parse(loginResp.body);
  const token = loginData?.data?.token;
  console.log('   Token:', token ? 'OK' : 'FAILED');

  // Create a test product with location + godown (no inventory/item groups)
  console.log('[2] Creating test product...');
  const createResp = await apiRequest('/api/products', 'POST', {
    name: 'Edit Test Product',
    sku: 'EDIT-TEST-' + Date.now(),
    price: 200,
    cost: 100,
    is_active: 1,
    stock_group_id: 'grp_electronics',
    stock_category_id: 'cat_electronics',
    brand_id: 'bran_01M3JKNX9755SSA7EXN0RMJAXF',
    model_id: 'mode_01M3JKP5HSF8G9Z6SG9WQNE23K',
    track_inventory: 1,
    location_id: 'loca_01M3QATHF80KBZ4V9JCXHKF2FF',
    godown_id: 'god_001',
    is_serial_tracked: 1,
    is_batch_tracked: 0,
    opening_quantity: 2,
    serial_numbers: ['SN-EDIT-001', 'SN-EDIT-002']
  }, token);
  const createData = JSON.parse(createResp.body);
  const productId = createData?.data?.id || createData?.id;
  console.log('   Product ID:', productId);
  console.log('   Status:', createResp.status);

  if (createResp.status !== 201) {
    console.log('   ERROR:', createData);
    process.exit(1);
  }

  // Now EDIT the product — send only location_id + godown_id, NO inventory_group_id/item_group_id
  console.log('[3] Editing product (location_id + godown_id only, no groups)...');
  const editResp = await apiRequest(`/api/products/${productId}`, 'PUT', {
    name: 'Edit Test Product Updated',
    location_id: 'loca_01M3QATHF80KBZ4V9JCXHKF2FF',
    godown_id: 'god_001'
  }, token);
  const editData = JSON.parse(editResp.body);
  console.log('   Status:', editResp.status);
  console.log('   Response:', JSON.stringify(editData).substring(0, 200));

  if (editResp.status === 200 || editResp.status === 201) {
    console.log('\n========== ✅ EDIT SUCCESS ==========');
    console.log('Product update with Location + Godown only (no groups) works!');
    console.log('======================================\n');
  } else {
    console.log('\n========== ❌ EDIT FAILED ==========');
    console.log('Status:', editResp.status);
    console.log('Error:', editData?.error?.message || editData?.message);
    console.log('======================================\n');
  }

  // Cleanup
  console.log('[4] Cleaning up test data...');
  await apiRequest(`/api/products/${productId}`, 'DELETE', null, token);
  console.log('   Done');

  process.exit(0);
})().catch(err => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});
