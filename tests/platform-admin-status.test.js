const { UsersController } = require('../server/controllers/users.controller');

function controllerForAdmin() {
  const controller = Object.create(UsersController.prototype);
  controller.conn = {
    get: (sql) => (sql.includes('SELECT id FROM users') ? { id: 'admin' } : { is_admin: 1 }),
    run: vi.fn(),
  };
  return controller;
}

describe('platform administrator status protection', () => {
  it('rejects generic account deactivation', async () => {
    const controller = controllerForAdmin();
    const next = vi.fn();

    await controller.remove({ params: { id: 'admin' }, user: { companyId: 'default' } }, {}, next);

    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
    expect(controller.conn.run).not.toHaveBeenCalled();
  });

  it('rejects an update that changes a platform administrator away from ACTIVE', async () => {
    const controller = controllerForAdmin();
    const next = vi.fn();

    await controller.update({
      params: { id: 'admin' },
      user: { companyId: 'default' },
      body: { status: 'INACTIVE' },
    }, {}, next);

    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
    expect(controller.conn.run).not.toHaveBeenCalled();
  });
});
