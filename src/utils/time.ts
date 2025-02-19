// unix time constants
export const seconds = 1;
export const minutes = 60 * seconds;
export const hours = 60 * minutes;
export const days = 24 * hours;
// add conversion to JS milliseconds (eg. 1 * minute * inMs)
export const inMs = 1000;

// find milliseconds until a timeout time (useful for setTimeout)
export function getMsLeft(timeoutMs: number): () => number {
  const startTime = Date.now();
  const endTime = startTime + timeoutMs;
  return () => endTime - Date.now();
}
