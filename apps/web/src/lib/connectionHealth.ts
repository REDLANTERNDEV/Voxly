export type ConnectionQuality = "measuring" | "good" | "fair" | "poor";

export function medianRtt(samples: number[]) {
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

export function connectionQualityForRtt(rttMs: number | null): ConnectionQuality {
  if (rttMs === null) return "measuring";
  if (rttMs <= 150) return "good";
  if (rttMs <= 300) return "fair";
  return "poor";
}
