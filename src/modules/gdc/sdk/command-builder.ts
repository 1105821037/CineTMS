import { GDC_PROTOCOL_VERSION } from "../protocol/constants";
import type { GdcXmlCommandOptions } from "./types";

export class GdcCommandBuilder {
  buildXml(options: GdcXmlCommandOptions): string {
    const version = options.version ?? GDC_PROTOCOL_VERSION;
    const content = options.innerXml ? `\n${options.innerXml}\n` : "";
    const closeTag = options.innerXml ? "</command>" : "/>";
    const body = options.innerXml
      ? `<command version="${version}" cmd="${options.commandName}">${content}${closeTag}`
      : `<command version="${version}" cmd="${options.commandName}"${closeTag}`;

    return `<?xml version="1.0" encoding="UTF-8" ?>\n${body}`;
  }
}
