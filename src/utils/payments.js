// ============================================================
//  One sale / payment can be settled with more than one method
//  (e.g. part cash, part transfer). buildSplits validates a list
//  of {method, amount} against the amount actually being paid, and
//  returns { splits, primary } where splits is a clean JSON array
//  (or null when a single method is used) and primary is the method
//  stored on the row for display / fallback.
// ============================================================
const VALID_METHODS = ['cash', 'pos', 'transfer_moniepoint', 'transfer_zenith', 'cheque'];

function buildSplits(rawSplits, expectedAmount, fallbackMethod) {
  const single = VALID_METHODS.includes(fallbackMethod) ? fallbackMethod : 'cash';

  if (!Array.isArray(rawSplits) || rawSplits.length === 0) {
    return { splits: null, primary: single };
  }

  const clean = [];
  let sum = 0;
  for (const s of rawSplits) {
    const method = VALID_METHODS.includes(s && s.method) ? s.method : null;
    const amount = Number(s && s.amount);
    if (!method) { const e = new Error('Each payment line needs a valid method.'); e.status = 400; throw e; }
    if (!(amount > 0)) { const e = new Error('Each payment line needs an amount greater than 0.'); e.status = 400; throw e; }
    clean.push({ method, amount: Math.round(amount * 100) / 100 });
    sum += amount;
  }

  // A single line is just a normal single-method payment.
  if (clean.length === 1) return { splits: null, primary: clean[0].method };

  // The split amounts must add up to what's being paid (allow 1 kobo rounding).
  if (Math.abs(sum - Number(expectedAmount)) > 0.01) {
    const e = new Error(`The payment lines add up to ${sum.toLocaleString()} but the amount paid is ${Number(expectedAmount).toLocaleString()}.`);
    e.status = 400; throw e;
  }

  return { splits: JSON.stringify(clean), primary: clean[0].method };
}

module.exports = { buildSplits, VALID_METHODS };
