const CRUD = {
  async list(entity, params = {}) {
    const query = new URLSearchParams(params).toString();
    const endpoint = `/${entity}${query ? `?${query}` : ''}`;
    return window.API.get(endpoint);
  },

  async get(entity, id) {
    return window.API.get(`/${entity}/${id}`);
  },

  async create(entity, data) {
    return window.API.post(`/${entity}`, data);
  },

  async update(entity, id, data) {
    return window.API.put(`/${entity}/${id}`, data);
  },

  async remove(entity, id) {
    return window.API.del(`/${entity}/${id}`);
  },
};

window.CRUD = CRUD;
