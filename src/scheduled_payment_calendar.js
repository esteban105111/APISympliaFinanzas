const monthKey = (year, month) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;

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
