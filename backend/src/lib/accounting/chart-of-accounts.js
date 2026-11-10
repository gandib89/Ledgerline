// Fixed by convention across the whole plan (§5 seed set, every worked
// example): the AR control account is always 1100. Nothing else in the
// system hardcodes an account code — tax accounts come from tax_codes,
// everything else from the account the document line names.
export const AR_ACCOUNT_CODE = '1100';
export const AP_ACCOUNT_CODE = '2100';

// Cash in Hand is not flagged as a bank account (so it stays out of bank
// reconciliation) but is a valid paid-from account, found by code.
export const CASH_IN_HAND_CODE = '1010';
