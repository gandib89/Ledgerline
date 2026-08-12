-- A line is a debit or a credit. Never both, never negative, never neither.
ALTER TABLE "JournalLine" ADD CONSTRAINT jl_sign_check
  CHECK (debit >= 0 AND credit >= 0
         AND NOT (debit > 0 AND credit > 0)
         AND (debit > 0 OR credit > 0));

-- Move the balance check from JournalEntry to JournalLine, so it re-fires
-- on any line change to an existing entry too, not just entry creation.
DROP TRIGGER journal_entry_balanced ON "JournalEntry";

CREATE OR REPLACE FUNCTION assert_journal_entry_balanced()
RETURNS TRIGGER AS $$
DECLARE
  target_entry_id TEXT;
  total_debit     NUMERIC(18,4);
  total_credit    NUMERIC(18,4);
BEGIN
  target_entry_id := COALESCE(NEW."journalEntryId", OLD."journalEntryId");

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM "JournalLine"
   WHERE "journalEntryId" = target_entry_id;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: debit % <> credit %',
      target_entry_id, total_debit, total_credit;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_line_balanced
  AFTER INSERT OR UPDATE OR DELETE ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_journal_entry_balanced();
