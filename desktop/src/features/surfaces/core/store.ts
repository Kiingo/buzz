// Generated from the Kiingo surface renderer packages at dbc93b6d803e88e782fd6dbc8d7871827f2a9f7c; do not edit here.
import type { SurfaceApi } from "./api";
import { SurfaceController } from "./controller";
import type { ControllerOptions } from "./controller-state";
import type { Surface } from "./model";
import { RUN_ACTIONS_OFF } from "./run-gate";

/** One controller per surface id, shared by the inline card and the expanded view. */
export class SurfaceStore {
  static readonly capacity = 64;
  private readonly controllers = new Map<string, SurfaceController>();
  private order: string[] = [];

  constructor(private readonly options: ControllerOptions) {}

  get api(): SurfaceApi {
    return this.options.api;
  }

  get client(): string {
    return this.options.client;
  }

  get runAvailable(): boolean {
    return (this.options.runGate ?? RUN_ACTIONS_OFF).available;
  }

  controller(id: string): SurfaceController | undefined {
    return this.controllers.get(id);
  }

  /** The controller for `surface`, made on first use; a newer revision updates it. */
  controllerFor(surface: Surface): SurfaceController {
    this.touch(surface.id);
    const existing = this.controllers.get(surface.id);
    if (existing) {
      existing.receive(surface);
      return existing;
    }
    const controller = new SurfaceController(surface, this.options);
    this.controllers.set(surface.id, controller);
    this.trim();
    return controller;
  }

  /** Reads a surface the chat only pointed at. */
  async load(
    surfaceId: string,
    revision?: number,
  ): Promise<SurfaceController | undefined> {
    const existing = this.controllers.get(surfaceId);
    if (existing) {
      if (revision !== undefined && revision > existing.surface.revision) {
        await existing.refresh();
      }
      this.touch(surfaceId);
      return existing;
    }
    try {
      const result = await this.options.api.surface(surfaceId);
      return result.kind === "done"
        ? this.controllerFor(result.value)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Saves every pending edit (page hidden or closing). */
  async saveAll(): Promise<void> {
    await Promise.all(
      [...this.controllers.values()]
        .filter((c) => c.getSnapshot().pendingCount > 0)
        .map((c) => c.saveNow()),
    );
  }

  private touch(id: string): void {
    this.order = this.order.filter((item) => item !== id);
    this.order.push(id);
  }

  private trim(): void {
    while (this.controllers.size > SurfaceStore.capacity) {
      const victim = this.order.find(
        (id) => this.controllers.get(id)?.getSnapshot().pendingCount === 0,
      );
      if (!victim) {
        return;
      }
      this.controllers.get(victim)?.dispose();
      this.controllers.delete(victim);
      this.order = this.order.filter((id) => id !== victim);
    }
  }
}
