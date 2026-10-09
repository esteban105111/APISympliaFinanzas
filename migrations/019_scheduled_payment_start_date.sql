ALTER TABLE scheduled_payments
  ADD COLUMN IF NOT EXISTS start_date date;

-- Preserve the original first occurrence for existing schedules rather than
-- starting every legacy fixed expense over from the migration date.
WITH schedule_dates AS (
  SELECT
    p.id,
    p.frequency,
    p.next_due_date,
    p.payment_day,
    (p.created_at AT TIME ZONE 'America/Bogota')::date AS created_local_date,
    date_trunc('month', p.created_at AT TIME ZONE 'America/Bogota')::date AS created_month
  FROM scheduled_payments p
  WHERE p.start_date IS NULL
), inferred AS (
  SELECT
    id,
    frequency,
    next_due_date,
    CASE
      WHEN frequency = 'once' THEN next_due_date
      ELSE LEAST(
        CASE
          WHEN created_local_date > (
            created_month
            + LEAST(payment_day, EXTRACT(day FROM (created_month + interval '1 month - 1 day'))::integer)
            - 1
          )::date
          THEN (
            (created_month + interval '1 month')::date
            + LEAST(payment_day, EXTRACT(day FROM (created_month + interval '2 month - 1 day'))::integer)
            - 1
          )::date
          ELSE (
            created_month
            + LEAST(payment_day, EXTRACT(day FROM (created_month + interval '1 month - 1 day'))::integer)
            - 1
          )::date
        END,
        next_due_date
      )
    END AS inferred_start_date
  FROM schedule_dates
)
UPDATE scheduled_payments p
SET start_date = inferred.inferred_start_date
FROM inferred
WHERE p.id = inferred.id;

ALTER TABLE scheduled_payments
  ALTER COLUMN start_date SET DEFAULT current_date,
  ALTER COLUMN start_date SET NOT NULL;
