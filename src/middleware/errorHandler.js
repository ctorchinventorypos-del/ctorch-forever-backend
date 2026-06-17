// ============================================================
//  errorHandler: catches any error thrown inside a route and
//  returns a clean message. Hides internal details in production.
//  Must be registered LAST in app.js.
// ============================================================
function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;
  const message =
    process.env.NODE_ENV === 'production'
      ? 'Something went wrong. Please try again.'
      : err.message;
  res.status(status).json({ error: message });
}

module.exports = { errorHandler };
