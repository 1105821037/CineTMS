import { GdcResponseError } from "../protocol/errors";
import type { GdcXmlResponse } from "../protocol/types";
import type {
  GdcCplDetail,
  GdcCplSummary,
  GdcEventLogEntry,
  GdcEventLogResult,
  GdcIngestErrorItem,
  GdcIngestListItem,
  GdcIngestStatus,
  GdcKdmDetail,
  GdcKdmSummary,
  GdcPlaybackPosition,
  GdcPlaybackStatus,
  GdcProjectorStatus,
  GdcScheduleSummary,
  GdcSchedulerStatus,
  GdcServerDateTime,
  GdcServerInfo,
  GdcServerIpList,
  GdcShowDetail,
  GdcShowPlaylistCommand,
  GdcShowPlaylistSegment,
  GdcShowSummary,
  GdcStorageInfo,
  GdcTimezoneInfo,
} from "./types";

function readTag(xml: string, tagName: string): string | undefined {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i").exec(xml);
  return match?.[1]?.trim();
}

function readTagWithOptionalAttributes(xml: string, tagName: string): string | undefined {
  const match = new RegExp(`<${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)</${tagName}>`, "i").exec(xml);
  return match?.[1]?.trim();
}

function readSelfClosingAttributes(xml: string, tagName: string): Record<string, string> {
  const match = new RegExp(`<${tagName}\\s+([^>]+)/>`, "i").exec(xml);
  if (!match) {
    return {};
  }

  const attrs: Record<string, string> = {};
  const attrRegex = /(\w+)="([^"]*)"/g;
  let attrMatch: RegExpExecArray | null = null;
  while ((attrMatch = attrRegex.exec(match[1])) !== null) {
    attrs[attrMatch[1]] = attrMatch[2];
  }
  return attrs;
}

function decodeEntities(xml: string): string {
  return xml
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function readTagAttributes(xml: string, tagName: string): Record<string, string> {
  const match = new RegExp(`<${tagName}\\s+([^>/]+?)(?:\\/?)>`, "i").exec(xml);
  if (!match) {
    return {};
  }

  const attrs: Record<string, string> = {};
  const attrRegex = /(\w+)="([^"]*)"/g;
  let attrMatch: RegExpExecArray | null = null;
  while ((attrMatch = attrRegex.exec(match[1])) !== null) {
    attrs[attrMatch[1]] = attrMatch[2];
  }
  return attrs;
}

function parsePlaybackPosition(attrs: Record<string, string>): GdcPlaybackPosition | undefined {
  if (Object.keys(attrs).length === 0) {
    return undefined;
  }

  return {
    totalDuration: attrs.total_duration ? Number(attrs.total_duration) : undefined,
    playedDuration: attrs.played_duration ? Number(attrs.played_duration) : undefined,
    cplIndex: attrs.cpl_index ? Number(attrs.cpl_index) : undefined,
    storage: attrs.storage,
  };
}

function parseIngestItems(xml: string, tagName: "error" | "warning"): GdcIngestErrorItem[] {
  const pattern = new RegExp(`<${tagName}\\s+([^>]*)\\/>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => {
    const attrs = match[1];
    const read = (name: string) => new RegExp(`${name}="([^"]*)"`, "i").exec(attrs)?.[1];
    return {
      assetUri: read("asset_uri"),
      code: read("code"),
      assetUuid: read("asset_uuid"),
      description: read("description"),
    };
  });
}

function redactFtpCredentials(value: string | undefined): string | undefined {
  return value?.replace(/ftp:\/\/([^:\s/@<>"]+):([^@\s<>"]+)@/gi, "ftp://$1:<redacted>@");
}

