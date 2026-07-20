export const MEDIA_FETCH_TIMEOUT_MS = 15_000;

export type BoundedFetchFailure =
  | { reason: 'status'; status: number }
  | { reason: 'size'; contentLength?: number }
  | { reason: 'error'; error: unknown };

async function readBoundedBody(
  response: Response,
  controller: AbortController,
  maxBytes: number,
): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? null : buffer;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function fetchBoundedBuffer(
  url: string,
  options: {
    maxBytes: number;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    onFailure?: (failure: BoundedFetchFailure) => void;
  },
): Promise<Buffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? MEDIA_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await (options.fetchFn ?? fetch)(url, { signal: controller.signal });
    if (!response.ok) {
      options.onFailure?.({ reason: 'status', status: response.status });
      return null;
    }

    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      options.onFailure?.({ reason: 'size', contentLength });
      return null;
    }
    const buffer = await readBoundedBody(response, controller, options.maxBytes);
    if (!buffer) options.onFailure?.({ reason: 'size' });
    return buffer;
  } catch (error) {
    options.onFailure?.({ reason: 'error', error });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
