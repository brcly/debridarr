export class BusyError extends Error {
  readonly status = 429;
  constructor() { super('The server is busy. Try again shortly.'); }
}
export class Admission {
  private active = 0;
  private starts: number[] = [];
  constructor(private maximum: number, private perMinute = Infinity) {}
  enter(now = Date.now()): () => void {
    this.starts = this.starts.filter(t => now - t < 60_000);
    if (this.active >= this.maximum || this.starts.length >= this.perMinute) throw new BusyError();
    this.active++;
    if (Number.isFinite(this.perMinute)) this.starts.push(now);
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
}
