import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduledOccurrencesForMonth } from '../src/scheduled_payment_calendar.js';

const schedule = (overrides = {}) => ({
  frequency: 'monthly',
  firstDueDate: '2026-10-15',
  nextDueDate: '2026-10-15',
  paymentDay: 15,
  year: 2026,
  month: 11,
  ...overrides,
});

test('a month shows only its own unpaid fixed-payment occurrence', () => {
  assert.deepEqual(scheduledOccurrencesForMonth(schedule()), ['2026-11-15']);
});

test('a recurring payment is absent before its first due month', () => {
  assert.deepEqual(
    scheduledOccurrencesForMonth(schedule({ month: 9 })),
    [],
  );
});

test('monthly due dates use the last valid day of shorter months', () => {
  assert.deepEqual(
    scheduledOccurrencesForMonth(schedule({
      firstDueDate: '2026-01-30',
      paymentDay: 30,
      year: 2027,
      month: 2,
    })),
    ['2027-02-28'],
  );
});

test('one-time payments appear only in their due month', () => {
  const oneTime = schedule({
    frequency: 'once',
    nextDueDate: '2026-10-15',
    month: 11,
  });
  assert.deepEqual(scheduledOccurrencesForMonth(oneTime), []);
  assert.deepEqual(
    scheduledOccurrencesForMonth({ ...oneTime, month: 10 }),
    ['2026-10-15'],
  );
});
