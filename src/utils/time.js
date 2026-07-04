import { DateTime } from 'luxon';

export const COLOMBIA_ZONE = 'America/Bogota';

export function utcNowSql() {
  return DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss');
}

export function sqlUtcToColombia(value) {
  if (!value) return null;
  return DateTime.fromSQL(String(value), { zone: 'utc' }).setZone(COLOMBIA_ZONE).toFormat('yyyy-MM-dd HH:mm:ss');
}

export function fromColombiaDateRangeToUtc(dateFrom, dateTo) {
  const start = DateTime.fromISO(dateFrom, { zone: COLOMBIA_ZONE }).startOf('day').toUTC();
  const end = DateTime.fromISO(dateTo || dateFrom, { zone: COLOMBIA_ZONE }).endOf('day').toUTC();
  return {
    startUtc: start.toFormat('yyyy-MM-dd HH:mm:ss'),
    endUtc: end.toFormat('yyyy-MM-dd HH:mm:ss')
  };
}

export function todayColombiaRangeToUtc() {
  const today = DateTime.now().setZone(COLOMBIA_ZONE).toISODate();
  return { localDate: today, ...fromColombiaDateRangeToUtc(today, today) };
}

export function colombiaEndOfDayUtcForNow() {
  return DateTime.now().setZone(COLOMBIA_ZONE).endOf('day').toUTC().toFormat('yyyy-MM-dd HH:mm:ss');
}

export function colombiaEndOfDayUtcForDate(dateIso) {
  return DateTime.fromISO(dateIso, { zone: COLOMBIA_ZONE }).endOf('day').toUTC().toFormat('yyyy-MM-dd HH:mm:ss');
}
