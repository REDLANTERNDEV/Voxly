export interface PreparedDesktopLaunch { id: string; account: string; expiresAt: number }

/** Public correlation only; stale responses are cancelled rather than reused. */
export class DesktopLaunchPreparation {
  private generation = 0;
  private launch: PreparedDesktopLaunch | null = null;
  private pending: Promise<PreparedDesktopLaunch | null> | null = null;
  constructor(private create: () => Promise<{ id: string; account: string }>, private cancel: (id: string) => Promise<unknown>, private now = Date.now) {}
  async prepare(): Promise<PreparedDesktopLaunch | null> {
    if (this.launch && this.launch.expiresAt > this.now()) return this.launch;
    if (this.pending) return this.pending;
    this.clear();
    const generation = this.generation;
    // The server bounds correlation to three minutes; renew conservatively.
    const expiresAt = this.now() + 150_000;
    const pending = this.create().then((launch) => {
      if (generation !== this.generation || expiresAt <= this.now()) {
        void this.cancel(launch.id).catch(() => undefined);
        return null;
      }
      this.launch = { ...launch, expiresAt };
      return this.launch;
    }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }
  clear(completed = false) {
    this.generation++;
    if (this.launch && !completed) void this.cancel(this.launch.id).catch(() => undefined);
    this.launch = null;
    this.pending = null;
  }
}
