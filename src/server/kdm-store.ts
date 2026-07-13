import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import JSZip from "jszip";
import type { HallConfig } from "./setup-store";
import { readConfiguredHalls, readRepositoryConfig } from "./setup-store";

const supportedExtensions = new Set([".xml"]);
const maxUploadFileBytes = 1024 * 1024;
const maxUploadZipBytes = 5 * 1024 * 1024;
const maxZipTotalXmlBytes = 20 * 1024 * 1024;
const maxZipXmlFiles = 200;
const recipientSerialTokenPattern = /^[A-Z]\d{4,}$/;

export interface KdmTargetHallStatus {
  readonly hallId: string;
  readonly hallName: string;
  readonly deviceCode: string;
  readonly online: boolean;
  readonly existingKdmStatus?: "present" | "absent" | "unknown";
}

export interface KdmAssetRecord {
  readonly id: string;
  readonly sha1: string;
  readonly fileName: string;
  readonly originalFileName: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly messageId: string;
  readonly messageType?: string;
  readonly annotationText?: string;
  readonly issueDate?: string;
  readonly compositionPlaylistId?: string;
  readonly contentTitleText?: string;
  readonly validBefore?: string;
  readonly validAfter?: string;
  readonly recipientSubjectName?: string;
  readonly recipientIssuerName?: string;
  readonly recipientCertificateSerialNumber?: string;
  readonly targetDeviceCode?: string;
  readonly importedAt?: string;
  readonly size: number;
  readonly createdAt: string;
  readonly location: "repository-root" | "kdm-directory";
  readonly targetHall?: KdmTargetHallStatus;
}

export interface KdmUploadInput {
  readonly name: string;
  readonly content: string;
  readonly encoding?: "text" | "base64";
}

export interface KdmUploadResult {
  readonly uploaded: readonly KdmAssetRecord[];
  readonly rejected: readonly {
    readonly name: string;
    readonly error: string;
  }[];
}

export async function listKdmAssets(options: {
  readonly onlineHallIds?: ReadonlySet<string>;
} = {}): Promise<KdmAssetRecord[]> {
  const repositoryRoot = await getRepositoryRootPath();
  const kdmDirectory = join(repositoryRoot, "KDM");
  await mkdir(kdmDirectory, { recursive: true });

  const [rootEntries, kdmEntries, configuredHalls] = await Promise.all([
    readdir(repositoryRoot, { withFileTypes: true }).catch(() => []),
    readdir(kdmDirectory, { withFileTypes: true }).catch(() => []),
    readConfiguredHalls().catch(() => []),
  ]);

  const rootCandidates = rootEntries
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      absolutePath: join(repositoryRoot, entry.name),
      relativePath: entry.name,
      location: "repository-root" as const,
    }));
  const kdmCandidates = kdmEntries
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      absolutePath: join(kdmDirectory, entry.name),
      relativePath: `KDM/${entry.name}`,
      location: "kdm-directory" as const,
    }));

  const records = await Promise.all(
    [...rootCandidates, ...kdmCandidates].map(async (candidate) =>
      readKdmAssetFromFile(candidate.absolutePath, candidate.relativePath, candidate.location).catch(() => null),
    ),
  );

  const hallByDeviceCode = new Map<string, HallConfig>();
  for (const hall of configuredHalls) {
    const serial = hall.gdcDeviceInfo?.serial?.trim();
    if (serial) {
      hallByDeviceCode.set(serial, hall);
    }
  }

  const deduped = new Map<string, KdmAssetRecord>();
  for (const record of records) {
    if (!record) {
      continue;
    }

    const hall = record.targetDeviceCode ? hallByDeviceCode.get(record.targetDeviceCode) : undefined;
    const enriched: KdmAssetRecord = {
      ...record,
      targetHall: hall ? {
        hallId: hall.id,
        hallName: hall.name,
        deviceCode: hall.gdcDeviceInfo?.serial || record.targetDeviceCode || "",
        online: hall.id ? options.onlineHallIds?.has(hall.id) === true : false,
      } : undefined,
    };
    const dedupeKey = record.messageId || record.sha1;
    const existing = deduped.get(dedupeKey);
    if (!existing || (existing.location === "repository-root" && enriched.location === "kdm-directory")) {
      deduped.set(dedupeKey, enriched);
    }
  }

  return [...deduped.values()].sort((left, right) => {
    const leftTime = Date.parse(left.issueDate || left.createdAt || "");
    const rightTime = Date.parse(right.issueDate || right.createdAt || "");
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });
}

