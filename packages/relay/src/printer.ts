import net from "node:net";

/**
 * Raw ESC/POS over TCP 9100. The relay holds no business logic: it sends the
 * bytes the register rendered and reports the result.
 */
export type PrinterTarget = { ip: string; port: number; supports_status: boolean };

const DLE_EOT_PRINTER_STATUS = Uint8Array.from([0x10, 0x04, 0x01]);
const DLE_EOT_PAPER_STATUS = Uint8Array.from([0x10, 0x04, 0x04]);

export class PrinterError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

function connect(target: PrinterTarget, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.ip, port: target.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new PrinterError("No reply from the printer (connection timed out)", false));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(new PrinterError(`Cannot reach the printer: ${(e as Error).message}`, false));
    });
  });
}

/** Query DLE EOT status; returns a human-readable problem or null when ready. Printers that ignore the query time out → treated as ready. */
export async function checkStatus(socket: net.Socket, timeoutMs = 1500): Promise<string | null> {
  const read = (cmd: Uint8Array) =>
    new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        socket.off("data", onData);
        resolve(null);
      }, timeoutMs);
      const onData = (buf: Buffer) => {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(buf[0] ?? null);
      };
      socket.on("data", onData);
      socket.write(cmd);
    });
  const printer = await read(DLE_EOT_PRINTER_STATUS);
  if (printer != null) {
    if (printer & 0x08) return "Printer offline";
    if (printer & 0x20) return "Cover open";
    if (printer & 0x40) return "Paper feed error";
  }
  const paper = await read(DLE_EOT_PAPER_STATUS);
  if (paper != null) {
    if (paper & 0x60) return "Paper out";
    if (paper & 0x0c) return "Paper low";
  }
  return null;
}

/** Send one job. Resolves when the bytes have been flushed to the socket. */
export async function sendJob(target: PrinterTarget, bytes: Uint8Array, opts: { connectTimeoutMs?: number; writeTimeoutMs?: number; checkStatus?: boolean } = {}): Promise<void> {
  const socket = await connect(target, opts.connectTimeoutMs ?? 4000);
  try {
    if (opts.checkStatus ?? target.supports_status) {
      const problem = await checkStatus(socket);
      if (problem) throw new PrinterError(problem, false);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PrinterError("Printer accepted the connection but did not take the data", false)), opts.writeTimeoutMs ?? 8000);
      socket.write(bytes, (err) => {
        clearTimeout(timer);
        if (err) reject(new PrinterError(`Write failed: ${err.message}`, false));
        else resolve();
      });
    });
    await new Promise<void>((resolve) => socket.end(resolve));
  } finally {
    socket.destroy();
  }
}

/** Reachability check for heartbeats. */
export async function probe(target: PrinterTarget): Promise<{ ok: boolean; error?: string }> {
  try {
    const socket = await connect(target, 2000);
    socket.destroy();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
