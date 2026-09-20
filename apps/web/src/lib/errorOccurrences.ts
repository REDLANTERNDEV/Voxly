export interface ErrorOccurrence<Key extends string = string> {
  key: Key;
  count: number;
  revision: number;
}

/**
 * Records failures as events rather than only as messages.
 *
 * React may ignore setting the same error string twice. Keeping a separate
 * revision makes a repeated failed action visible, while the count groups
 * repeats of the same reason instead of stacking duplicate alerts.
 */
export function recordErrorOccurrence<Key extends string>(
  current: ErrorOccurrence<Key> | null,
  key: Key
): ErrorOccurrence<Key> {
  return {
    key,
    count: current?.key === key ? current.count + 1 : 1,
    revision: (current?.revision ?? 0) + 1
  };
}
