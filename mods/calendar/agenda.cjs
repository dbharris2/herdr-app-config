const { execFileSync } = require('node:child_process');
const path = require('node:path');
const ical = require('node-ical');

async function main() {
  let url;
  try { url = execFileSync('/usr/bin/swift', [path.join(__dirname, 'keychain.swift'), 'get'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { console.log(JSON.stringify({ needsLink: true })); return; }
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw new Error(`Calendar request failed (HTTP ${response.status})`);
  const data = ical.sync.parseICS(await response.text());
  const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (from.getDay() + 6) % 7);
  const to = new Date(from); to.setDate(to.getDate() + 14);
  const events = [];
  for (const event of Object.values(data)) {
    if (event.type !== 'VEVENT' || event.status === 'CANCELLED' || !event.start) continue;
    const instances = event.rrule ? ical.expandRecurringEvent(event, { from, to, expandOngoing: true }) : [event];
    for (const item of instances) {
      if (item.status === 'CANCELLED' || !item.start || new Date(item.start) >= to || new Date(item.end || item.start) < from) continue;
      events.push({ title: String(item.summary || '(No title)'), start: new Date(item.start).toISOString(), end: new Date(item.end || item.start).toISOString(), allDay: Boolean(item.isFullDay || item.datetype === 'date') });
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  console.log(JSON.stringify({ events }));
}
main().catch(() => { console.error('Could not load the calendar. Check the address and network connection.'); process.exit(1); });
