import {
  GDC_BER_PREFIX,
  GDC_COMMAND_HEADER,
  GDC_RESPONSE_HEADER,
} from "./constants";
import { GdcProtocolError } from "./errors";
import type { GdcRequestFrame } from "./types";

export class GdcProtocolCodec {
  encodeXmlCommand(xml: string): GdcRequestFrame {
    const xmlBuffer = Buffer.from(xml, "utf8");
    const payload = Buffer.concat([
      GDC_COMMAND_HEADER,
      this.encodeLength(xmlBuffer.length),
      xmlBuffer,
    ]);

    return { xml, payload };
  }

  encodeLength(length: number): Buffer {
    if (length < 0 || length > 0xffffff) {
      throw new GdcProtocolError(`Unsupported GDC payload length: ${length}`);
    }

    return Buffer.from([
      GDC_BER_PREFIX,
      (length >> 16) & 0xff,
      (length >> 8) & 0xff,
      length & 0xff,
    ]);
  }

  decodeLength(buffer: Buffer): number {
    if (buffer.length < 4) {
      throw new GdcProtocolError("Insufficient bytes for BER length");
    }

    if (buffer[0] !== GDC_BER_PREFIX) {
      throw new GdcProtocolError(`Unexpected BER prefix: 0x${buffer[0].toString(16)}`);
    }

    return (buffer[1] << 16) | (buffer[2] << 8) | buffer[3];
  }

  isResponseHeader(buffer: Buffer): boolean {
    return buffer.equals(GDC_RESPONSE_HEADER);
  }
}
