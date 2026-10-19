// Times in the log: a strict ISO-8601 date-time with a mandatory zone, Z or ±hh:mm
// (e.g. 2026-10-19T09:30:00Z, 2026-10-19T15:00:00.250+05:30). Parsed by hand, never with
// Date.parse, so a guard's answer can't depend on the process's time zone (a zone-less
// time is local time to Date.parse) or on its leniency (2026-02-30, T24:00).
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

// Milliseconds since the epoch, or undefined when v isn't such a time.
export function isoMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const m = ISO_TIME.exec(v);
  if (!m) return undefined;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Math.floor(Number(`0${m[7]}`) * 1000);
  const offH = m[9] === undefined ? 0 : Number(m[9]);
  const offM = m[10] === undefined ? 0 : Number(m[10]);
  if (h > 23 || mi > 59 || sec > 59 || offH > 23 || offM > 59) return undefined;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d); // no two-digit-year mapping, unlike Date.UTC
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return undefined; // 2026-02-30
  t.setUTCHours(h, mi, sec, ms);
  const sign = m[8] === "-" ? -1 : 1;
  return t.getTime() - sign * (offH * 60 + offM) * 60_000;
}

export const isIsoTime = (v: unknown): v is string => isoMs(v) !== undefined;