export class GdcSdkResponseParser {
  parseResponse(xml: string): GdcXmlResponse {
    const statusMatch = /<response[^>]*status="([^"]+)"/i.exec(xml);
    const versionMatch = /<response[^>]*version="([^"]+)"/i.exec(xml);
    const statusValue = statusMatch?.[1]?.toUpperCase();
    const status: GdcXmlResponse["status"] =
      statusValue === "OK" || statusValue === "ERROR" ? statusValue : "UNKNOWN";

    if (status === "ERROR") {
      const errorMessage = readTag(xml, "error") ?? readTag(xml, "e") ?? "GDC returned an error";
      throw new GdcResponseError(errorMessage, xml);
    }

    return {
      status,
      version: versionMatch?.[1],
      rawXml: xml,
    };
  }

  parseSupportedCommands(xml: string): string[] {
    this.parseResponse(xml);
    return [...xml.matchAll(/<command>([^<]+)<\/command>/gi)].map((match) => match[1].trim());
  }

  parseAutomationLabels(xml: string): string[] {
    this.parseResponse(xml);
    return [...xml.matchAll(/<automation_label>([\s\S]*?)<\/automation_label>/gi)].map((match) =>
      decodeEntities(match[1].trim()),
    );
  }

  parseEventLogs(xml: string, date: string): GdcEventLogResult {
    this.parseResponse(xml);
    const logAttrs = readTagAttributes(xml, "log");
    const logDate = logAttrs.date || date;

    return {
      date: logDate,
      entries: parseEventLogEntries(xml, logDate),
      rawXml: xml,
    };
  }

  parseServerInfo(xml: string): GdcServerInfo {
    this.parseResponse(xml);
    const versionAttrs = readSelfClosingAttributes(xml, "version");

    return {
      model: readTag(xml, "model"),
      serial: readTag(xml, "serial"),
      serverTime: readTag(xml, "server_time"),
      version: {
        os: versionAttrs.os,
        software: versionAttrs.software,
        firmware: versionAttrs.firmware,
      },
    };
  }

  parseCplList(xml: string): GdcCplSummary[] {
    this.parseResponse(xml);
    return [...xml.matchAll(/<cpl_uuid([^>]*)>([^<]+)<\/cpl_uuid>/gi)].map((match) => {
      const attrs = match[1];
      const ingestDateTime = /ingest_datetime="([^"]+)"/i.exec(attrs)?.[1];
      return {
        cplUuid: match[2].trim(),
        ingestDateTime,
      };
    });
  }

  parseCplDetail(xml: string): GdcCplDetail {
    this.parseResponse(xml);
    const encodedCplXml = readTag(xml, "response_text");
    const rawCplXml = decodeEntities(encodedCplXml ?? "");
    const duration = parseCplDuration(rawCplXml);
    const media = parseCplMediaMetadata(rawCplXml);

    return {
      cplUuid: readTag(rawCplXml, "Id"),
      annotationText: readTag(rawCplXml, "AnnotationText"),
      issueDate: readTag(rawCplXml, "IssueDate"),
      issuer: readTag(rawCplXml, "Issuer"),
      creator: readTag(rawCplXml, "Creator"),
      contentTitleText: readTag(rawCplXml, "ContentTitleText"),
      contentKind: readTag(rawCplXml, "ContentKind"),
      durationSeconds: duration.durationSeconds,
      durationFrames: duration.durationFrames,
      editRate: duration.editRate,
      isStereoscopic: media.isStereoscopic,
      resolutionLabel: media.resolutionLabel,
      pictureWidth: media.pictureWidth,
      pictureHeight: media.pictureHeight,
      screenAspectRatio: media.screenAspectRatio,
      aspectRatioLabel: media.aspectRatioLabel,
      formatTags: media.formatTags,
      rawCplXml,
    };
  }

  parseKdmList(xml: string): GdcKdmSummary[] {
    this.parseResponse(xml);
    return [...xml.matchAll(/<asset_uuid>([^<]+)<\/asset_uuid>/gi)].map((match) => ({
      assetUuid: match[1].trim(),
    }));
  }

  parseKdmDetail(xml: string): GdcKdmDetail {
    this.parseResponse(xml);
    const encodedKdmXml = readTag(xml, "response_text");
    const rawKdmXml = decodeEntities(encodedKdmXml ?? "");

    return {
      assetUuid: readTag(rawKdmXml, "MessageId"),
      messageType: readTag(rawKdmXml, "MessageType"),
      annotationText: readTag(rawKdmXml, "AnnotationText"),
      issueDate: readTag(rawKdmXml, "IssueDate"),
      compositionPlaylistId: readTag(rawKdmXml, "CompositionPlaylistId"),
      contentTitleText: readTag(rawKdmXml, "ContentTitleText"),
      validBefore: readTag(rawKdmXml, "ContentKeysNotValidBefore"),
      validAfter: readTag(rawKdmXml, "ContentKeysNotValidAfter"),
      rawKdmXml,
    };
  }

  parseSchedules(xml: string): GdcScheduleSummary[] {
    this.parseResponse(xml);
    return [...xml.matchAll(/<schedule([^>]*)>([^<]+)<\/schedule>/gi)].map((match) => {
      const attrs = match[1];
      const read = (name: string) => new RegExp(`${name}="([^"]+)"`, "i").exec(attrs)?.[1];
      const playlistDurationText = read("playlist_duration");
      return {
        scheduleUuid: match[2].trim(),
        showContentVersionId: read("show_content_version_id"),
        showContentVerId: read("show_content_ver_id"),
        playlistDuration: playlistDurationText ? Number(playlistDurationText) : undefined,
        isoDateTime: read("iso_date_time"),
      };
    });
  }

  parsePlaybackStatus(xml: string): GdcPlaybackStatus {
    this.parseResponse(xml);
    const statusAttrs = readTagAttributes(xml, "status");
    const showPositionAttrs = readTagAttributes(xml, "show_position");
    const cplPositionAttrs = readTagAttributes(xml, "cpl_position");

    return {
      state: statusAttrs.state,
      seqStateForSyncMode: statusAttrs.seqStateForSyncMode,
      showUuid: readTag(xml, "show_uuid"),
      showName: readTag(xml, "show_name"),
      showPosition: parsePlaybackPosition(showPositionAttrs),
      cplUuid: readTag(xml, "cpl_uuid"),
      cplName: readTag(xml, "cpl_name"),
      cplPosition: parsePlaybackPosition(cplPositionAttrs),
    };
  }

  parseServerDateTime(xml: string): GdcServerDateTime {
    this.parseResponse(xml);
    return {
      isoDateTime: readTag(xml, "iso_date_time") ?? readTag(xml, "datetime"),
    };
  }

  parseStorageInfo(xml: string): GdcStorageInfo {
    this.parseResponse(xml);
    const attrs = readSelfClosingAttributes(xml, "storage");
    const totalSpace = attrs.total_space ? Number(attrs.total_space) : undefined;
    const freeSpace = attrs.free_space ? Number(attrs.free_space) : undefined;

    return {
      totalSpace,
      freeSpace,
      usedSpace:
        totalSpace !== undefined && freeSpace !== undefined
          ? totalSpace - freeSpace
          : undefined,
    };
  }

  parseTimezoneInfo(xml: string): GdcTimezoneInfo {
    this.parseResponse(xml);
    return {
      timezone: readTag(xml, "timezone"),
    };
  }

  parseServerIpList(xml: string): GdcServerIpList {
    this.parseResponse(xml);
    return {
      ipAddresses: [...xml.matchAll(/<ipaddr>([^<]+)<\/ipaddr>/gi)].map((match) =>
        match[1].trim(),
      ),
    };
  }

  parseSchedulerStatus(xml: string): GdcSchedulerStatus {
    this.parseResponse(xml);
    const attrs = readSelfClosingAttributes(xml, "status");
    return {
      enabled: attrs.enabled === "true" || attrs.enabled === "1",
    };
  }

  parseProjectorStatus(xml: string): GdcProjectorStatus {
    this.parseResponse(xml);
    const values = [...xml.matchAll(/<projector_status>([\s\S]*?)<\/projector_status>/gi)]
      .map((match) => decodeEntities(match[1].trim()))
      .filter(Boolean);
    const rawConnectionState = values[0];
    const normalized =
      rawConnectionState === "Connected" || rawConnectionState === "已连接"
        ? "Connected"
        : rawConnectionState === "Disconnected" || rawConnectionState === "未连接"
          ? "Disconnected"
          : "Unknown";

    return {
      connectionState: normalized,
      rawConnectionState,
      entries: values.slice(1).map((raw) => ({ raw })),
    };
  }

  parseShowList(xml: string): GdcShowSummary[] {
    this.parseResponse(xml);
    return [...xml.matchAll(/<show_uuid>([^<]+)<\/show_uuid>/gi)].map((match) => ({
      showUuid: match[1].trim(),
    }));
  }

  parseShowDetail(xml: string): GdcShowDetail {
    this.parseResponse(xml);
    const encodedShowXml = readTag(xml, "response_text");
    const rawShowXml = decodeEntities(encodedShowXml ?? "");
    const segments = parseShowPlaylistSegments(rawShowXml);
    const contentVersionId = readNestedTag(rawShowXml, "ContentVersion", "Id");
    const playCountText = readNestedTag(rawShowXml, "PlayTypeChoice", "PlayCount");

    return {
      showUuid: readTag(rawShowXml, "Id"),
      title: decodeEntities(readTag(rawShowXml, "ShowTitleText") ?? ""),
      issueDate: readTag(rawShowXml, "IssueDate"),
      issuer: decodeEntities(readTag(rawShowXml, "Issuer") ?? ""),
      creator: decodeEntities(readTag(rawShowXml, "Creator") ?? ""),
      contentVersionId,
      playlistPackId: readNestedTag(rawShowXml, "PlaylistPack", "Id"),
      playCount: playCountText ? Number(playCountText) : undefined,
      cplUuids: segments.map((segment) => segment.cplUuid),
      preShowCommands: [],
      segments,
      rawShowXml,
    };
  }

  parseIngestList(xml: string): GdcIngestListItem[] {
    this.parseResponse(xml);
    return [...xml.matchAll(/<ingest_uuid>([^<]+)<\/ingest_uuid>/gi)].map((match) => ({
      ingestUuid: match[1].trim(),
    }));
  }

  parseIngestStatus(xml: string): GdcIngestStatus {
    this.parseResponse(xml);
    const sizeAttrs = readSelfClosingAttributes(xml, "size");
    const errorList = parseIngestItems(xml, "error").map((item) => ({
      ...item,
      assetUri: redactFtpCredentials(item.assetUri),
    }));
    const warningList = parseIngestItems(xml, "warning").map((item) => ({
      ...item,
      assetUri: redactFtpCredentials(item.assetUri),
    }));

    return {
      ingestUuid: readTag(xml, "ingest_uuid"),
      assetUuid: readTag(xml, "asset_uuid"),
      assetType: readTag(xml, "asset_type"),
      assetUri: redactFtpCredentials(readTag(xml, "asset_uri")),
      status: readTag(xml, "status"),
      scheduleDateTime: readTag(xml, "schedule_datetime"),
      transferredSize: sizeAttrs.transferred ? Number(sizeAttrs.transferred) : undefined,
      totalSize: sizeAttrs.total ? Number(sizeAttrs.total) : undefined,
      description: readTag(xml, "description"),
      errorList,
      warningList,
      rawXml: redactFtpCredentials(xml) ?? xml,
    };
  }
}

