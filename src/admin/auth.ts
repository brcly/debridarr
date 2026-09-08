import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_MS = 12 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
export const COOKIE_NAME = 'debridarr_session';
interface Session { csrfToken: string; expires: number }

export class Sessions {
  private readonly passwordHash: Buffer;
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, { count: number; expires: number }>();
  constructor(password: string, private readonly now = Date.now) {
    this.passwordHash = createHash('sha256').update(password).digest();
  }

  login(password: string, address: string): { token: string; session: Session } | 'invalid' | 'throttled' {
    this.prune();
    const attempt = this.attempts.get(address) ?? { count: 0, expires: this.now() + WINDOW_MS };
    if (attempt.count >= 5) return 'throttled';
    if (!timingSafeEqual(createHash('sha256').update(password).digest(), this.passwordHash)) {
      attempt.count += 1;
      if (this.attempts.size >= 1000 && !this.attempts.has(address)) return 'throttled';
      this.attempts.set(address, attempt);
      return 'invalid';
    }
    this.attempts.delete(address);
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    const session = { csrfToken: randomBytes(32).toString('hex'), expires: this.now() + SESSION_MS };
    this.sessions.set(token, session);
    return { token, session };
  }
  get(token: string): Session | undefined { this.prune(); return this.sessions.get(token); }
  delete(token: string): void { this.sessions.delete(token); }
  private prune(): void {
    for (const [token, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(token);
    for (const [address, attempt] of this.attempts) if (attempt.expires <= this.now()) this.attempts.delete(address);
  }
}

export function sessionCookie(token: string, secure: boolean, clear = false): string {
  return `${COOKIE_NAME}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}
