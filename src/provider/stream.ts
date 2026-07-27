import { ProviderError, type ProviderErrorKind, type ProviderRetryNotice } from "./types.js";

export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 1_800_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

export class StreamStalledError extends Error {
  constructor(message = "stream stalled") {
    super(message);
    this.name = "StreamStalledError";
  }
}

export class AttemptTimeoutError extends Error {
  constructor(message = "request attempt timed out") {
    super(message);
    this.name = "AttemptTimeoutError";
  }
}

export class TotalTimeoutError extends Error {
  constructor(message = "total request deadline exceeded") {
    super(message);
    this.name = "TotalTimeoutError";
  }
}

export interface RetryOptions<T> {
  callerSignal: AbortSignal;
  idleTimeoutMs: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
  maxRetryAfterMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  random?: () => number;
  onRetry?: (notice: ProviderRetryNotice) => void | Promise<void>;
  runAttempt: (context: {
    signal: AbortSignal;
    resetIdleTimer: () => void;
    markEmitted: () => void;
  }) => Promise<T>;
}

export async function withProviderRetries<T>(options: RetryOptions<T>): Promise<T> {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const maxRetryAfterMs = Math.max(0, Math.trunc(options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS));
  const totalController = new AbortController();
  const totalSignal = AbortSignal.any([options.callerSignal, totalController.signal]);
  const totalTimer: NodeJS.Timeout | undefined = options.totalTimeoutMs > 0
    ? setTimeout(() => totalController.abort(new TotalTimeoutError()), options.totalTimeoutMs)
    : undefined;
  totalTimer?.unref();

  try {
    if (options.callerSignal.aborted) throw options.callerSignal.reason ?? new Error("request aborted");
    for (let attempt = 0; ; attempt += 1) {
      if (options.callerSignal.aborted) throw options.callerSignal.reason ?? new Error("request aborted");
      let emitted = false;
      const attemptController = new AbortController();
      const signal = AbortSignal.any([options.callerSignal, totalController.signal, attemptController.signal]);
      let idleTimer: NodeJS.Timeout | undefined;
      let requestTimer: NodeJS.Timeout | undefined;
      const clearIdleTimer = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = undefined;
      };
      const resetIdleTimer = (): void => {
        clearIdleTimer();
        if (options.idleTimeoutMs <= 0 || signal.aborted) return;
        idleTimer = setTimeout(
          () => attemptController.abort(new StreamStalledError()),
          options.idleTimeoutMs,
        );
        idleTimer.unref?.();
      };
      if (options.requestTimeoutMs > 0) {
        requestTimer = setTimeout(
          () => attemptController.abort(new AttemptTimeoutError()),
          options.requestTimeoutMs,
        );
        requestTimer.unref?.();
      }

      try {
        resetIdleTimer();
        return await options.runAttempt({
          signal,
          resetIdleTimer,
          markEmitted: () => { emitted = true; },
        });
      } catch (error) {
        if (options.callerSignal.aborted) {
          throw options.callerSignal.reason ?? error;
        }
        if (totalController.signal.aborted) {
          throw totalController.signal.reason ?? error;
        }
        const normalized = normalizeRetryError(error, attemptController.signal.reason);
        clearIdleTimer();
        clearTimeout(requestTimer);
        requestTimer = undefined;
        if (emitted || attempt + 1 >= maxAttempts || !normalized.retryable) throw normalized;
        const delayMs = retryDelay(
          normalized,
          attempt,
          maxRetryAfterMs,
          options.retryBaseDelayMs ?? 1_000,
          options.random ?? Math.random,
        );
        if (options.onRetry) {
          await options.onRetry({
            attempt: attempt + 2,
            maxAttempts,
            delayMs,
            error: normalized,
          });
        }
        await sleep(delayMs, totalSignal);
      } finally {
        clearIdleTimer();
        clearTimeout(requestTimer);
      }
    }
  } catch (error) {
    if (options.callerSignal.aborted) throw options.callerSignal.reason ?? error;
    if (totalController.signal.aborted) {
      throw normalizeRetryError(error, totalController.signal.reason);
    }
    throw error;
  } finally {
    clearTimeout(totalTimer);
  }
}

