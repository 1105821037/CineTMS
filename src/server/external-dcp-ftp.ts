import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { Client } from "basic-ftp";
import type { DcpCplRecord, DcpPackageRecord, DcpPklRecord } from "./dcp-store";

export interface ExternalFtpSource {
  readonly label?: string;
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly rootPath?: string;
}

export interface ExternalFtpEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "directory" | "file";
  readonly size?: number;
  readonly modifiedAt?: string;
}

interface AssetMapAsset {
  readonly uuid: string;
  readonly path?: string;
  readonly packingList: boolean;
}

interface PklAsset {
  readonly uuid: string;
  readonly type?: string;
  readonly originalFileName?: string;
  readonly size?: number;
}

const maxRemoteFiles = 5000;

export function normalizeExternalFtpSource(value: unknown): ExternalFtpSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FTP 来源无效。");
  }
  const record = value as Record<string, unknown>;
  const host = String(record.host || "").trim();
  const port = Number(record.port || 21);
  if (!host || /[\s/\\]/.test(host)) {
    throw new Error("FTP 主机地址无效。");
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("FTP 端口无效。");
  }

  return {
    label: typeof record.label === "string" ? record.label.trim() : undefined,
    host,
    port,
    username: typeof record.username === "string" && record.username.trim() ? record.username.trim() : undefined,
    password: typeof record.password === "string" && record.password ? record.password : undefined,
    rootPath: normalizeRemotePath(typeof record.rootPath === "string" ? record.rootPath : ""),
  };
}

export function buildExternalFtpSourceUri(source: ExternalFtpSource): string {
  return `ftp://${source.host}:${source.port}`;
}

export function buildExternalFtpIngestSourceUri(source: ExternalFtpSource): string {
  if (!source.username && !source.password) {
    return buildExternalFtpSourceUri(source);
  }

  const username = encodeURIComponent(source.username || "anonymous");
  const password = source.password !== undefined ? `:${encodeURIComponent(source.password)}` : "";
  return `ftp://${username}${password}@${source.host}:${source.port}`;
}

export function buildExternalFtpContentPath(
  source: ExternalFtpSource,
  packagePath: string,
  assetMapPath: string,
): string {
  return encodeFtpPath(joinRemotePath(source.rootPath || "", packagePath, assetMapPath));
}

export async function listExternalFtpDirectory(
  source: ExternalFtpSource,
  path: string,
): Promise<{ path: string; parentPath: string | null; entries: ExternalFtpEntry[] }> {
  const currentPath = normalizeRemotePath(path);
  return withExternalFtpClient(source, async (client) => {
    const entries = await client.list(toFtpPath(joinRemotePath(source.rootPath || "", currentPath)));
    return {
      path: currentPath,
      parentPath: getParentRemotePath(currentPath),
      entries: entries
        .filter((entry) => !isHiddenRemoteEntry(entry.name))
        .map((entry) => ({
          name: entry.name,
          path: joinRemotePath(currentPath, entry.name),
          type: entry.isDirectory ? "directory" as const : "file" as const,
          size: entry.isFile ? entry.size : undefined,
          modifiedAt: entry.modifiedAt?.toISOString(),
        }))
        .sort((left, right) => {
          if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
          return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
        }),
    };
  });
}

