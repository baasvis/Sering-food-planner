function logError(route, error, req) {
  const entry = {
    level: 'error',
    ts: new Date().toISOString(),
    route,
    method: req ? req.method : undefined,
    path: req ? req.originalUrl : undefined,
    message: error.message || String(error),
  };
  console.error(JSON.stringify(entry));
}

module.exports = { logError };
