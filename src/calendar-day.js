/** Calendar day of an instant in an explicit timezone, independent of the host clock zone. */
export function calendarDay(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(instant);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year').padStart(4, '0')}-${value('month')}-${value('day')}`;
}
