export function createAuthRequestGate() {
  let generation = 0;

  return {
    begin() {
      generation += 1;
      return generation;
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(requestGeneration: number) {
      return requestGeneration === generation;
    }
  };
}
