export function errorHandler(error, _req, res, _next) {
  const status = error.status || 500;
  const code = error.code || 'INTERNAL_ERROR';
  const message = status === 500 ? 'Ocurrió un error interno.' : error.message;

  if (status === 500) {
    console.error(error);
  }

  res.status(status).json({
    success: false,
    code,
    message,
    details: error.details || null
  });
}
