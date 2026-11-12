/** Comlink endpoint for Node MessagePort/Worker, without depending on private adapters. */
export interface NodePort {
  postMessage(value: unknown, transfer?: readonly Transferable[]): void;
  on(type: string, listener: (...args: any[]) => void): unknown;
  off(type: string, listener: (...args: any[]) => void): unknown;
  start?: () => void;
}
export function nodeEndpoint(port: NodePort) {
  const listeners = new Map<EventListenerOrEventListenerObject, (...args: any[]) => void>();
  return {
    postMessage: (message: unknown, transfer?: Transferable[]) =>
      port.postMessage(message, transfer),
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const wrapped = (data: unknown) => {
        const event = { data } as MessageEvent;
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      };
      listeners.set(listener, wrapped);
      port.on(type, wrapped);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const wrapped = listeners.get(listener);
      if (wrapped) {
        port.off(type, wrapped);
        listeners.delete(listener);
      }
    },
    start: () => port.start?.(),
  };
}