function parseEventLogEntries(xml: string, date: string): GdcEventLogEntry[] {
  const entries: GdcEventLogEntry[] = [];
  const pattern = /<event\b([^>]*?)\/>|<event\b([^>]*?)>([\s\S]*?)<\/event>/gi;
  let match: RegExpExecArray | null = null;

  while ((match = pattern.exec(xml)) !== null) {
    entries.push(parseEventLogEntry(
      date,
      match[0],
      match[1] || match[2] || "",
      match[3]?.trim(),
    ));
  }

  return entries;
}

function parseEventLogEntry(
  date: string,
  rawXml: string,
  attrText: string,
  detailsXml?: string,
): GdcEventLogEntry {
  const attrs = parseAttributes(attrText);

  return {
    date,
    time: attrs.time,
    type: attrs.type,
    status: attrs.status,
    annotation: attrs.annotation,
    contentName: attrs.content_name,
    contentUuid: attrs.content_uuid,
    contentVersionId: attrs.content_version_id,
    cplIndex: readNumberAttribute(attrs, "cpl_index"),
    cplDuration: readNumberAttribute(attrs, "cpl_duration"),
    reelIndex: readNumberAttribute(attrs, "reel_index"),
    splUuid: attrs.spl_uuid,
    kdmUuid: attrs.kdm_uuid,
    performanceUuid: attrs.performance_uuid,
    attributes: attrs,
    detailsXml,
    rawXml,
  };
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([:\w-]+)="([^"]*)"/g;
  let attrMatch: RegExpExecArray | null = null;
  while ((attrMatch = attrRegex.exec(attrText)) !== null) {
    attrs[attrMatch[1]] = decodeEntities(attrMatch[2]);
  }
  return attrs;
}

