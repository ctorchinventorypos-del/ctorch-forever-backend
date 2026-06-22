// ============================================================
//  Small input guards used on the write endpoints. These sit IN FRONT of
//  the database (which already uses parameterized queries) as a second wall:
//  they reject missing, wrong-typed, or oversized fields early with a clear
//  message instead of letting odd data reach the logic.
// ============================================================

// Trim + length-cap a string field. Returns { ok, value, error }.
function str(value, { field, required = false, max = 255, min = 0 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) return { ok: false, error: `${field} is required.` };
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') return { ok: false, error: `${field} must be text.` };
  const v = value.trim();
  if (required && v.length < Math.max(min, 1)) return { ok: false, error: `${field} is required.` };
  if (v.length > max) return { ok: false, error: `${field} is too long (max ${max}).` };
  return { ok: true, value: v };
}

// A non-negative number within a sane range.
function num(value, { field, max = 1e12 } = {}) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || isNaN(n)) {
    return { ok: false, error: `${field} must be a number.` };
  }
  if (n < 0) return { ok: false, error: `${field} cannot be negative.` };
  if (n > max) return { ok: false, error: `${field} is too large.` };
  return { ok: true, value: n };
}

// Cap how many items an array body can carry (stops abuse / huge payloads).
function capArray(value, { field, max = 300 } = {}) {
  if (!Array.isArray(value)) return { ok: false, error: `${field} must be a list.` };
  if (value.length > max) return { ok: false, error: `Too many ${field} (max ${max}).` };
  return { ok: true, value };
}

module.exports = { str, num, capArray };
