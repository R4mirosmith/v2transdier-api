export class AppError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function notFound(message = 'Recurso no encontrado') {
  return new AppError(404, 'NOT_FOUND', message);
}