export async function inspectExternalDcpPackage(
  source: ExternalFtpSource,
  packagePath: string,
): Promise<DcpPackageRecord> {
  const normalizedPackagePath = normalizeRemotePath(packagePath);
  if (!normalizedPackagePath && source.rootPath === undefined) {
    throw new Error("请选择一个 DCP 包目录。");
  }

  return withExternalFtpClient(source, async (client) => {
    const remoteRoot = joinRemotePath(source.rootPath || "", normalizedPackagePath);
    const files = await walkRemoteFiles(client, remoteRoot);
    const fileInfoByPath = new Map(files.map((item) => [item.path, item]));
    const filePaths = files.map((item) => item.path);
    const assetMapPath = findCaseInsensitivePath(filePaths, "ASSETMAP");
    const volumeIndexPath = findCaseInsensitivePath(filePaths, "VOLINDEX");
    const validationMessages: string[] = [];
    let status: DcpPackageRecord["status"] = "ok";
    let assetMapAssets: AssetMapAsset[] = [];

    if (!assetMapPath) {
      validationMessages.push("缺少 ASSETMAP 文件。");
      status = "error";
    } else {
      assetMapAssets = parseAssetMap(await readRemoteText(client, joinRemotePath(remoteRoot, assetMapPath)));
    }
    if (!volumeIndexPath) {
      validationMessages.push("缺少 VOLINDEX 文件。");
      if (status !== "error") status = "warning";
    }

    const pklPathsFromAssetMap = new Set(
      assetMapAssets
        .filter((asset) => asset.packingList && asset.path)
        .map((asset) => normalizePackageRelativePath(asset.path || ""))
        .filter(Boolean),
    );
    const xmlFiles = filePaths.filter((file) => file.toLowerCase().endsWith(".xml"));
    const pklCandidatePaths = uniqueStrings([
      ...pklPathsFromAssetMap,
      ...xmlFiles.filter((file) => /(^|\/)pkl[_-].*\.xml$/i.test(file)),
    ]);

    const assetMapPathByUuid = new Map(assetMapAssets.map((asset) => [normalizeUuid(asset.uuid), asset.path]));
    const pkls = [];
    for (const file of pklCandidatePaths) {
      pkls.push(await parseRemotePklFile(client, remoteRoot, file).catch(() => null));
    }
    const validPkls = pkls.filter((pkl): pkl is DcpPklRecord & { assets: PklAsset[] } => Boolean(pkl));
    const cplPaths = uniqueStrings([
      ...validPkls.flatMap((pkl) =>
        pkl.assets
          .filter((asset) => isCplAsset(asset))
          .map((asset) => resolveAssetFilePath(asset, assetMapPathByUuid))
          .filter((path): path is string => Boolean(path)),
      ),
      ...xmlFiles.filter((file) => /(^|\/)cpl[_-].*\.xml$/i.test(file)),
    ]);

    const parsedCpls = [];
    for (const file of cplPaths) {
      parsedCpls.push(await parseRemoteCplFile(client, remoteRoot, file).catch(() => null));
    }
    const pklByCplUuid = new Map<string, DcpPklRecord & { assets: PklAsset[] }>();
    for (const pkl of validPkls) {
      for (const cplUuid of pkl.cplUuids) {
        pklByCplUuid.set(normalizeUuid(cplUuid), pkl);
      }
    }

    const cpls = parsedCpls
      .filter((cpl): cpl is Omit<DcpCplRecord, "pklUuid" | "pklPath"> => Boolean(cpl))
      .map((cpl) => {
        const pkl = pklByCplUuid.get(normalizeUuid(cpl.uuid));
        return {
          ...cpl,
          pklUuid: pkl?.uuid,
          pklPath: pkl?.relativePath,
          requiredSize: pkl?.totalSize,
        };
      });

    if (validPkls.length === 0) {
      validationMessages.push("未找到有效的 PKL 文件。");
      status = "error";
    }
    if (cpls.length === 0) {
      validationMessages.push("未找到有效的影片版本文件。");
      status = "error";
    }
    if (cpls.some((cpl) => !cpl.pklUuid)) {
      validationMessages.push("部分影片版本未能关联到 PKL，无法导入到设备。");
      if (status !== "error") status = "warning";
    }

    const name = normalizedPackagePath.split("/").filter(Boolean).pop()
      || source.rootPath?.split("/").filter(Boolean).pop()
      || source.host;
    const size = files.reduce((total, item) => total + (item.size || 0), 0);
    const modifiedTimes = files.map((item) => item.modifiedAt?.getTime() || 0).filter((time) => time > 0);
    const updatedAt = new Date(modifiedTimes.length ? Math.max(...modifiedTimes) : Date.now()).toISOString();
    const relativePath = normalizedPackagePath;
    const sourceUri = buildExternalFtpSourceUri(source);

    return {
      id: createHash("sha1").update(`${sourceUri}|${source.rootPath || ""}|${relativePath}`).digest("hex"),
      name,
      absolutePath: `${sourceUri}/${joinRemotePath(source.rootPath || "", relativePath)}`,
      relativePath,
      assetMapPath,
      volumeIndexPath,
      size,
      fileCount: files.length,
      xmlCount: xmlFiles.length,
      mxfCount: filePaths.filter((file) => file.toLowerCase().endsWith(".mxf")).length,
      pklCount: validPkls.length,
      cplCount: cpls.length,
      createdAt: updatedAt,
      updatedAt,
      status,
      validationMessages,
      pkls: validPkls.map(({ assets: _assets, ...pkl }) => pkl),
      cpls,
    };
  });
}

