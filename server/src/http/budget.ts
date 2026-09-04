/**
 * A request budget per client, per window.
 *
 * The service pays a network fee for every submission that it accepts. A route
 * with no budget is therefore a way to spend the channel accounts down. The
 * budget is generous next to what a person with two phones does, and small
 * next to what a script does. It bounds the cost, and it is not an
 * authentication system, because anyone may still use the service.
 */

/** How long one budget window lasts, in milliseconds. */
export const RATE_WINDOW_MS = 60_000;

/** Requests per window on the routes that cost a network fee. */
export const RATE_LIMIT_SPEND = 12;

/** Requests per window on the routes that cost nothing on chain. */
export const RATE_LIMIT_READ = 120;

/** Clients tracked at once. The oldest windows go first beyond this number. */
export const RATE_MAX_CLIENTS = 5000;

/** What one window holds for one client. */
interface Window {
  startedAt: number;
  spend: number;
  read: number;
}

/** Whether a request fits the budget, and what remains of the window. */
export interface Budget {
  readonly allowed: boolean;
  readonly limit: number;
  readonly used: number;
  readonly resetMs: number;
}

/** The budget windows, one per client address. */
export class RequestBudget {
  private readonly windows = new Map<string, Window>();

  /** Count one request against a client's budget. */
  take(address: string, spending: boolean, now = Date.now()): Budget {
    let window = this.windows.get(address);
    if (window === undefined || now - window.startedAt >= RATE_WINDOW_MS) {
      window = { startedAt: now, spend: 0, read: 0 };
      this.windows.set(address, window);
    }
    if (this.windows.size > RATE_MAX_CLIENTS) this.forget(now);
    const limit = spending ? RATE_LIMIT_SPEND : RATE_LIMIT_READ;
    const used = spending ? (window.spend += 1) : (window.read += 1);
    return {
      allowed: used <= limit,
      limit,
      used,
      resetMs: RATE_WINDOW_MS - (now - window.startedAt),
    };
  }

  /** Drop the windows that already ran out. */
  private forget(now: number): void {
    for (const [address, window] of this.windows) {
      if (now - window.startedAt >= RATE_WINDOW_MS) this.windows.delete(address);
    }
  }
}
