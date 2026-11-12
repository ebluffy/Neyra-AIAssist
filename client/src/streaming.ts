export const TOKEN_BATCH_MS = 60;

/** A single pending timer publishes token bursts; idle streams schedule no work. */
export function createTokenBatch(publish: (text: string) => void) {
  let text = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    text = '';
  };
  return {
    push(token: string) {
      if (!token) return;
      text += token;
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        publish(text);
      }, TOKEN_BATCH_MS);
    },
    reset() { cancel(); publish(''); },
    dispose: cancel,
  };
}