async function withExternalFtpClient<T>(
  source: ExternalFtpSource,
  callback: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(15_000);
  try {
    await client.access({
      host: source.host,
      port: source.port,
      user: source.username || "anonymous",
      password: source.password || "anonymous@",
      secure: false,
    });
    return await callback(client);
  } finally {
    client.close();
  }
}

async function walkRemoteFiles(
  client: Client,
  rootPath: string,
  prefix = "",
  seen = { count: 0 },
): Promise<Array<{ path: string; size?: number; modifiedAt?: Date }>> {
  const entries = await client.list(toFtpPath(joinRemotePath(rootPath, prefix)));
  const files: Array<{ path: string; size?: number; modifiedAt?: Date }> = [];
  for (const entry of entries) {
    if (isHiddenRemoteEntry(entry.name)) {
      continue;
    }
    const relativePath = joinRemotePath(prefix, entry.name);
    if (entry.isDirectory) {
      files.push(...await walkRemoteFiles(client, rootPath, relativePath, seen));
      continue;
    }
    if (entry.isFile) {
      seen.count += 1;
      if (seen.count > maxRemoteFiles) {
        throw new Error("远端目录文件过多，请选择更具体的 DCP 包目录。");
      }
      files.push({ path: relativePath, size: entry.size, modifiedAt: entry.modifiedAt });
    }
  }
  return files;
}

async function readRemoteText(client: Client, path: string): Promise<string> {
  const sink = new BufferSink();
  await client.downloadTo(sink, toFtpPath(path));
  return Buffer.concat(sink.chunks).toString("utf8");
}

class BufferSink extends Writable {
  readonly chunks: Buffer[] = [];

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    callback();
  }
}

async function parseRemotePklFile(
  client: Client,
  packageRoot: string,
  relativePath: string,
): Promise<DcpPklRecord & { assets: PklAsset[] }> {
  const xml = await readRemoteText(client, joinRemotePath(packageRoot, relativePath));
  const assets = readBlocks(xml, "Asset").map((block) => ({
    uuid: readOptionalTag(block, "Id") || "",
    type: readOptionalTag(block, "Type"),
    originalFileName: readOptionalTag(block, "OriginalFileName"),
    size: readOptionalNumberTag(block, "Size"),
  })).filter((asset) => asset.uuid);
  const cplUuids = assets.filter((asset) => isCplAsset(asset)).map((asset) => asset.uuid);
  const totalSize = assets.reduce((total, asset) => total + (asset.size ?? 0), 0);

  return {
    uuid: readRequiredTag(xml, "Id"),
    fileName: relativePath.split("/").pop() || relativePath,
    relativePath,
    annotationText: readOptionalTag(xml, "AnnotationText"),
    issueDate: readOptionalTag(xml, "IssueDate"),
    issuer: readOptionalTag(xml, "Issuer"),
    creator: readOptionalTag(xml, "Creator"),
    totalSize: totalSize > 0 ? totalSize : undefined,
    cplUuids,
    assets,
  };
}

async function parseRemoteCplFile(
  client: Client,
  packageRoot: string,
  relativePath: string,
): Promise<Omit<DcpCplRecord, "pklUuid" | "pklPath">> {
  const xml = await readRemoteText(client, joinRemotePath(packageRoot, relativePath));
  const reels = readBlocks(xml, "Reel");
  const pictureAssets = reels
    .map((reel) => readPictureAssetBlock(reel))
    .filter((block): block is string => Boolean(block));
  const editRate = pictureAssets.map((block) => readOptionalTag(block, "EditRate") || readOptionalTag(block, "FrameRate")).find(Boolean)
    || readOptionalTag(xml, "EditRate")
    || readOptionalTag(xml, "FrameRate");
  const reelDurations = pictureAssets
    .map((block) => Number(readOptionalTag(block, "Duration") || readOptionalTag(block, "IntrinsicDuration")))
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  const durationFrames = reelDurations.length > 0
    ? reelDurations.reduce((total, duration) => total + duration, 0)
    : Number(readOptionalTag(xml, "Duration") || readOptionalTag(xml, "IntrinsicDuration"));
  const durationSeconds = Number.isFinite(durationFrames) ? framesToSeconds(durationFrames, editRate) : undefined;

  return {
    uuid: readRequiredTag(xml, "Id"),
    fileName: relativePath.split("/").pop() || relativePath,
    relativePath,
    annotationText: readOptionalTag(xml, "AnnotationText"),
    issueDate: readOptionalTag(xml, "IssueDate"),
    issuer: readOptionalTag(xml, "Issuer"),
    creator: readOptionalTag(xml, "Creator"),
    contentTitleText: readOptionalTag(xml, "ContentTitleText"),
    contentKind: readOptionalTag(xml, "ContentKind"),
    reelCount: reels.length,
    durationFrames: Number.isFinite(durationFrames) ? durationFrames : undefined,
    durationSeconds,
    editRate,
    aspectRatio: pictureAssets.map((block) => readOptionalTag(block, "ScreenAspectRatio")).find(Boolean)
      || readOptionalTag(xml, "ScreenAspectRatio"),
  };
}

