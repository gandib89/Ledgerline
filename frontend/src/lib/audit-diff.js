function isObject(value) {
  return value !== null && typeof value === 'object';
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!isObject(left) || !isObject(right) || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
}

export function diffAuditValues(before, after) {
  const previous = isObject(before) && !Array.isArray(before) ? before : {};
  const next = isObject(after) && !Array.isArray(after) ? after : {};

  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .sort()
    .filter((field) => !sameValue(previous[field], next[field]))
    .map((field) => ({
      field,
      kind: !(field in previous) ? 'added' : !(field in next) ? 'removed' : 'changed',
      before: previous[field],
      after: next[field],
    }));
}

export function formatAuditValue(value) {
  if (value === undefined) return 'Not set';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
