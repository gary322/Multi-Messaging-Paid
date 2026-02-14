// Allows common username style handles while keeping them URL-safe and predictable.
// - Lowercase enforced by normalization
// - Must start with alphanumeric
// - Allows `_` and `-` after first char
const HANDLE_REGEX = /^[a-z0-9][a-z0-9_-]{2,39}$/;

const RESERVED_HANDLES = new Set([
  'admin',
  'support',
  'help',
  'root',
  'system',
  'api',
  'mmp',
  'pricing',
  'messages',
  'auth',
  'verify',
  'vault',
  'channels',
  'compliance',
  'observability',
  'health',
]);

export function normalizeHandle(input: string) {
  return input.trim().replace(/^@/, '').toLowerCase();
}

export function isReservedHandle(handle: string) {
  return RESERVED_HANDLES.has(normalizeHandle(handle));
}

export function isValidHandle(handle: string) {
  const normalized = normalizeHandle(handle);
  return HANDLE_REGEX.test(normalized) && !RESERVED_HANDLES.has(normalized);
}
