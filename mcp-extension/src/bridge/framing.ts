export const MAX_BRIDGE_FRAME_BYTES = 1_048_576;

function frameTooLarge(maxFrameBytes: number): Error {
  return new Error(`Bridge frame exceeds ${maxFrameBytes} bytes.`);
}

export function encodeFrame(
  value: unknown,
  maxFrameBytes = MAX_BRIDGE_FRAME_BYTES,
): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error("Bridge frame is not JSON serializable.");
  }
  const payload = Buffer.from(json, "utf8");
  if (payload.byteLength > maxFrameBytes) {
    throw frameTooLarge(maxFrameBytes);
  }

  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  readonly #textDecoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = MAX_BRIDGE_FRAME_BYTES) {}

  push(bytes: Uint8Array): unknown[] {
    if (bytes.byteLength !== 0) {
      this.#buffer = Buffer.concat([
        this.#buffer,
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      ]);
    }

    const frames: unknown[] = [];
    while (this.#buffer.byteLength >= 4) {
      const payloadLength = this.#buffer.readUInt32LE(0);
      if (payloadLength > this.maxFrameBytes) {
        throw frameTooLarge(this.maxFrameBytes);
      }
      if (this.#buffer.byteLength < 4 + payloadLength) {
        break;
      }

      const payload = this.#buffer.subarray(4, 4 + payloadLength);
      this.#buffer = this.#buffer.subarray(4 + payloadLength);
      frames.push(JSON.parse(this.#textDecoder.decode(payload)) as unknown);
    }
    return frames;
  }
}
