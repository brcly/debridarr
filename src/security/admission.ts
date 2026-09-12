export class BusyError extends Error {
  readonly status = 429;
  constructor() { super('The server is busy. Try again shortly.'); }
}
export class Admission {
  private active = 0;
  private starts: number[] = [];
  private readonly maximum: number;
  private readonly perMinute: number;
  constructor(maximum: number, perMinute = Infinity) {
    this.maximum = maximum;
    this.perMinute = perMinute;
  }
  enter(now = Date.now()): () => void {
    this.starts = this.starts.filter(t => now - t < 60_000);
    if (this.active >= this.maximum || this.starts.length >= this.perMinute) throw new BusyError();
    this.active++;
    if (Number.isFinite(this.perMinute)) this.starts.push(now);
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
  snapshot(): { active: number; max: number } {
    return { active: this.active, max: this.maximum };
  }
}
