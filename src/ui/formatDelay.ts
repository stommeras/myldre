export function formatDelay(seconds: number | null): string {
  if (seconds === null) return "ukjent forsinkelse";
  const minutes = Math.round(seconds / 60);
  if (minutes === 0) return "i rute";
  return minutes > 0 ? `+${minutes} min` : `${minutes} min`;
}
