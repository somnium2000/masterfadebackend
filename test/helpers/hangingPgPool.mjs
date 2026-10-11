import { EventEmitter } from "node:events";
import pg from "pg";

// AM: Simular transporte sin respuestas; Client/Pool/query_timeout son los reales, sin red.
export function createHangingPgPool() {
  const connections = [];
  class SilentConnection extends EventEmitter {
    constructor() {
      super();
      this.parsedStatements = {};
      this.executions = 0;
      this.destroyed = false;
      this.stream = {
        cork() {},
        uncork() {},
        destroy: () => {
          if (this.destroyed) return;
          this.destroyed = true;
          process.nextTick(() => this.emit("end"));
        },
      };
      connections.push(this);
    }
    connect() {
      this._connecting = true;
      process.nextTick(() => this.emit("connect"));
    }
    startup() { process.nextTick(() => this.emit("readyForQuery")); }
    parse() {}
    bind() {}
    describe() {}
    execute() { this.executions += 1; }
    sync() {}
    ref() {}
    unref() {}
    end() { this.stream.destroy(); }
  }
  class SilentClient extends pg.Client {
    constructor(options) {
      super({
        ...options, connection: new SilentConnection(),
        user: "test", database: "test", password: "test", host: "localhost", ssl: false,
      });
    }
  }
  return {
    pool: new pg.Pool({ Client: SilentClient, max: 1, connectionTimeoutMillis: 1000 }),
    connections,
  };
}