export function normalizeRetryError(error: unknown, attemptReason?: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (attemptReason instanceof StreamStalledError || error instanceof StreamStalledError) {
    return new ProviderError(attemptReason instanceof Error ? attemptReason.message : "stream stalled", {
      kind: "transport",
      retryable: true,
    });
  }
  if (attemptReason instanceof AttemptTimeoutError || error instanceof AttemptTimeoutError) {
    return new ProviderError(attemptReason instanceof Error ? attemptReason.message : "request attempt timed out", {
      kind: "transport",
      retryable: true,
    });
  }
  if (attemptReason instanceof TotalTimeoutError || error instanceof TotalTimeoutError) {
    return new ProviderError(attemptReason instanceof Error ? attemptReason.message : "total request deadline exceeded", {
      kind: "transport",
      retryable: false,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(message || "provider transport failed", {
    kind: "transport",
    retryable: true,
    cause: error,
  });
}

export function retryDelay(
  error: ProviderError,
  attempt: number,
  maxRetryAfterMs: number,
  retryBaseDelayMs: number,
  random: () => number,
): number {
  const kindMultiplier = error.kind === "rate_limit" || error.kind === "overloaded" ? 2 : 1;
  const exponential = retryBaseDelayMs * kindMultiplier * 2 ** attempt;
  const minimum = Math.min(maxRetryAfterMs, Math.max(error.retryAfterMs ?? 0, exponential));
  const jitter = Math.floor(minimum * Math.max(0, Math.min(1, random())) * 0.3);
  return Math.min(maxRetryAfterMs, minimum + jitter);
}

export interface RetryAfterValue {
  milliseconds?: number;
  exceeded: boolean;
}

export function parseRetryAfter(value: string | null, maxRetryAfterMs: number): RetryAfterValue {
  if (!value) return { exceeded: false };
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1_000)
    : Math.max(0, Date.parse(value) - Date.now());
  if (!Number.isFinite(milliseconds)) return { exceeded: false };
  if (milliseconds > maxRetryAfterMs) {
    return { milliseconds: maxRetryAfterMs, exceeded: true };
  }
  return { milliseconds, exceeded: false };
}

export function createProviderHttpError(
  provider: string,
  status: number,
  body: string,
  retryAfterHeader: string | null,
  maxRetryAfterMs: number,
): ProviderError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const record = isRecord(parsed) ? parsed : undefined;
  const nested = record && isRecord(record.error) ? record.error : undefined;
  const providerErrorType = firstString(
    nested?.type,
    record?.type,
    nested?.code,
    record?.code,
  );
  const message = firstString(nested?.message, record?.message) ?? body;
  const kind = classifyProviderErrorKind(status, providerErrorType, `${message} ${body}`);
  const retryAfter = parseRetryAfter(retryAfterHeader, maxRetryAfterMs);
  const retryable = retryableKind(kind) && !retryAfter.exceeded;
  const suffix = retryAfter.exceeded ? ` (retry-after exceeds ${maxRetryAfterMs}ms maximum)` : "";
  return new ProviderError(`${provider} HTTP ${status}: ${message.slice(0, 2_000)}${suffix}`, {
    kind,
    status,
    retryable,
    ...(providerErrorType === undefined ? {} : { providerErrorType }),
    ...(retryAfter.milliseconds === undefined ? {} : { retryAfterMs: retryAfter.milliseconds }),
  });
}

export function createProviderStreamError(
  provider: string,
  message: string,
  providerErrorType?: string,
): ProviderError {
  const classified = classifyProviderErrorKind(0, providerErrorType, message);
  const kind = classified === "transport" ? "invalid_request" : classified;
  return new ProviderError(`${provider} stream error: ${message}`, {
    kind,
    retryable: retryableKind(kind),
    ...(providerErrorType === undefined ? {} : { providerErrorType }),
  });
}

function classifyProviderErrorKind(
  status: number,
  providerErrorType: string | undefined,
  detail: string,
): ProviderErrorKind {
  const normalized = `${providerErrorType ?? ""} ${detail}`.toLowerCase();
  if (status === 401 || status === 403 || /authentication|unauthorized|invalid[_ -]?api[_ -]?key/.test(normalized)) return "auth";
  if (/quota|credit|exhaust|billing|套餐|额度/.test(normalized)) return "quota";
  if (status === 429 || /rate[_ -]?limit|too many requests/.test(normalized)) return "rate_limit";
  if (status === 529 || /overload|overloaded|capacity/.test(normalized)) return "overloaded";
  if (/context[_ -]?length|prompt is too long|maximum context|too many tokens/.test(normalized)) return "context_length";
  if (status === 408) return "transport";
  if (status >= 500 && status <= 599) return "server";
  if (status >= 400 && status <= 499) return "invalid_request";
  return "transport";
}

function retryableKind(kind: ProviderErrorKind): boolean {
  return kind === "rate_limit" || kind === "overloaded" || kind === "server" || kind === "transport";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("request aborted");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    buffer = buffer.replaceAll("\r\n", "\n");
    const data = buffer.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) yield data;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort);
    resolve();
  }, milliseconds);
  timer.unref?.();
  const abort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("request aborted"));
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return promise;
}