export async function saveUploadedKdms(files: readonly KdmUploadInput[]): Promise<KdmUploadResult> {
  const kdmDirectory = await ensureKdmDirectory();
  const existingAssets = await listKdmAssets();
  const existingByMessageId = new Map(existingAssets.map((asset) => [asset.messageId, asset]));
  const uploaded: KdmAssetRecord[] = [];
  const rejected: Array<{ name: string; error: string }> = [];

  for (const file of files) {
    try {
      const expandedFiles = await expandKdmUploadInput(file);
      const parsedFiles = expandedFiles.map((expanded) => {
        const normalized = normalizeKdmXml(expanded.content);
        const parsed = parseKdmXml(normalized, expanded.name);
        return { file: expanded, normalized, parsed };
      });

      for (const item of parsedFiles) {
        const existing = existingByMessageId.get(item.parsed.messageId);
        if (existing) {
          uploaded.push(existing);
          continue;
        }

        const targetName = await resolveTargetFileName(kdmDirectory, sanitizeFileName(item.file.name), item.parsed.messageId);
        const absolutePath = join(kdmDirectory, targetName);
        await writeFile(absolutePath, item.normalized, "utf8");
        const saved = await readKdmAssetFromFile(absolutePath, `KDM/${targetName}`, "kdm-directory");
        uploaded.push(saved);
        existingByMessageId.set(saved.messageId, saved);
      }
    } catch (error) {
      rejected.push({
        name: file.name,
        error: error instanceof Error ? error.message : "KDM 校验失败。",
      });
    }
  }

  return { uploaded, rejected };
}

async function expandKdmUploadInput(file: KdmUploadInput): Promise<KdmUploadInput[]> {
  const extension = extname(file.name).toLowerCase();
  if (extension === ".xml") {
    const content = decodeUploadText(file);
    validateKdmXmlUploadFile(file.name, content);
    return [{ name: file.name, content, encoding: "text" }];
  }

  if (extension === ".zip") {
    return expandKdmZipUpload(file);
  }

  throw new Error("只允许上传 XML 文件或 ZIP 密钥包。");
}

async function expandKdmZipUpload(file: KdmUploadInput): Promise<KdmUploadInput[]> {
  const zipBuffer = decodeUploadBuffer(file);
  if (zipBuffer.byteLength <= 0) {
    throw new Error("ZIP 密钥包为空。");
  }
  if (zipBuffer.byteLength >= maxUploadZipBytes) {
    throw new Error("ZIP 密钥包大小必须小于 5MB。");
  }

  const zip = await JSZip.loadAsync(zipBuffer).catch(() => {
    throw new Error("ZIP 密钥包无法解压。");
  });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length === 0) {
    throw new Error("ZIP 密钥包内没有文件。");
  }
  if (entries.length > maxZipXmlFiles) {
    throw new Error(`ZIP 密钥包内 XML 文件不能超过 ${maxZipXmlFiles} 个。`);
  }

  const invalidEntry = entries.find((entry) => {
    const name = normalizeZipEntryName(entry.name);
    return !name || extname(name).toLowerCase() !== ".xml";
  });
  if (invalidEntry) {
    throw new Error(`ZIP 密钥包内包含非 XML 文件：${invalidEntry.name}`);
  }

  const expanded: KdmUploadInput[] = [];
  let totalUncompressedBytes = 0;
  for (const entry of entries) {
    const entryName = normalizeZipEntryName(entry.name);
    if (!entryName) {
      throw new Error(`ZIP 密钥包内存在非法路径：${entry.name}`);
    }

    const metadataSize = getZipEntryUncompressedSize(entry);
    if (typeof metadataSize === "number" && metadataSize >= maxUploadFileBytes) {
      throw new Error(`ZIP 密钥包内文件超过 1MB：${entry.name}`);
    }

    const contentBuffer = await entry.async("nodebuffer");
    totalUncompressedBytes += contentBuffer.byteLength;
    if (contentBuffer.byteLength >= maxUploadFileBytes) {
      throw new Error(`ZIP 密钥包内文件超过 1MB：${entry.name}`);
    }
    if (totalUncompressedBytes >= maxZipTotalXmlBytes) {
      throw new Error("ZIP 密钥包解压后总大小超过 20MB。");
    }

    const content = contentBuffer.toString("utf8");
    validateKdmXmlUploadFile(entryName, content);
    expanded.push({ name: entryName, content, encoding: "text" });
  }

  return expanded;
}

