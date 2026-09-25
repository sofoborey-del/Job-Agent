export type QuietHours = {
  startHour: number;
  endHour: number;
  timeZone: string;
};

export function localHour(now: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    hour12: false,
    timeZone,
  });
  const parsed = Number(formatter.format(now));
  return Number.isFinite(parsed) ? parsed % 24 : now.getUTCHours();
}

/** Quiet hours may wrap midnight, for example 22:00 to 08:00. */
export function inQuietHours(now: Date, quietHours: QuietHours | null): boolean {
  if (quietHours === null) return false;
  if (quietHours.startHour === quietHours.endHour) return false;
  const hour = localHour(now, quietHours.timeZone);
  return quietHours.startHour < quietHours.endHour
    ? hour >= quietHours.startHour && hour < quietHours.endHour
    : hour >= quietHours.startHour || hour < quietHours.endHour;
}
