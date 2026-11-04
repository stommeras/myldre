/** "+3 min", "on time", "-1 min". */
export function formatDelay(seconds: number | null): string {
  if (seconds === null) return "delay unknown";
  const minutes = Math.round(seconds / 60);
  if (minutes === 0) return "on time";
  return minutes > 0 ? `+${minutes} min` : `${minutes} min`;
}
