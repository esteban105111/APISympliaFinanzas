import assert from 'node:assert/strict';
import test from 'node:test';
import {
  firstScheduledDueDate,
  nextUnpaidScheduledDueDate,
  scheduledOccurrencesForMonth,
} from '../src/scheduled_payment_calendar.js';

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

test('a recurring expense starting next month is absent in the current month', () => {
  assert.deepEqual(
    scheduledOccurrencesForMonth(schedule({
      firstDueDate: '2026-11-15',
      year: 2026,
      month: 10,
    })),
    [],
  );
  assert.deepEqual(
    scheduledOccurrencesForMonth(schedule({ firstDueDate: '2026-11-15' })),
    ['2026-11-15'],
  );
});

test('a start date after the selected payment day begins on the next occurrence', () => {
  assert.equal(firstScheduledDueDate('2026-11-16', 15), '2026-12-15');
  assert.deepEqual(
    scheduledOccurrencesForMonth(schedule({
      firstDueDate: '2026-12-15',
      year: 2026,
      month: 11,
    })),
    [],
  );
});

test('a payment scheduled for day 30 starts on the last valid day in February', () => {
  assert.equal(firstScheduledDueDate('2027-02-01', 30), '2027-02-28');
});

test('editing a fixed expense preserves already-paid monthly occurrences', () => {
  assert.equal(
    nextUnpaidScheduledDueDate('2026-09-01', 15, new Set(['2026-09-15', '2026-10-15'])),
    '2026-11-15',
  );
  assert.equal(
    nextUnpaidScheduledDueDate('2026-11-01', 15, new Set(['2026-09-15', '2026-10-15'])),
    '2026-11-15',
  );
});

test('paying a later month does not erase an earlier pending occurrence', () => {
  assert.equal(
    nextUnpaidScheduledDueDate('2026-09-01', 30, new Set(['2026-10-30'])),
    '2026-09-30',
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
