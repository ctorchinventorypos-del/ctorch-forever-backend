// ============================================================
//  Helpers for the "choose / edit the date of an action" feature.
//  actionDate: sanitises an optional user-supplied date for a NEW
//  record (returns null so SQL COALESCE falls back to now()).
//  editDate:   validates a date for editing an EXISTING record.
//  We keep the original time-of-day when only a date is supplied,
//  and never allow a date far in the future.
// ============================================================
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000; // allow up to ~1 day ahead (timezone slack)

function toValid(input) {
  if (!input) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  if (d.getTime() > Date.now() + MAX_FUTURE_MS) return null; // no far-future dating
  // If a bare date (YYYY-MM-DD) was given, stamp it at local noon so the
  // day is unambiguous across timezones.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(input).trim())) {
    return new Date(String(input).trim() + 'T12:00:00').toISOString();
  }
  return d.toISOString();
}

// For NEW records: returns ISO string or null (SQL uses now() when null).
function actionDate(input) {
  return toValid(input);
}

// For EDITING: returns ISO string, or throws a 400 if invalid/missing.
function editDate(input) {
  const v = toValid(input);
  if (!v) { const e = new Error('Enter a valid date (not in the future).'); e.status = 400; throw e; }
  return v;
}

module.exports = { actionDate, editDate };
