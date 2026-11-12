import type { WorkerRequest } from "./worker-rpc";

declare const self: {
  postMessage(value: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  location: Location;
};
const scope = globalThis as unknown as Record<string, any>;
const methods = new Set([
  "tailshareListen",
  "tailshareDial",
  "tailshareIO",
  "tailshareStop",
  "tailshareCLIStart",
  "tailshareCLIConnect",
  "tailshareCLIFile",
  "tailshareCLIDirectory",
  "tailshareCLIUpload",
  "tailshareCLIClose",
]);
let initialization: Promise<void> | undefined;
function stage(value: string) {
  self.postMessage({ event: "stage", value });
}
async function initialize(wasm: string, runtime: string) {
  for (const address of [wasm, runtime])
    if (new URL(address).origin !== self.location.origin)
      throw new Error("Invalid transport asset origin.");
  stage("Downloading transfer engine");
  try {
    await import(/* @vite-ignore */ runtime);
  } catch {
    throw new Error(
      "Could not load the transfer engine. Check your connection; reload this page if the site was updated.",
    );
  }
  const response = await fetch(wasm, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body)
    throw new Error(
      "Could not download the transfer engine. Check your connection; reload this page if the site was updated.",
    );
  // Static hosts may already have decoded Content-Encoding.
  const stream = response.body;
  const reader = stream.getReader();
  const first = await reader.read();
  const prefix: Uint8Array<ArrayBuffer>[] = first.value ? [first.value] : [];
  let length = first.value?.length ?? 0;
  while (length < 2 && !first.done) {
    const next = await reader.read();
    if (next.done) break;
    prefix.push(next.value);
    length += next.value.length;
  }
  const magic = prefix.flatMap((part) => [...part.subarray(0, 2)]).slice(0, 2);
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      if (prefix.length) {
        controller.enqueue(prefix.shift()!);
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const decoded =
    magic[0] === 0x1f && magic[1] === 0x8b
      ? body.pipeThrough(new DecompressionStream("gzip"))
      : body;
  const go = new scope.Go();
  // Streaming compilation avoids retaining both a full compressed and inflated copy.
  const { instance } = await WebAssembly.instantiateStreaming(
    new Response(decoded, { headers: { "Content-Type": "application/wasm" } }),
    go.importObject,
  );
  stage("Starting transfer engine");
  await new Promise<void>((resolve, reject) => {
    scope.onTailcatReady = resolve;
    go.run(instance)
      .then(() => {
        throw new Error("Transfer engine exited.");
      })
      .catch((error: unknown) => {
        reject(error);
        self.postMessage({ event: "fatal" });
      });
  });
  stage("Ready");
}
self.onmessage = ({ data: { id, method, args } }) => {
  void (async () => {
    if (method === "initialize") {
      initialization ??= initialize(args[0] as string, args[1] as string);
      return initialization;
    }
    if (!methods.has(method) || !initialization)
      throw new Error("Invalid transfer operation.");
    await initialization;
    if (method === "tailshareListen") {
      const [options, listener] = args as [Record<string, unknown>, number];
      return scope.tailshareListen({
        ...options,
        onConnection: (connection: number) =>
          self.postMessage({ event: "connection", listener, connection }),
      });
    }
    return scope[method](...args);
  })().then(
    (value) => {
      if (id)
        self.postMessage(
          { id, value },
          value instanceof Uint8Array ? [value.buffer] : [],
        );
    },
    (error: unknown) => {
      if (id)
        self.postMessage({
          id,
          error:
            error instanceof Error
              ? error.message
              : "Transfer operation failed.",
        });
    },
  );
};
