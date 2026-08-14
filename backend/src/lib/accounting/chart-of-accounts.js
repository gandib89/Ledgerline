// Fixed by convention across the whole plan (§5 seed set, every worked
// example): the AR control account is always 1100. Nothing else in the
// system hardcodes an account code — tax accounts come from tax_codes,
// everything else from the account the document line names.
export const AR_ACCOUNT_CODE = '1100';