function validateKdmXmlUploadFile(fileName: string, content: string): void {
  if (extname(fileName).toLowerCase() !== ".xml") {
    throw new Error("只允许上传 XML 文件。");
  }

  const size = Buffer.byteLength(content, "utf8");
  if (size <= 0) {
    throw new Error("文件内容为空。");
  }
  if (size >= maxUploadFileBytes) {
    throw new Error("文件大小必须小于 1MB。");
  }
}

function decodeUploadText(file: KdmUploadInput): string {
  if (file.encoding === "base64") {
    return Buffer.from(file.content, "base64").toString("utf8");
  }
  return file.content;
}

function decodeUploadBuffer(file: KdmUploadInput): Buffer {
  if (file.encoding === "base64") {
    return Buffer.from(file.content, "base64");
  }
  return Buffer.from(file.content, "utf8");
}

function normalizeZipEntryName(entryName: string): string {
  const normalized = String(entryName || "").replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === ".." || segment.includes("\0"))) {
    return "";
  }
  return basename(segments[segments.length - 1]);
}

function getZipEntryUncompressedSize(entry: JSZip.JSZipObject): number | undefined {
  const metadata = entry as unknown as {
    readonly _data?: {
      readonly uncompressedSize?: unknown;
    };
  };
  const size = metadata._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : undefined;
}

export async function readKdmAssetById(assetId: string): Promise<KdmAssetRecord | null> {
  const assets = await listKdmAssets();
  return assets.find((asset) => asset.id === assetId || asset.messageId === assetId) ?? null;
}

export async function deleteKdmAsset(assetId: string): Promise<KdmAssetRecord | null> {
  const asset = await readKdmAssetById(assetId);
  if (!asset) {
    return null;
  }
  await unlink(asset.absolutePath);
  return asset;
}

export async function getRepositoryRootPath(): Promise<string> {
  const config = await readRepositoryConfig();
  return resolve(config.path);
}

async function ensureKdmDirectory(): Promise<string> {
  const repositoryRoot = await getRepositoryRootPath();
  const kdmDirectory = join(repositoryRoot, "KDM");
  await mkdir(kdmDirectory, { recursive: true });
  return kdmDirectory;
}

async function readKdmAssetFromFile(
  absolutePath: string,
  relativePath: string,
  location: "repository-root" | "kdm-directory",
): Promise<KdmAssetRecord> {
  const [xml, fileStat] = await Promise.all([
    readFile(absolutePath, "utf8"),
    stat(absolutePath),
  ]);
  const normalized = normalizeKdmXml(xml);
  const parsed = parseKdmXml(normalized, basename(absolutePath));

  return {
    id: parsed.messageId,
    sha1: createHash("sha1").update(normalized).digest("hex"),
    fileName: basename(absolutePath),
    originalFileName: basename(absolutePath),
    absolutePath,
    relativePath: relativePath.replaceAll("\\", "/"),
    messageId: parsed.messageId,
    messageType: parsed.messageType,
    annotationText: parsed.annotationText,
    issueDate: parsed.issueDate,
    compositionPlaylistId: parsed.compositionPlaylistId,
    contentTitleText: parsed.contentTitleText,
    validBefore: parsed.validBefore,
    validAfter: parsed.validAfter,
    recipientSubjectName: parsed.recipientSubjectName,
    recipientIssuerName: parsed.recipientIssuerName,
    recipientCertificateSerialNumber: parsed.recipientCertificateSerialNumber,
    targetDeviceCode: parsed.targetDeviceCode,
    size: fileStat.size,
    createdAt: fileStat.mtime.toISOString(),
    location,
  };
}

