import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js';
import type { AppLifecycle } from '@todo/application';
import {
  SharedSyncEngine,
  type SharedEngineState,
  type SharedRequest,
  type SharedViewState,
} from './shared-sync';
import type { SharedStore } from './shared-store';

export interface SharedSyncController {
  engine: SharedSyncEngine;
  state: Accessor<SharedEngineState>;
  view: Accessor<SharedViewState>;
  connected: Accessor<boolean>;
  /** Re-read the local store into `view`. */
  refresh(): Promise<void>;
}

export interface SharedSyncControllerOptions {
  store: SharedStore;
  request: SharedRequest;
  lifecycle: Pick<AppLifecycle, 'onResume' | 'onOnline'>;
  /** True while the cloud session is connected; the engine only talks to the API then. */
  connected: Accessor<boolean>;
  /** Native keeps shared lists online-only and drops the copy whenever the session ends. */
  clearOnDisconnect?: boolean;
  pollMs?: number;
}

/** Binds a `SharedSyncEngine` to the cloud session and exposes it as Solid signals. */
export function createSharedSyncController(
  options: SharedSyncControllerOptions,
): SharedSyncController {
  const engine = new SharedSyncEngine({
    request: options.request,
    store: options.store,
    pollMs: options.pollMs,
  });
  const [state, setState] = createSignal(engine.getState());
  const [view, setView] = createSignal<SharedViewState>({ lists: [], invitations: [] });
  let disposed = false;
  let reading: Promise<void> | null = null;
  let dirty = false;

  // Engine events arrive in bursts during a sync; coalesce them into one read.
  const refresh = (): Promise<void> => {
    dirty = true;
    if (reading) return reading;
    const run = (async () => {
      try {
        while (dirty && !disposed) {
          dirty = false;
          const next = await engine.read();
          if (!disposed) setView(next);
        }
      } finally {
        reading = null;
      }
    })();
    reading = run;
    return run;
  };

  const unsubscribe = engine.subscribe(() => {
    if (disposed) return;
    setState(engine.getState());
    void refresh().catch(() => {});
  });

  createEffect(
    on(options.connected, (connected) => {
      if (connected) {
        engine.start(options.lifecycle);
        return;
      }
      engine.stop();
      const cleared = options.clearOnDisconnect ? options.store.clear() : Promise.resolve();
      void cleared.then(refresh).catch(() => {});
    }),
  );

  onCleanup(() => {
    disposed = true;
    unsubscribe();
    engine.stop();
  });

  void refresh().catch(() => {});

  return { engine, state, view, connected: options.connected, refresh };
}