function readPictureAssetBlock(reelXml: string): string | undefined {
  return readBlocks(reelXml, "MainStereoscopicPicture")[0]
    || readBlocks(reelXml, "MainPicture")[0];
}

function parseAssetMap(xml: string): AssetMapAsset[] {
  return readBlocks(xml, "Asset")
    .map((block) => ({
      uuid: readOptionalTag(block, "Id") || "",
      path: normalizePackageRelativePath(readOptionalTag(block, "Path") || ""),
      packingList: hasTag(block, "PackingList") && !/^false$/i.test(readOptionalTag(block, "PackingList") || ""),
    }))
    .filter((asset) => asset.uuid);
}

function resolveAssetFilePath(asset: PklAsset, assetMapPathByUuid: Map<string, string | undefined>): string | undefined {
  const assetMapPath = assetMapPathByUuid.get(normalizeUuid(asset.uuid));
  if (assetMapPath) {
    return normalizePackageRelativePath(assetMapPath);
  }
  if (asset.originalFileName) {
    return normalizePackageRelativePath(asset.originalFileName);
  }
  return undefined;
}

function isCplAsset(asset: PklAsset): boolean {
  return /asdcpKind=CPL/i.test(asset.type || "") || /(^|[\\/])CPL[_-].*\.xml$/i.test(asset.originalFileName || "");
}

function normalizeRemotePath(value: string): string {
  return normalizePackageRelativePath(String(value || "").replace(/^\/+/, ""));
}

function normalizePackageRelativePath(value: string): string {
  const normalized = String(value || "").replaceAll("\\", "/");
  if (!normalized || /^[A-Za-z]:\//.test(normalized)) {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment.includes("\0"))) {
    return "";
  }
  return segments.join("/");
}

function joinRemotePath(...parts: Array<string | undefined>): string {
  return parts
    .flatMap((part) => String(part || "").replaceAll("\\", "/").split("/"))
    .filter(Boolean)
    .join("/");
}

function toFtpPath(path: string): string {
  return path ? `/${path}` : "/";
}

function getParentRemotePath(path: string): string | null {
  const parts = normalizeRemotePath(path).split("/").filter(Boolean);
  if (parts.length === 0) return null;
  parts.pop();
  return parts.join("/");
}

function findCaseInsensitivePath(files: readonly string[], fileName: string): string | undefined {
  const target = fileName.toLowerCase();
  return files.find((file) => file.split("/").pop()?.toLowerCase() === target);
}

function readBlocks(xml: string, tagName: string): string[] {
  const pattern = new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tagName}>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => match[1]);
}

function readRequiredTag(xml: string, tagName: string): string {
  const value = readOptionalTag(xml, tagName);
  if (!value) {
    throw new Error(`XML 缺少必填字段 ${tagName}。`);
  }
  return value;
}

function readOptionalTag(xml: string, tagName: string): string | undefined {
  const match = new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tagName}>`, "i").exec(xml);
  return match?.[1]?.trim();
}

function readOptionalNumberTag(xml: string, tagName: string): number | undefined {
  const value = Number(readOptionalTag(xml, tagName));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasTag(xml: string, tagName: string): boolean {
  return new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*(?:/>|>[\\s\\S]*?</(?:\\w+:)?${tagName}>)`, "i").test(xml);
}

function framesToSeconds(frames: number, editRate: string | undefined): number | undefined {
  const parts = String(editRate || "").trim().split(/\s+/).map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1]) || parts[0] <= 0) {
    return undefined;
  }
  return Math.round((frames / (parts[0] / parts[1])) * 10) / 10;
}

function normalizeUuid(value: string): string {
  return value.trim().toLowerCase().replace(/^urn:uuid:/, "");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function encodeFtpPath(relativePath: string): string {
  return relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function isHiddenRemoteEntry(name: string): boolean {
  return !name || name === "." || name === ".." || name.startsWith(".");
}
