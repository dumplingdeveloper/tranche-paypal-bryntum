import type { Assignment, BookingConflict, MovedBooking, Resource, Schedule } from './types.ts';

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const days = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY);

// Two bookings of the same person overlap when [start, end) intervals intersect (calendar days, end exclusive).
export function bookingConflicts(schedule: Schedule, assignments: Assignment[], resources: Resource[]): BookingConflict[] {
  const out: BookingConflict[] = [];
  for (const r of resources) {
    const mine = assignments.filter((a) => a.resource === r.id && schedule.has(a.event)).map((a) => ({ id: a.event, ...schedule.get(a.event)! }))
      .sort((x, y) => (x.start === y.start ? x.id.localeCompare(y.id) : x.start.localeCompare(y.start)));
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length; j++) {
        const a = mine[i]; const b = mine[j];
        const start = a.start > b.start ? a.start : b.start;
        const end = a.end < b.end ? a.end : b.end;
        if (start < end) out.push({ resource: r.id, resource_name: r.name, task_a: a.id, task_b: b.id, overlap_start: start, overlap_end: end, overlap_days: days(start, end) });
      }
    }
  }
  return out;
}

const key = (c: BookingConflict) => `${c.resource}|${c.task_a}|${c.task_b}|${c.overlap_start}|${c.overlap_end}`;

export function capacityImpact(before: Schedule, after: Schedule, assignments: Assignment[], resources: Resource[]) {
  const moved_bookings: MovedBooking[] = [];
  for (const a of assignments) {
    const b = before.get(a.event); const n = after.get(a.event);
    if (!b || !n || b.start === n.start) continue;
    const r = resources.find((x) => x.id === a.resource);
    moved_bookings.push({ resource: a.resource, resource_name: r?.name || a.resource, task_id: a.event, old_start: b.start, new_start: n.start, delta_days: days(b.start, n.start) });
  }
  const cb = bookingConflicts(before, assignments, resources);
  const ca = bookingConflicts(after, assignments, resources);
  const beforeKeys = new Set(cb.map(key));
  const afterKeys = new Set(ca.map(key));
  return {
    moved_bookings,
    new_conflicts: ca.filter((c) => !beforeKeys.has(key(c))),
    resolved_conflicts: cb.filter((c) => !afterKeys.has(key(c))),
  };
}
