export function decryptPdf(bytes, { password = '', signal } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./qpdf-worker.js', import.meta.url));
    const finish = (error, result) => {
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new DOMException('Merge cancelled.', 'AbortError'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.error) {
        const error = new Error(data.error);
        error.code = data.code;
        finish(error);
      } else finish(null, data.bytes);
    };
    worker.onerror = () => finish(new Error('Could not load the local PDF unlocking engine. Please reload and try again.'));
    // The original File remains unchanged. Worker memory is released on completion.
    const copy = bytes.slice();
    worker.postMessage({ bytes: copy.buffer, password }, [copy.buffer]);
  });
}
