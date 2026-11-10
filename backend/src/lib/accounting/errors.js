// Matches the repo convention already used by authenticate/authorize/resolve-tenant:
// a plain Error with .status and .code, not a class hierarchy (app.js's error
// handler reads err.status/err.code/err.message directly).
// `details` (optional) is passed through to the client by the error handler.
function taggedError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

export const notFound = (message = 'Not found') => taggedError(404, 'not_found', message);
export const conflict = (code, message, details) => taggedError(409, code, message, details);
export const businessRule = (code, message, details) => taggedError(422, code, message, details);
export const forbidden = (message = 'Missing required permission') => taggedError(403, 'forbidden', message);
export const internal = (message) => taggedError(500, 'internal_error', message);
