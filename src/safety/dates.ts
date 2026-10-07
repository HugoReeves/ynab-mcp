import { ToolFailure } from '../errors.js';
function invalid(): never { throw new ToolFailure({ code: 'validation_error', message: 'Invalid UTC calendar date or date window.', retryable: false, outcome: 'not_applied' }); }
export function assertCalendarDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) invalid();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid();
}
function today(nowMs: number): string { const d = new Date(nowMs); if (!Number.isFinite(d.getTime())) invalid(); return d.toISOString().slice(0, 10); }
export function resolveReadMonth(value: string, nowMs: number): string {
  if (value === 'current') return `${today(nowMs).slice(0, 7)}-01`;
  assertCalendarDate(value); if (!value.endsWith('-01')) invalid(); return value;
}
export function assertTransactionDate(value: string, nowMs: number): void { assertCalendarDate(value); if (value > today(nowMs)) invalid(); }
function shiftYear(nowMs: number, years: number): string {
  const day = today(nowMs); const year = Number(day.slice(0, 4)) + years;
  if (year < 1 || year > 9999) invalid();
  const prefix = `${String(year).padStart(4, '0')}${day.slice(4, 8)}`;
  const candidate = `${prefix}${day.slice(8)}`;
  const date = new Date(`${candidate}T00:00:00.000Z`);
  return date.toISOString().slice(0, 7) === candidate.slice(0, 7) ? candidate : `${prefix}28`;
}
export function assertScheduledDate(value: string, nowMs: number): void { assertCalendarDate(value); if (value <= today(nowMs) || value > shiftYear(nowMs, 5)) invalid(); }
export function oneYearAgo(nowMs: number): string { return shiftYear(nowMs, -1); }
