import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_MS = 12 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const COOKIE_NAME = 'debridarr_session';

export function cookieValue(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== name) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return value;
  }
  return '';
}
interface Session { csrfToken: string; expires: number; idleExpires: number }

export class Sessions {
  private readonly salt = randomBytes(16);
  private readonly passwordHash: Buffer;
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, { count: number; expires: number }>();
  private verifying = 0;
  private readonly now: () => number;
  constructor(password: string, now = Date.now) {
    this.now = now;
    // Startup only. Requests use the asynchronous KDF with bounded concurrency.
    this.passwordHash = scryptSync(password, this.salt, 32, SCRYPT);
  }

  async login(password: string, address: string): Promise<{ token: string; session: Session } | 'invalid' | 'throttled' | 'busy'> {
    this.prune();
    const attempt = this.attempts.get(address) ?? { count: 0, expires: this.now() + WINDOW_MS };
    if (attempt.count >= 5 || (this.attempts.size >= 1000 && !this.attempts.has(address))) return 'throttled';
    if (this.verifying >= 2) return 'busy';
    // Reserve the attempt before yielding so concurrent failures cannot bypass the limit.
    attempt.count += 1;
    this.attempts.set(address, attempt);
    if (Buffer.byteLength(password) > 1024) return 'invalid';
    this.verifying++;
    try {
      const hash = await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, this.salt, 32, SCRYPT, (error, key) => error ? reject(error) : resolve(key));
      });
      if (!timingSafeEqual(hash, this.passwordHash)) return 'invalid';
    } finally { this.verifying--; }
    if (this.attempts.get(address) === attempt) this.attempts.delete(address);
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    const session = { csrfToken: randomBytes(32).toString('hex'), expires: this.now() + SESSION_MS, idleExpires: this.now() + IDLE_MS };
    this.sessions.set(token, session);
    return { token, session };
  }
  get(token: string): Session | undefined {
    this.prune();
    const session = this.sessions.get(token);
    if (session) session.idleExpires = this.now() + IDLE_MS;
    return session;
  }
  delete(token: string): void { this.sessions.delete(token); }
  private prune(): void {
    for (const [token, session] of this.sessions) if (session.expires <= this.now() || session.idleExpires <= this.now()) this.sessions.delete(token);
    for (const [address, attempt] of this.attempts) if (attempt.expires <= this.now()) this.attempts.delete(address);
  }
}

export function validCsrf(value: unknown, expected: string): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'));
}

export function sessionCookie(token: string, secure: boolean, clear = false): string {
  return `${COOKIE_NAME}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}
