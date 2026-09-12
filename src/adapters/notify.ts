/**
 * Notify adapter — platform toast injection (sonner on desktop,
 * sonner-native on mobile). Core hooks never import a toast library.
 */

interface NotifyHandlers {
  success: (message: string) => void;
  error: (message: string) => void;
}

let handlers: NotifyHandlers = {
  success: (m) => {
    try {
      console.debug("[notify] success", m);
    } catch {}
  },
  error: (m) => {
    try {
      console.debug("[notify] error", m);
    } catch {}
  },
};

export function setNotifyHandlers(next: Partial<NotifyHandlers>): void {
  handlers = { ...handlers, ...next };
}

export function notifySuccess(message: string): void {
  try {
    handlers.success(message);
  } catch {}
}

export function notifyError(message: string): void {
  try {
    handlers.error(message);
  } catch {}
}
