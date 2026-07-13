import { randomUUID } from "node:crypto";
import type { GdcPutShowInput, GdcPutShowResult, GdcShowPlaylistCommand, GdcShowPlaylistSegment } from "./types";

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

export class GdcShowPlaylistBuilder {
  build(input: GdcPutShowInput): GdcPutShowResult {
    const segments = normalizeSegments(input);
    if (segments.length === 0) {
      throw new Error("putShow requires at least one CPL UUID");
    }

    const showUuid = normalizeUrnUuid(input.showUuid) ?? `urn:uuid:${randomUUID()}`;
    const contentVersionId = input.contentVersionId || randomUUID();
    const playlistPackId = normalizeUrnUuid(input.playlistPackId) ?? `urn:uuid:${randomUUID()}`;
    const issueDate = new Date().toISOString();
    const issuer = escapeXml(input.issuer ?? "GDC");
    const creator = escapeXml(input.creator ?? "SMS");
    const title = escapeXml(input.title);
    const playCount = input.playCount ?? 1;
    const playlistLines = [
      ...buildCommandLines(input.preShowCommands ?? [], 4, false),
      ...segments.flatMap((segment) => [
        ...buildCommandLines(segment.commands ?? [], 4, true),
        `${indent(4)}<CompositionPlaylistId>${escapeXml(segment.cplUuid)}</CompositionPlaylistId>`,
      ]),
    ].join("\n");

    const showXml = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<ShowPlaylist xmlns="http://www.smpte-ra.org/430-8/2006/SPL">
  <Id>${showUuid}</Id>
  <IssueDate>${issueDate}</IssueDate>
  <Issuer>${issuer}</Issuer>
  <Creator>${creator}</Creator>
  <ShowTitleText>${title}</ShowTitleText>
  <ContentVersion>
    <Id>${contentVersionId}</Id>
    <LabelText>GDC SPL</LabelText>
  </ContentVersion>
  <PackList>
    <PlaylistPack>
      <Id>${playlistPackId}</Id>
      <PlayTypeChoice>
        <PlayCount>${playCount}</PlayCount>
      </PlayTypeChoice>
      <Playlist>
${playlistLines}
      </Playlist>
    </PlaylistPack>
  </PackList>
</ShowPlaylist>`;

    return {
      showUuid,
      contentVersionId,
      showXml,
    };
  }

  wrapCommandText(showXml: string): string {
    return `<command_text>${escapeXml(showXml)}</command_text>`;
  }
}

function normalizeSegments(input: GdcPutShowInput): readonly GdcShowPlaylistSegment[] {
  if (input.segments && input.segments.length > 0) {
    return input.segments
      .map((segment) => ({
        cplUuid: normalizeUrnUuid(segment.cplUuid) ?? segment.cplUuid,
        commands: segment.commands ?? [],
      }))
      .filter((segment) => segment.cplUuid.trim());
  }

  return (input.cplUuids ?? [])
    .map((cplUuid) => normalizeUrnUuid(cplUuid) ?? cplUuid)
    .filter((cplUuid) => cplUuid.trim())
    .map((cplUuid) => ({ cplUuid }));
}

function buildCommandLines(
  commands: readonly GdcShowPlaylistCommand[],
  depth: number,
  includeOffset: boolean,
): string[] {
  return commands
    .filter((command) => command.label.trim())
    .map((command, index) => ({ command, index }))
    .sort((left, right) => {
      const leftOffset = Number.isFinite(left.command.offsetFrames) ? Math.max(0, Math.round(left.command.offsetFrames ?? 0)) : 0;
      const rightOffset = Number.isFinite(right.command.offsetFrames) ? Math.max(0, Math.round(right.command.offsetFrames ?? 0)) : 0;
      return leftOffset - rightOffset || left.index - right.index;
    })
    .flatMap(({ command }) => buildCommandXml(command, depth, includeOffset));
}

function buildCommandXml(
  command: GdcShowPlaylistCommand,
  depth: number,
  includeOffset: boolean,
): string[] {
  const markerUuid = normalizeUrnUuid(command.markerUuid) ?? `urn:uuid:${randomUUID()}`;
  const label = escapeXml(command.label.trim());
  const annotationText = escapeXml((command.annotationText || command.label).trim());
  const lines = [
    `${indent(depth)}<PlaylistMarker>`,
    `${indent(depth + 1)}<Id>${markerUuid}</Id>`,
    `${indent(depth + 1)}<Label>${label}</Label>`,
    `${indent(depth + 1)}<AnnotationText>${annotationText}</AnnotationText>`,
  ];

  if (includeOffset && Number.isFinite(command.offsetFrames)) {
    lines.push(
      `${indent(depth + 1)}<Offset EditRate="${escapeXml(command.editRate || "24 1")}">${Math.max(0, Math.round(command.offsetFrames ?? 0))}</Offset>`,
    );
  }

  lines.push(`${indent(depth)}</PlaylistMarker>`);
  return lines;
}

function normalizeUrnUuid(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("urn:uuid:") ? trimmed : `urn:uuid:${trimmed}`;
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}