function readNumberAttribute(attrs: Record<string, string>, name: string): number | undefined {
  const value = Number(attrs[name]);
  return Number.isFinite(value) ? value : undefined;
}

function parseCplDuration(rawCplXml: string): {
  durationSeconds?: number;
  durationFrames?: number;
  editRate?: string;
} {
  const pictureBlocks = readPictureBlocks(rawCplXml).map((entry) => entry.xml);
  if (pictureBlocks.length === 0) {
    return {};
  }

  let durationFrames = 0;
  let editRate: string | undefined;
  for (const block of pictureBlocks) {
    const durationText = readTag(block, "Duration") ?? readTag(block, "IntrinsicDuration");
    const frames = durationText ? Number(durationText) : Number.NaN;
    if (Number.isFinite(frames)) {
      durationFrames += frames;
    }
    editRate ??= readTag(block, "EditRate") ?? readTag(block, "FrameRate");
  }

  const fps = parseEditRateFps(editRate);
  return {
    durationFrames: durationFrames > 0 ? durationFrames : undefined,
    durationSeconds: durationFrames > 0 && fps ? durationFrames / fps : undefined,
    editRate,
  };
}

function parseCplMediaMetadata(rawCplXml: string): {
  isStereoscopic?: boolean;
  resolutionLabel?: "2K" | "4K";
  pictureWidth?: number;
  pictureHeight?: number;
  screenAspectRatio?: string;
  aspectRatioLabel?: string;
  formatTags?: readonly string[];
} {
  const pictureBlocks = readPictureBlocks(rawCplXml);
  const firstPicture = pictureBlocks[0];
  const screenAspectRatio = firstPicture ? readTag(firstPicture.xml, "ScreenAspectRatio") : undefined;
  const dimensions = parsePictureDimensions(firstPicture?.xml ?? "", screenAspectRatio);
  const isStereoscopic = pictureBlocks.some((entry) => entry.stereoscopic) ? true : inferStereoscopicFromText(rawCplXml);
  const resolutionLabel = inferResolutionLabel(dimensions.width, rawCplXml);
  const aspectRatioLabel = inferAspectRatioLabel(dimensions.width, dimensions.height, screenAspectRatio, rawCplXml);
  const formatTags = [
    isStereoscopic === undefined ? undefined : isStereoscopic ? "3D" : "2D",
    resolutionLabel,
  ].filter((tag): tag is string => Boolean(tag));

  return {
    isStereoscopic,
    resolutionLabel,
    pictureWidth: dimensions.width,
    pictureHeight: dimensions.height,
    screenAspectRatio,
    aspectRatioLabel,
    formatTags: formatTags.length ? formatTags : undefined,
  };
}

