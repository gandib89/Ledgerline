// Matches the repo convention already used by authenticate/authorize/resolve-tenant:
// a plain Error with .status and .code, not a class hierarchy (app.js's error
// handler reads err.status/err.code/err.message directly).
function taggedError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export const notFound = (message = 'Not found') => taggedError(404, 'not_found', message);
export const conflict = (code, message) => taggedError(409, code, message);
export const businessRule = (code, message) => taggedError(422, code, message);
export const forbidden = (message = 'Missing required permission') => taggedError(403, 'forbidden', message);
export const internal = (message) => taggedError(500, 'internal_error', message);
