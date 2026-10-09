// The toast: one short message at the bottom of the screen. Any code can show one; <Toast> displays it.

export interface ToastMessage {
  id: number;          // changes with every toast, so the same message twice still replays
  message: string;
  entryId?: string;    // offers "−5 min", "−15 min" and "Undo" for this entry
}

const TOAST_MS = 9000;

let current: ToastMessage | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(value: ToastMessage | null): void {
  current = value;
  listeners.forEach(fn => fn());
}

export function toast(message: string, entryId?: string): void {
  clearTimeout(timer);
  set({ id: nextId++, message, entryId });
  timer = setTimeout(() => set(null), TOAST_MS);
}

export const toastStore = {
  get: () => current,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** Wraps an async function so a failure shows a toast. It then resolves to undefined. */
export function safely<Args extends unknown[], Result>(action: (...args: Args) => Promise<Result>) {
  return async (...args: Args): Promise<Result | undefined> => {
    try {
      return await action(...args);
    } catch (error) {
      console.error(error);
      toast('Something went wrong: ' + ((error as Error).message || error));
      return undefined;
    }
  };
}
