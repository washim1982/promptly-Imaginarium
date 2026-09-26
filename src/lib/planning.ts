export interface PlanDetails { title: string; location: string; start: string; end: string; family: string; budget: string; notes: string }
export function endExclusive(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}
export const mapsUrl = (location: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
export function calendarUrl(plan: PlanDetails, text: string): string {
  return `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: 'TEMPLATE', text: plan.title, location: plan.location, dates: `${plan.start.replaceAll('-', '')}/${endExclusive(plan.end || plan.start)}`, details: text.slice(0, 1500) })}`;
}
export function calendarFile(plan: PlanDetails, text: string): string {
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r/g, '');
  // Fold by UTF-8 bytes, without splitting a Unicode character (RFC 5545).
  const fold = (s: string) => {
    let line = '', length = 0, out = '';
    for (const c of s) {
      const bytes = new TextEncoder().encode(c).length;
      if (length + bytes > 75) { out += line + '\r\n'; line = ' '; length = 1; }
      line += c; length += bytes;
    }
    return out + line;
  };
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OMNI-STUDIO//Planning//EN', 'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@omni-studio`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART;VALUE=DATE:${plan.start.replaceAll('-', '')}`, `DTEND;VALUE=DATE:${endExclusive(plan.end || plan.start)}`,
    `SUMMARY:${escape(plan.title)}`, `LOCATION:${escape(plan.location)}`, `DESCRIPTION:${escape(text)}`,
    'END:VEVENT', 'END:VCALENDAR', ''].map(fold).join('\r\n');
}
