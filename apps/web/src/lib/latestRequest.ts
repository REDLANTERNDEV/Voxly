/**
 * Lets only the newest of overlapping requests for one key apply its answer.
 * Answers can arrive out of order: two quick changes start two fetches, and
 * the older one's answer, landing last, would otherwise put stale state back
 * on screen. Keys are independent, so one Server's refresh never cancels
 * another's.
 */
export function latestRequests<Key>() {
  const newest = new Map<Key, number>();
  let counter = 0;
  return {
    /** Starts a request; the returned check is true while no newer one for this key has started. */
    begin(key: Key) {
      const ticket = ++counter;
      newest.set(key, ticket);
      return () => newest.get(key) === ticket;
    }
  };
}
