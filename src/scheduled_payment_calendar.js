const monthKey = (year, month) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;

/** Returns the first monthly due date on or after a schedule's start date. */
export function firstScheduledDueDate(startDate, paymentDay) {
  const text = startDate instanceof Date
    ? startDate.toISOString().slice(0, 10)
    : String(startDate).slice(0, 10);
  const [year, month, day] = text.split('-').map(Number);
  const requestedDay = Number(paymentDay);
  const currentMonthLastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const currentMonthDueDay = Math.min(requestedDay, currentMonthLastDay);
  const monthIndex = month - 1 + (day > currentMonthDueDay ? 1 : 0);
  const dueYear = year + Math.floor(monthIndex / 12);
  const dueMonth = monthIndex % 12;
  const lastDay = new Date(Date.UTC(dueYear, dueMonth + 1, 0)).getUTCDate();
  return `${monthKey(dueYear, dueMonth + 1)}-${String(Math.min(requestedDay, lastDay)).padStart(2, '0')}`;
}

/** Keeps paid occurrences out of the next-due reminder when a schedule is edited. */
export function nextUnpaidScheduledDueDate(startDate, paymentDay, paidDates = new Set()) {
  const firstDue = firstScheduledDueDate(startDate, paymentDay);
  const [year, month] = firstDue.split('-').map(Number);
  for (let offset = 0; offset < 1200; offset += 1) {
    const cursor = new Date(Date.UTC(year, month - 1 + offset, 1));
    const [dueDate] = scheduledOccurrencesForMonth({
      frequency: 'monthly', firstDueDate: firstDue, nextDueDate: firstDue,
      paymentDay, year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1,
    });
    if (!paidDates.has(dueDate)) return dueDate;
  }
  return null;
}

/** Returns only the occurrence belonging to the requested calendar month. */
export function scheduledOccurrencesForMonth({
  frequency,
  firstDueDate,
  nextDueDate,
  paymentDay,
  year,
  month,
}) {
  const selectedMonth = monthKey(year, month);

  if (frequency !== 'monthly') {
    return nextDueDate.slice(0, 7) === selectedMonth ? [nextDueDate] : [];
  }

  if (selectedMonth < firstDueDate.slice(0, 7)) return [];

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = String(Math.min(Number(paymentDay), lastDay)).padStart(2, '0');
  const dueDate = `${selectedMonth}-${day}`;
  return dueDate >= firstDueDate ? [dueDate] : [];
}