function readPictureBlocks(rawCplXml: string): Array<{ xml: string; stereoscopic: boolean }> {
  const blocks: Array<{ xml: string; stereoscopic: boolean }> = [];
  const pattern = /<((?:\w+:)?Main(?:Stereoscopic)?Picture)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(rawCplXml)) !== null) {
    blocks.push({
      xml: match[2],
      stereoscopic: /Stereoscopic/i.test(match[1]),
    });
  }
  return blocks;
}

function parsePictureDimensions(pictureXml: string, screenAspectRatio?: string): { width?: number; height?: number } {
  const width = readNumberTag(pictureXml, "StoredWidth")
    ?? readNumberTag(pictureXml, "Width")
    ?? readNumberTag(pictureXml, "HorizontalPixels");
  const height = readNumberTag(pictureXml, "StoredHeight")
    ?? readNumberTag(pictureXml, "Height")
    ?? readNumberTag(pictureXml, "VerticalPixels");
  if (width && height) {
    return { width, height };
  }

  const aspectParts = String(screenAspectRatio || "")
    .trim()
    .split(/\s+/)
    .map((part) => Number(part));
  if (aspectParts.length >= 2 && Number.isFinite(aspectParts[0]) && Number.isFinite(aspectParts[1])) {
    return {
      width: aspectParts[0],
      height: aspectParts[1],
    };
  }

  return {};
}

