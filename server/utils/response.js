function successResponse(data, status = 200) {
  return { success: true, data, status };
}

function errorResponse(code, message, status = 400) {
  return { success: false, error: { code, message }, status };
}

function paginatedResponse(items, total, page, limit) {
  return {
    success: true,
    data: {
      items,
      pagination: {
        total,
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
        pages: Math.ceil(total / (parseInt(limit) || 20))
      }
    }
  };
}

module.exports = { successResponse, errorResponse, paginatedResponse };
