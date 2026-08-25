/**
 * `YYYY-MM-DD` for an instant in a zone. `Intl` rather than offset
 * arithmetic — India is +05:30 and half-hour offsets are exactly where
 * hand-rolled conversion goes wrong. The attendance module has its own copy
 * inside the day engine; the platform cannot import it (technical design §1)
 * and eight lines is cheaper than a shared package for one function.
 */
export function localDateIn(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * The IST calendar date of an instant. The nightly snapshot jobs (D-22,
 * D-23) key their photographs by this: dates are stored UTC and displayed
 * IST, so the books' day boundary is IST midnight — an instant from 18:30Z
 * onward already belongs to the next IST day, and a photograph keyed by the
 * UTC date would file the evening's book under yesterday's page. Both jobs
 * share this one function so their tables can never disagree on which date
 * a night belongs to.
 */
export function istDateOf(instantIso: string): string {
  return localDateIn(new Date(instantIso), 'Asia/Kolkata');
}
