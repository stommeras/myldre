export function formatDelay(seconds: number | null): string {
  if (seconds === null) return "ukjent forsinkelse";
  const minutes = Math.sign(seconds) * Math.round(Math.abs(seconds) / 60);
  if (!minutes) return "i rute";
  return minutes > 0 ? `+${minutes} min` : `${minutes} min`;
}
