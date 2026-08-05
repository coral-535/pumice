const MAX_MESSAGE_BYTES = 1024 * 1024;

export class JsonLineChannel {
  #buffer = "";
  #closed = false;
  #messageListeners = new Set();
  #closeListeners = new Set();

  constructor(socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.once("close", () => this.#close());
    socket.once("error", () => {});
  }

  get closed() {
    return this.#closed;
  }

  send(message) {
    if (this.#closed || this.socket.destroyed) return false;
    return this.socket.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(listener) {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener) {
    if (this.#closed) {
      queueMicrotask(listener);
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  destroy() {
    this.socket.destroy();
  }

  end() {
    this.socket.end();
  }

  #receive(chunk) {
    this.#buffer += chunk;
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
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.socket.destroy(new Error("daemon sent invalid JSON"));
        return;
      }
      for (const listener of this.#messageListeners) listener(message);
    }
  }

  #close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
    this.#messageListeners.clear();
    this.#closeListeners.clear();
  }
}
