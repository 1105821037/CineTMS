import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { getRepositoryRootPath } from "./kdm-store";

const uploadDirectoryName = ".uploads";
const dcpDirectoryName = "DCP";
const packageNamePattern = /^[^<>:"/\\|?*\x00-\x1F]+$/;

export interface DcpUploadSession {
  readonly uploadId: string;
  readonly packageName: string;
  readonly absolutePath: string;
  readonly createdAt: string;
}

export interface DcpPackageRecord {
  readonly id: string;
  readonly name: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly assetMapPath?: string;
  readonly volumeIndexPath?: string;
  readonly size: number;
  readonly fileCount: number;
  readonly xmlCount: number;
  readonly mxfCount: number;
  readonly pklCount: number;
  readonly cplCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: "ok" | "warning" | "error";
  readonly validationMessages: readonly string[];
  readonly pkls: readonly DcpPklRecord[];
  readonly cpls: readonly DcpCplRecord[];
}

export interface DcpPklRecord {
  readonly uuid: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly annotationText?: string;
  readonly issueDate?: string;
  readonly issuer?: string;
  readonly creator?: string;
  readonly totalSize?: number;
  readonly cplUuids: readonly string[];
}

export interface DcpCplRecord {
  readonly uuid: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly pklUuid?: string;
  readonly pklPath?: string;
  readonly annotationText?: string;
  readonly issueDate?: string;
  readonly issuer?: string;
  readonly creator?: string;
  readonly contentTitleText?: string;
  readonly contentKind?: string;
  readonly reelCount: number;
  readonly durationFrames?: number;
  readonly durationSeconds?: number;
  readonly editRate?: string;
  readonly aspectRatio?: string;
  readonly requiredSize?: number;
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

export async function listDcpPackages(): Promise<DcpPackageRecord[]> {
  const dcpDirectory = await ensureDcpDirectory();
  const dcpEntries = await readdir(dcpDirectory, { withFileTypes: true }).catch(() => []);

  const candidates = dcpEntries
    .filter((entry) => entry.isDirectory() && entry.name !== uploadDirectoryName)
    .map((entry) => ({
      absolutePath: join(dcpDirectory, entry.name),
      relativePath: `${dcpDirectoryName}/${entry.name}`,
    }));

  const records = await Promise.all(
    candidates.map((candidate) => readDcpPackage(candidate.absolutePath, candidate.relativePath).catch(() => null)),
  );

  return records
    .filter((record): record is DcpPackageRecord => Boolean(record))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export async function readDcpPackageById(packageId: string): Promise<DcpPackageRecord | null> {
  const packages = await listDcpPackages();
  return packages.find((item) => item.id === packageId || item.name === packageId) ?? null;
}

export async function createDcpUploadSession(packageName: string): Promise<DcpUploadSession> {
  const sanitizedPackageName = sanitizePackageName(packageName);
  const uploadRoot = await ensureUploadDirectory();
  const uploadId = `dcp-upload-${Date.now()}-${randomUUID()}`;
  const absolutePath = join(uploadRoot, uploadId);
  await mkdir(absolutePath, { recursive: true });
  await writeFile(
    join(absolutePath, ".session.json"),
    `${JSON.stringify({ packageName: sanitizedPackageName, createdAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );

  return {
    uploadId,
    packageName: sanitizedPackageName,
    absolutePath,
    createdAt: new Date().toISOString(),
  };
}

export async function writeDcpUploadFile(
  uploadId: string,
  relativeFilePath: string,
  request: IncomingMessage,
): Promise<void> {
  const uploadPath = await resolveUploadPath(uploadId);
  const safeRelativePath = normalizePackageRelativePath(relativeFilePath);
  if (!safeRelativePath) {
    throw new Error("DCP 文件路径无效。");
  }
  if (safeRelativePath === ".session.json") {
    throw new Error("DCP 文件路径被保留。");
  }

  const targetPath = resolve(uploadPath, ...safeRelativePath.split("/"));
  assertInsideDirectory(targetPath, uploadPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await pipeline(request, createWriteStream(targetPath));
}

export async function finishDcpUpload(uploadId: string): Promise<DcpPackageRecord> {
  const uploadPath = await resolveUploadPath(uploadId);
  const session = await readUploadSession(uploadPath);
  const packageRoot = await ensureDcpDirectory();
  const targetPath = await resolveAvailablePackagePath(packageRoot, session.packageName);
  const sessionPath = join(uploadPath, ".session.json");
  await rm(sessionPath, { force: true });

  const draft = await readDcpPackage(uploadPath, `${dcpDirectoryName}/${session.packageName}`);
  if (draft.status === "error") {
    throw new Error(draft.validationMessages.join("；") || "影片包校验未通过。");
  }

  await rename(uploadPath, targetPath);
  return readDcpPackage(targetPath, `${dcpDirectoryName}/${relative(packageRoot, targetPath).replaceAll("\\", "/")}`);
}

export async function cancelDcpUpload(uploadId: string): Promise<void> {
  const uploadPath = await resolveUploadPath(uploadId);
  await rm(uploadPath, { recursive: true, force: true });
}

async function readDcpPackage(absolutePath: string, relativePath: string): Promise<DcpPackageRecord> {
  const files = await walkFiles(absolutePath);
  const [rootStat, fileStats] = await Promise.all([
    stat(absolutePath),
    Promise.all(files.map(async (file) => ({ file, fileStat: await stat(join(absolutePath, file)) }))),
  ]);

  const assetMapPath = findCaseInsensitivePath(files, "ASSETMAP");
  const volumeIndexPath = findCaseInsensitivePath(files, "VOLINDEX");
  const validationMessages: string[] = [];
  let status: DcpPackageRecord["status"] = "ok";
  let assetMapAssets: AssetMapAsset[] = [];

  if (!assetMapPath) {
    validationMessages.push("缺少 ASSETMAP 文件。");
    status = "error";
  } else {
    const assetMapXml = await readFile(join(absolutePath, assetMapPath), "utf8");
    assetMapAssets = parseAssetMap(assetMapXml);
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
  const xmlFiles = files.filter((file) => file.toLowerCase().endsWith(".xml"));
  const pklCandidatePaths = uniqueStrings([
    ...pklPathsFromAssetMap,
    ...xmlFiles.filter((file) => /(^|\/)pkl[_-].*\.xml$/i.test(file)),
  ]);

  const assetMapPathByUuid = new Map(assetMapAssets.map((asset) => [normalizeUuid(asset.uuid), asset.path]));
  const pkls = await Promise.all(
    pklCandidatePaths.map((file) => parsePklFile(absolutePath, file).catch(() => null)),
  );
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

  const parsedCpls = await Promise.all(
    cplPaths.map((file) => parseCplFile(absolutePath, file).catch(() => null)),
  );
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

  const size = fileStats.reduce((total, item) => total + item.fileStat.size, 0);
  const updatedAt = new Date(Math.max(rootStat.mtimeMs, ...fileStats.map((item) => item.fileStat.mtimeMs))).toISOString();
  const safeRelativePath = relativePath.replaceAll("\\", "/");

  return {
    id: createHash("sha1").update(safeRelativePath).digest("hex"),
    name: absolutePath.split(/[\\/]+/).pop() || safeRelativePath,
    absolutePath,
    relativePath: safeRelativePath,
    assetMapPath,
    volumeIndexPath,
    size,
    fileCount: files.length,
    xmlCount: xmlFiles.length,
    mxfCount: files.filter((file) => file.toLowerCase().endsWith(".mxf")).length,
    pklCount: validPkls.length,
    cplCount: cpls.length,
    createdAt: rootStat.birthtime.toISOString(),
    updatedAt,
    status,
    validationMessages,
    pkls: validPkls.map(({ assets: _assets, ...pkl }) => pkl),
    cpls,
  };
}

async function parsePklFile(
  packageRoot: string,
  relativePath: string,
): Promise<DcpPklRecord & { assets: PklAsset[] }> {
  const xml = await readFile(join(packageRoot, relativePath), "utf8");
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

async function parseCplFile(
  packageRoot: string,
  relativePath: string,
): Promise<Omit<DcpCplRecord, "pklUuid" | "pklPath">> {
  const xml = await readFile(join(packageRoot, relativePath), "utf8");
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

async function walkFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return walkFiles(root, relativePath);
    }
    if (entry.isFile()) {
      return [relativePath];
    }
    return [];
  }));
  return nested.flat();
}

async function ensureDcpDirectory(): Promise<string> {
  const repositoryRoot = await getRepositoryRootPath();
  const dcpDirectory = join(repositoryRoot, dcpDirectoryName);
  await mkdir(dcpDirectory, { recursive: true });
  return dcpDirectory;
}

async function ensureUploadDirectory(): Promise<string> {
  const dcpDirectory = await ensureDcpDirectory();
  const uploadDirectory = join(dcpDirectory, uploadDirectoryName);
  await mkdir(uploadDirectory, { recursive: true });
  return uploadDirectory;
}

async function resolveUploadPath(uploadId: string): Promise<string> {
  if (!/^dcp-upload-\d+-[0-9a-f-]+$/i.test(uploadId)) {
    throw new Error("上传会话无效。");
  }
  const uploadDirectory = await ensureUploadDirectory();
  const uploadPath = resolve(uploadDirectory, uploadId);
  assertInsideDirectory(uploadPath, uploadDirectory);
  const uploadStat = await stat(uploadPath).catch(() => null);
  if (!uploadStat?.isDirectory()) {
    throw new Error("上传会话不存在或已结束。");
  }
  return uploadPath;
}

async function readUploadSession(uploadPath: string): Promise<{ packageName: string; createdAt: string }> {
  const raw = await readFile(join(uploadPath, ".session.json"), "utf8");
  const parsed = JSON.parse(raw) as { packageName?: unknown; createdAt?: unknown };
  return {
    packageName: sanitizePackageName(typeof parsed.packageName === "string" ? parsed.packageName : "uploaded.dcp"),
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
  };
}

async function resolveAvailablePackagePath(packageRoot: string, packageName: string): Promise<string> {
  const safeName = sanitizePackageName(packageName);
  let candidate = safeName;
  let index = 1;
  while (true) {
    const targetPath = resolve(packageRoot, candidate);
    assertInsideDirectory(targetPath, packageRoot);
    const exists = await stat(targetPath).then(() => true).catch(() => false);
    if (!exists) {
      return targetPath;
    }
    candidate = `${safeName}_${index}`;
    index += 1;
  }
}

function sanitizePackageName(value: string): string {
  const trimmed = String(value || "").trim() || "uploaded.dcp";
  const lastSegment = trimmed.replaceAll("\\", "/").split("/").filter(Boolean).pop() || "uploaded.dcp";
  const replaced = lastSegment.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  if (!packageNamePattern.test(replaced)) {
    throw new Error("影片包名称无效。");
  }
  return replaced || "uploaded.dcp";
}

function normalizePackageRelativePath(value: string): string {
  const normalized = String(value || "").replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === ".." || segment.includes("\0"))) {
    return "";
  }
  return segments.join("/");
}

function assertInsideDirectory(pathname: string, directory: string): void {
  const relativePath = relative(resolve(directory), resolve(pathname));
  if (relativePath.startsWith("..") || relativePath === ".." || relativePath.split(sep).includes("..")) {
    throw new Error("路径越界。");
  }
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
