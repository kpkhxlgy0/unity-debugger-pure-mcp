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
  #readOffset = 0;
  #writeOffset = 0;

  constructor(private readonly maxFrameBytes = MAX_BRIDGE_FRAME_BYTES) {}

  push(bytes: Uint8Array): unknown[] {
    this.#append(bytes);

    const frames: unknown[] = [];
    while (this.#writeOffset - this.#readOffset >= 4) {
      const payloadLength = this.#buffer.readUInt32LE(this.#readOffset);
      if (payloadLength > this.maxFrameBytes) {
        throw frameTooLarge(this.maxFrameBytes);
      }
      if (this.#writeOffset - this.#readOffset < 4 + payloadLength) {
        break;
      }

      const payloadStart = this.#readOffset + 4;
      const payload = this.#buffer.subarray(payloadStart, payloadStart + payloadLength);
      this.#readOffset = payloadStart + payloadLength;
      frames.push(JSON.parse(this.#textDecoder.decode(payload)) as unknown);
    }
    if (this.#readOffset === this.#writeOffset) {
      this.#readOffset = 0;
      this.#writeOffset = 0;
    }
    return frames;
  }

  #append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) {
      return;
    }

    const unreadBytes = this.#writeOffset - this.#readOffset;
    const requiredCapacity = unreadBytes + bytes.byteLength;
    if (this.#buffer.byteLength < requiredCapacity) {
      const doubledCapacity = Math.max(8, this.#buffer.byteLength * 2);
      const replacement = Buffer.allocUnsafe(Math.max(requiredCapacity, doubledCapacity));
      if (unreadBytes !== 0) {
        this.#buffer.copy(replacement, 0, this.#readOffset, this.#writeOffset);
      }
      this.#buffer = replacement;
      this.#readOffset = 0;
      this.#writeOffset = unreadBytes;
    } else if (this.#buffer.byteLength - this.#writeOffset < bytes.byteLength) {
      this.#buffer.copy(this.#buffer, 0, this.#readOffset, this.#writeOffset);
      this.#readOffset = 0;
      this.#writeOffset = unreadBytes;
    }

    const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    source.copy(this.#buffer, this.#writeOffset);
    this.#writeOffset += bytes.byteLength;
  }
}