function readNumberTag(xml: string, tagName: string): number | undefined {
  const value = Number(readTag(xml, tagName));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function inferStereoscopicFromText(rawCplXml: string): boolean | undefined {
  const title = readCplSearchText(rawCplXml);
  if (hasCplToken(title, "3D")) {
    return true;
  }
  if (hasCplToken(title, "2D")) {
    return false;
  }
  return undefined;
}

function inferResolutionLabel(width: number | undefined, rawCplXml: string): "2K" | "4K" | undefined {
  if (width && width >= 3500) {
    return "4K";
  }
  if (width && width > 0) {
    return "2K";
  }

  const title = readCplSearchText(rawCplXml);
  if (hasCplToken(title, "4K")) {
    return "4K";
  }
  if (hasCplToken(title, "2K")) {
    return "2K";
  }
  return undefined;
}

function inferAspectRatioLabel(
  width: number | undefined,
  height: number | undefined,
  screenAspectRatio: string | undefined,
  rawCplXml: string,
): string | undefined {
  if (width && height) {
    const ratio = width / height;
    if (ratio >= 1.82 && ratio <= 1.88) {
      return "1.85";
    }
    if (ratio >= 2.34 && ratio <= 2.44) {
      return "2.39";
    }
    if (ratio >= 1.87 && ratio <= 1.92) {
      return "1.90";
    }
    return ratio.toFixed(2);
  }

  const title = readCplSearchText(rawCplXml);
  if (hasCplToken(title, "185")) {
    return "1.85";
  }
  if (hasCplToken(title, "239") || hasCplToken(title, "240") || hasCplToken(title, "235")) {
    return "2.39";
  }
  return screenAspectRatio;
}

function readCplSearchText(rawCplXml: string): string {
  return [
    readTag(rawCplXml, "ContentTitleText"),
    readTag(rawCplXml, "AnnotationText"),
    ...[...rawCplXml.matchAll(/<OriginalFileName>([\s\S]*?)<\/OriginalFileName>/gi)].map((match) => match[1]),
  ].filter(Boolean).join(" ");
}

function hasCplToken(value: string, token: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${token}([^A-Za-z0-9]|$)`, "i").test(value);
}

function parseEditRateFps(editRate: string | undefined): number | undefined {
  const parts = String(editRate || "").trim().split(/\s+/).map((part) => Number(part));
  if (parts.length === 0 || !Number.isFinite(parts[0]) || parts[0] <= 0) {
    return undefined;
  }
  const denominator = Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : 1;
  return parts[0] / denominator;
}

function readNestedTag(xml: string, parentTagName: string, tagName: string): string | undefined {
  const parent = readTag(xml, parentTagName);
  if (!parent) {
    return undefined;
  }
  return readTag(parent, tagName);
}

function parsePlaylistXml(rawShowXml: string): string {
  const match = /<Playlist\b[^>]*>([\s\S]*?)<\/Playlist>/i.exec(rawShowXml);
  return match?.[1] ?? "";
}

function parseShowPlaylistSegments(rawShowXml: string): GdcShowPlaylistSegment[] {
  const playlistXml = parsePlaylistXml(rawShowXml);
  const segments: Array<{ cplUuid: string; commands: GdcShowPlaylistCommand[] }> = [];
  let pendingCommands: GdcShowPlaylistCommand[] = [];
  const tokenPattern = /<PlaylistMarker\b[^>]*>[\s\S]*?<\/PlaylistMarker>|<CompositionPlaylistId>([\s\S]*?)<\/CompositionPlaylistId>/gi;
  let match: RegExpExecArray | null = null;

  while ((match = tokenPattern.exec(playlistXml)) !== null) {
    const token = match[0];
    if (/^<CompositionPlaylistId/i.test(token)) {
      const segment = {
        cplUuid: decodeEntities(match[1]?.trim() ?? ""),
        commands: pendingCommands,
      };
      pendingCommands = [];
      if (segment.cplUuid) {
        segments.push(segment);
      }
      continue;
    }

    const command = parsePlaylistMarker(token);
    if (command) {
      pendingCommands.push(command);
    }
  }

  if (pendingCommands.length > 0 && segments.length > 0) {
    segments[segments.length - 1].commands.push(...pendingCommands);
  }

  return segments;
}

function parsePlaylistMarker(markerXml: string): GdcShowPlaylistCommand | undefined {
  const label = decodeEntities(readTag(markerXml, "Label") ?? readTag(markerXml, "AnnotationText") ?? "");
  if (!label.trim()) {
    return undefined;
  }

  const offsetAttrs = readTagAttributes(markerXml, "Offset");
  const offsetText = readTagWithOptionalAttributes(markerXml, "Offset");
  const offsetFrames = offsetText !== undefined && offsetText !== "" ? Number(offsetText) : undefined;

  return {
    markerUuid: readTag(markerXml, "Id"),
    label: label.trim(),
    annotationText: decodeEntities(readTag(markerXml, "AnnotationText") ?? label).trim(),
    offsetFrames: Number.isFinite(offsetFrames) ? offsetFrames : undefined,
    editRate: offsetAttrs.EditRate ?? offsetAttrs.editRate,
  };
}
