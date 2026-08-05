import type { Socket } from "node:net";

const MAX_MESSAGE_BYTES = 1024 * 1024;

export type MessageListener = (message: unknown) => void;
export type CloseListener = () => void;

export class JsonLineChannel {
  readonly socket: Socket;

  #buffer = "";
  #closed = false;
  #messageListeners = new Set<MessageListener>();
  #closeListeners = new Set<CloseListener>();

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.once("close", () => this.#close());
    socket.once("error", () => {});
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(message: unknown): boolean {
    if (this.#closed || this.socket.destroyed) return false;
    return this.socket.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(listener: MessageListener): () => boolean {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: CloseListener): () => boolean | void {
    if (this.#closed) {
      queueMicrotask(listener);
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  destroy(): void {
    this.socket.destroy();
  }

  end(): void {
    this.socket.end();
  }

  #receive(chunk: string | Buffer): void {
    this.#buffer += chunk.toString();
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_MESSAGE_BYTES) {
      this.socket.destroy(new Error("IPC message exceeds the 1 MiB limit"));
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.socket.destroy(new Error("daemon sent invalid JSON"));
        return;
      }
      for (const listener of this.#messageListeners) listener(message);
    }
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
    this.#messageListeners.clear();
    this.#closeListeners.clear();
  }
}
