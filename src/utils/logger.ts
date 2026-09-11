/**
 * Console logger with two extras the error reporter needs:
 *
 * - a ring buffer of the most recent lines (all levels), so an error report can carry the
 *   context that led up to it rather than just the stack;
 * - `onError` listeners, called after every `logger.error`. Every failure in the bot already
 *   goes through `logger.error`, so hooking it here is the one place that sees them all.
 *
 * A listener that throws is swallowed: logging must never be the thing that fails.
 */

export type ErrorListener = (msg: string, args: unknown[]) => void;

const RECENT_LIMIT = 60;
const recent: string[] = [];
const errorListeners: ErrorListener[] = [];

function remember(level: string, msg: string, args: unknown[]): string {
  const line = `[${level}] [${new Date().toISOString()}] ${msg}${args.length ? ' ' + args.map(describeArg).join(' ') : ''}`;
  recent.push(line);
  if (recent.length > RECENT_LIMIT) recent.shift();
  return line;
}

function describeArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export const logger = {
  info: (msg: string, ...args: any[]) => {
    remember('INFO', msg, args);
    console.log(`[INFO] [${new Date().toISOString()}] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: any[]) => {
    remember('WARN', msg, args);
    console.warn(`[WARN] [${new Date().toISOString()}] ${msg}`, ...args);
  },
  error: (msg: string, ...args: any[]) => {
    remember('ERROR', msg, args);
    console.error(`[ERROR] [${new Date().toISOString()}] ${msg}`, ...args);
    for (const listener of errorListeners) {
      try {
        listener(msg, args);
      } catch {
        // Never let a reporter failure turn one error into two.
      }
    }
  },
  /** Subscribe to every `logger.error`. Returns an unsubscribe function. */
  onError: (listener: ErrorListener): (() => void) => {
    errorListeners.push(listener);
    return () => {
      const i = errorListeners.indexOf(listener);
      if (i >= 0) errorListeners.splice(i, 1);
    };
  },
  /** The last few dozen lines at every level, oldest first. */
  recent: (): string[] => [...recent],
};
