/**
 * Throttled function interface with cancel and flush controls.
 */
export interface ThrottledFunction<T extends (...args: any[]) => void> {
  (...args: Parameters<T>): void;
  flush(): void;
  cancel(): void;
}

/**
 * Creates a throttled function that only invokes func at most once per every wait milliseconds.
 * Always fires a trailing call if invoked during the waiting window.
 */
export function trailingThrottle<T extends (...args: any[]) => void>(
  func: T,
  waitMs: number,
): ThrottledFunction<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  let lastArgs: Parameters<T> | null = null;

  const throttled = function (...args: Parameters<T>): void {
    lastArgs = args;

    if (!timeoutId) {
      timeoutId = setTimeout(() => {
        timeoutId = null;
        if (lastArgs) {
          const currentArgs = lastArgs;
          lastArgs = null;
          func(...currentArgs);
        }
      }, waitMs);
    }
  } as ThrottledFunction<T>;

  throttled.flush = (): void => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (lastArgs) {
      const currentArgs = lastArgs;
      lastArgs = null;
      func(...currentArgs);
    }
  };

  throttled.cancel = (): void => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    lastArgs = null;
  };

  return throttled;
}

export const throttleTrailing = trailingThrottle;
