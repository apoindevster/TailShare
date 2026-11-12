export type WakeState =
  | "off"
  | "waiting"
  | "requesting"
  | "held"
  | "released"
  | "unavailable"
  | "unsupported";
export interface WakeHandle {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}
export class ScreenAwake {
  private handle?: WakeHandle;
  private pending?: Promise<void>;
  private enabled = false;
  private active = false;
  private visible = true;
  private generation = 0;
  constructor(
    private request: (() => Promise<WakeHandle>) | undefined,
    private state: (state: WakeState) => void,
  ) {}
  update(enabled: boolean, active: boolean, visible: boolean) {
    const changed =
      this.enabled !== enabled ||
      this.active !== active ||
      this.visible !== visible;
    this.enabled = enabled;
    this.active = active;
    this.visible = visible;
    if (!this.request) {
      this.state("unsupported");
      return;
    }
    if (!enabled || !active || !visible) {
      this.generation++;
      const old = this.handle;
      this.handle = undefined;
      if (old) void old.release().catch(() => {});
      this.state(!enabled ? "off" : !active ? "waiting" : "released");
      return;
    }
    if (this.handle || this.pending || !changed) return;
    this.acquire();
  }
  private acquire() {
    const generation = this.generation;
    this.state("requesting");
    this.pending = this.request!()
      .then(async (handle) => {
        if (
          generation !== this.generation ||
          !this.enabled ||
          !this.active ||
          !this.visible
        ) {
          await handle.release();
          return;
        }
        this.handle = handle;
        handle.addEventListener("release", () => {
          if (this.handle !== handle) return;
          this.handle = undefined;
          // A system release is not permission to loop requests (e.g. low battery).
          this.state("released");
        });
        this.state("held");
      })
      .catch(() => {
        if (generation === this.generation) this.state("unavailable");
      })
      .finally(() => {
        this.pending = undefined;
        // Visibility can change while an earlier request is awaiting permission.
        if (
          generation !== this.generation &&
          this.enabled &&
          this.active &&
          this.visible
        )
          this.acquire();
      });
  }
  dispose() {
    this.update(false, false, false);
  }
}