function parseKdmXml(xml: string, fileName: string) {
  const messageId = readRequiredTag(xml, "MessageId");
  const messageType = readOptionalTag(xml, "MessageType");
  if (!messageType || !messageType.toLowerCase().includes("kdm")) {
    throw new Error(`文件 ${fileName} 不是有效的 KDM 密钥。`);
  }

  const contentTitleText = readRequiredTag(xml, "ContentTitleText");
  const compositionPlaylistId = readRequiredTag(xml, "CompositionPlaylistId");
  const validBefore = readRequiredTag(xml, "ContentKeysNotValidBefore");
  const validAfter = readRequiredTag(xml, "ContentKeysNotValidAfter");
  const recipientSubjectName = readOptionalTagInSection(xml, "Recipient", "X509SubjectName");
  const recipientIssuerName = readOptionalTagInSection(xml, "Recipient", "X509IssuerName");
  const recipientCertificateSerialNumber = readOptionalTagInSection(xml, "Recipient", "X509SerialNumber");
  const targetDeviceCode = extractDeviceCode(recipientSubjectName);

  if (!targetDeviceCode) {
    throw new Error(`文件 ${fileName} 无法识别目标设备码。`);
  }

  return {
    messageId,
    messageType,
    annotationText: readOptionalTag(xml, "AnnotationText"),
    issueDate: readOptionalTag(xml, "IssueDate"),
    compositionPlaylistId,
    contentTitleText,
    validBefore,
    validAfter,
    recipientSubjectName,
    recipientIssuerName,
    recipientCertificateSerialNumber,
    targetDeviceCode,
  };
}

function normalizeKdmXml(xml: string): string {
  const normalized = xml.replace(/^\uFEFF/, "").trim();
  if (!normalized.startsWith("<?xml") && !normalized.includes("<DCinemaSecurityMessage")) {
    throw new Error("文件内容不是有效的 XML。");
  }
  if (!normalized.includes("<DCinemaSecurityMessage")) {
    throw new Error("XML 缺少 DCinemaSecurityMessage 根节点。");
  }
  if (!normalized.includes("<AuthenticatedPublic")) {
    throw new Error("XML 缺少 AuthenticatedPublic 段。");
  }
  return `${normalized}\n`;
}

function readRequiredTag(xml: string, tagName: string): string {
  const value = readOptionalTag(xml, tagName);
  if (!value) {
    throw new Error(`XML 缺少必填字段 ${tagName}。`);
  }
  return value;
}

function readOptionalTag(xml: string, tagName: string): string | undefined {
  const match = new RegExp(`<(?:\\w+:)?${tagName}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tagName}>`, "i").exec(xml);
  return match?.[1]?.trim();
}

function readOptionalTagInSection(xml: string, sectionTagName: string, tagName: string): string | undefined {
  const sectionMatch = new RegExp(
    `<(?:\\w+:)?${sectionTagName}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${sectionTagName}>`,
    "i",
  ).exec(xml);
  return sectionMatch ? readOptionalTag(sectionMatch[1], tagName) : undefined;
}

function extractDeviceCode(subjectName: string | undefined): string | undefined {
  if (!subjectName) {
    return undefined;
  }

  const cn = /CN=([^,]+)/i.exec(subjectName)?.[1] ?? subjectName;
  const tokens = cn
    .split(".")
    .map((token) => token.trim())
    .filter(Boolean);

  return tokens.find((token) => recipientSerialTokenPattern.test(token));
}

async function resolveTargetFileName(directory: string, originalFileName: string, messageId: string): Promise<string> {
  const ext = supportedExtensions.has(extname(originalFileName).toLowerCase()) ? extname(originalFileName) : ".xml";
  const base = basename(originalFileName, ext);
  let candidate = `${base}${ext}`;
  let index = 1;

  while (true) {
    const absolutePath = join(directory, candidate);
    const exists = await stat(absolutePath).then(() => true).catch(() => false);
    if (!exists) {
      return candidate;
    }

    const existingXml = await readFile(absolutePath, "utf8").catch(() => "");
    if (existingXml && readOptionalTag(existingXml, "MessageId") === messageId) {
      return candidate;
    }

    candidate = `${base}_${index}${ext}`;
    index += 1;
  }
}

function sanitizeFileName(fileName: string): string {
  const normalized = basename(String(fileName || "").trim() || "uploaded-kdm.xml");
  const replaced = normalized.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  return replaced || "uploaded-kdm.xml";
}
