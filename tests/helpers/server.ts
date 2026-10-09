import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  hit: number,
) => void | Promise<void>;

export interface TestServer {
  url: string;
  hits: number;
  close(): Promise<void>;
  setHandler(handler: Handler): void;
}

export async function startServer(initial: Handler): Promise<TestServer> {
  let handler = initial;
  const sockets = new Set<import("node:net").Socket>();
  const state = { hits: 0 };
  const server: Server = createServer((req, res) => {
    state.hits++;
    void Promise.resolve(handler(req, res, state.hits)).catch(() => res.destroy());
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get hits() {
      return state.hits;
    },
    setHandler: (h) => {
      handler = h;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
