const FOCUS_STATE = Symbol.for("pi-cfg.cua-focus-state");

interface FocusState { foregroundAllowed: boolean; }

function state(): FocusState {
  const root = globalThis as typeof globalThis & { [FOCUS_STATE]?: FocusState };
  root[FOCUS_STATE] ??= { foregroundAllowed: false };
  return root[FOCUS_STATE];
}

export function isForegroundAllowed(): boolean { return state().foregroundAllowed; }
export function setForegroundAllowed(allowed: boolean): void { state().foregroundAllowed = allowed; }
