import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { engineStatus, loadTransport, subscribeEngine } from "./lib/transport";
import { ScreenAwake, type WakeState } from "./lib/wake-lock";

const messages: Record<WakeState, string> = {
  off: "Optional while sharing or transferring. Keep this page visible.",
  waiting: "Will request when sharing or transferring starts.",
  requesting: "Requesting screen wake lock…",
  held: "Screen wake lock active. Keep this page visible.",
  released: "Wake lock released. Keep the screen on and this page visible.",
  unavailable: "Browser could not keep the screen awake. Keep it on manually.",
  unsupported:
    "This browser cannot keep the screen awake. Keep it on manually.",
};
export function TransferTools({ active }: { active: boolean }) {
  const engine = useSyncExternalStore(subscribeEngine, engineStatus);
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<WakeState>("off");
  const controller = useRef<ScreenAwake | undefined>(undefined);
  useEffect(() => {
    const instance = new ScreenAwake(
      navigator.wakeLock
        ? () => navigator.wakeLock.request("screen")
        : undefined,
      setState,
    );
    controller.current = instance;
    return () => {
      instance.dispose();
      controller.current = undefined;
    };
  }, []);
  useEffect(() => {
    const update = () =>
      controller.current?.update(
        enabled,
        active,
        document.visibilityState === "visible",
      );
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [enabled, active]);
  return (
    <div className="transfer-tools">
      <label className="wake-option">
        <input
          type="checkbox"
          checked={enabled}
          disabled={state === "unsupported"}
          onChange={(event) => setEnabled(event.target.checked)}
          aria-describedby="wake-help"
        />{" "}
        Keep screen awake
      </label>
      <p id="wake-help" role="status">
        {messages[state]}
      </p>
      <p className="engine-status" role="status">
        {engine.phase === "loading"
          ? `${engine.message}…`
          : engine.phase === "ready"
            ? "Transfer engine ready."
            : engine.phase === "error"
              ? "Transfer engine needs attention."
              : "Transfer engine loads on selection."}
      </p>
      {engine.phase === "error" && (
        <div className="engine-error">
          <p role="status">{engine.message}</p>
          <button
            className="text-button"
            onClick={() => void loadTransport().catch(() => {})}
          >
            Retry transfer engine
          </button>
        </div>
      )}
    </div>
  );
}
