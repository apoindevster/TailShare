import type { Progress } from "./session";

// Only presentation is throttled. Transfer validation and backpressure still run
// for every chunk; new files, completion and clearing are delivered immediately.
export function progressReporter(
  commit: (value: Progress | undefined) => void,
  interval = 100,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: Progress | undefined;
  let last = -Infinity;
  let file = "";
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    cancel();
    last = performance.now();
    commit(latest);
  };
  return {
    report(value: Progress | undefined) {
      latest = value;
      if (!value) {
        cancel();
        file = "";
        last = -Infinity;
        commit(undefined);
        return;
      }
      if (
        file !== value.entry.id ||
        value.bytes === value.total ||
        performance.now() - last >= interval
      ) {
        file = value.entry.id;
        flush();
      } else if (!timer)
        timer = setTimeout(flush, interval - (performance.now() - last));
    },
    dispose: cancel,
  };
}
