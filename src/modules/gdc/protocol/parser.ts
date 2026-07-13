import {
  GDC_BER_LENGTH_BYTES,
  GDC_HEADER_LENGTH,
} from "./constants";
import { GdcProtocolError } from "./errors";
import type { GdcResponseFrame } from "./types";
import { GdcProtocolCodec } from "./codec";

export class GdcResponseParser {
  private readonly codec = new GdcProtocolCodec();
  private buffer = Buffer.alloc(0);
  private expectedXmlLength: number | null = null;

  push(chunk: Buffer): GdcResponseFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: GdcResponseFrame[] = [];

    while (true) {
      if (this.expectedXmlLength === null) {
        if (this.buffer.length < GDC_HEADER_LENGTH + GDC_BER_LENGTH_BYTES) {
          return frames;
        }

        const header = this.buffer.subarray(0, GDC_HEADER_LENGTH);
        if (!this.codec.isResponseHeader(header)) {
          throw new GdcProtocolError(
            `Unexpected response header: ${header.toString("hex")}`,
          );
        }

        const lengthBuffer = this.buffer.subarray(
          GDC_HEADER_LENGTH,
          GDC_HEADER_LENGTH + GDC_BER_LENGTH_BYTES,
        );
        this.expectedXmlLength = this.codec.decodeLength(lengthBuffer);
        this.buffer = this.buffer.subarray(GDC_HEADER_LENGTH + GDC_BER_LENGTH_BYTES);
      }

      if (this.buffer.length < this.expectedXmlLength) {
        return frames;
      }

      const xmlPayload = this.buffer.subarray(0, this.expectedXmlLength);
      frames.push({
        xml: xmlPayload.toString("utf8"),
        raw: xmlPayload,
      });

      this.buffer = this.buffer.subarray(this.expectedXmlLength);
      this.expectedXmlLength = null;
    }
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.expectedXmlLength = null;
  }
}
