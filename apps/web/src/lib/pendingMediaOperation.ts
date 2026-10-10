/** A replacement owns the busy guard; an old completion cannot release it. */
export function createPendingMediaOperation(changed: (pending: boolean) => void) {
  let generation = 0;
  let pending = false;
  return {
    isPending: () => pending,
    cancel() {
      generation += 1;
      pending = false;
      changed(false);
    },
    async run<T>(action: () => Promise<T>): Promise<T> {
      const ticket = ++generation;
      pending = true;
      changed(true);
      try {
        return await action();
      } finally {
        if (ticket === generation) {
          pending = false;
          changed(false);
        }
      }
    }
  };
}
