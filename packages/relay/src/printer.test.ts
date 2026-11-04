import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probe, sendJob, PrinterError } from "./printer.js";

/** A fake ESC/POS printer: records bytes, answers DLE EOT status queries. */
let server: net.Server;
let port: number;
const received: Buffer[] = [];
let statusByte = 0x12; // ready
let paperByte = 0x12;

beforeAll(async () => {
  server = net.createServer((socket) => {
    socket.on("data", (buf) => {
      if (buf.length === 3 && buf[0] === 0x10 && buf[1] === 0x04) {
        socket.write(Buffer.from([buf[2] === 0x01 ? statusByte : paperByte]));
        return;
      }
      received.push(buf);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(() => server.close());

describe("relay printer transport", () => {
  it("checks status, then sends the bytes", async () => {
    received.length = 0;
    await sendJob({ ip: "127.0.0.1", port, supports_status: true }, Uint8Array.from([0x1b, 0x40, 0x48, 0x69, 0x1d, 0x56, 0x42, 0x00]));
    for (let i = 0; i < 50 && Buffer.concat(received).length < 8; i++) await new Promise((r) => setTimeout(r, 10)); // the write callback fires before the fake printer reads
    expect(Buffer.concat(received)).toEqual(Buffer.from([0x1b, 0x40, 0x48, 0x69, 0x1d, 0x56, 0x42, 0x00]));
  });
  it("reports cover open and paper out from the status query", async () => {
    statusByte = 0x12 | 0x20;
    await expect(sendJob({ ip: "127.0.0.1", port, supports_status: true }, Uint8Array.from([1]))).rejects.toThrow(/Cover open/);
    statusByte = 0x12;
    paperByte = 0x12 | 0x60;
    await expect(sendJob({ ip: "127.0.0.1", port, supports_status: true }, Uint8Array.from([1]))).rejects.toThrow(/Paper out/);
    paperByte = 0x12;
  });
  it("times out cleanly when nothing listens", async () => {
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const p = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    await expect(sendJob({ ip: "127.0.0.1", port: p, supports_status: false }, Uint8Array.from([1]), { connectTimeoutMs: 500 })).rejects.toBeInstanceOf(PrinterError);
    expect((await probe({ ip: "127.0.0.1", port: p, supports_status: false })).ok).toBe(false);
    expect((await probe({ ip: "127.0.0.1", port, supports_status: true })).ok).toBe(true);
  });
});
