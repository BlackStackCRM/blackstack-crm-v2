function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPagination(req, defaults = { limit: 20, maxLimit: 100 }) {
  const maxLimit = defaults.maxLimit || 100;
  const limit = Math.min(
    parseInt(req.query.limit) || parseInt(req.query.pageSize) || defaults.limit,
    maxLimit
  );
  const page = parseInt(req.query.page) || 1;
  const offset = parseInt(req.query.offset) || (page - 1) * limit;
  return { limit, offset, page };
}

function getUserId(req) {
  return req.user?.userId;
}

module.exports = { asyncHandler, getPagination, getUserId };