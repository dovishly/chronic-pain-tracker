// The toast: one short message at the bottom of the screen, with buttons for what can be done about it. Any code
// can show one; <Toast> displays it.
import { createStore } from './util';

/** A button on a toast. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastMessage {
  id: number;          // changes with every toast, so the same message twice still replays
  message: string;
  actions: ToastAction[];
}

const TOAST_MS = 9000;

export const toastStore = createStore<ToastMessage | null>(null);
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, actions: ToastAction[] = []): void {
  clearTimeout(timer);
  toastStore.set({ id: nextId++, message, actions });
  timer = setTimeout(() => toastStore.set(null), TOAST_MS);
}

/**
 * Wraps an async function so a failure shows a toast. It then resolves to undefined. A function only ever started
 * by a tap is wrapped where it's defined (the actions, the exports); one that other code calls too, like sync's,
 * is wrapped by the view that taps it.
 */
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
