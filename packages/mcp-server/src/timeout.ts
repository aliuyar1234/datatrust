export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  makeTimeoutError: () => Error = () => new TimeoutError('Operation timed out')
): Promise<T> {
  if (!timeoutMs) return promise;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(makeTimeoutError()), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

