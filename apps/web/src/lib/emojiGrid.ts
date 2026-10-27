/**
 * Where an arrow key goes in the emoji picker's grid, as an index into its
 * buttons in reading order. Left and right wrap along the whole list; up and
 * down move a row and stop at the edges rather than jumping to the far end.
 * Returns null for a key the grid does not handle.
 */
export function moveInGrid(index: number, key: string, columns: number, length: number): number | null {
  if (length <= 0) return null;
  const width = Math.max(1, columns);
  const last = length - 1;
  switch (key) {
    case "ArrowRight":
      return index >= last ? 0 : index + 1;
    case "ArrowLeft":
      return index <= 0 ? last : index - 1;
    case "ArrowDown":
      return Math.min(last, index + width);
    case "ArrowUp":
      return Math.max(0, index - width);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}
