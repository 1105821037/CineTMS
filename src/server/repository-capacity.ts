import { mkdir, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { readRepositoryConfig } from "./setup-store";

export interface RepositoryCapacityInfo {
  readonly path: string;
  readonly totalSpace?: number;
  readonly usedSpace?: number;
  readonly availableSpace?: number;
  readonly freeSpace?: number;
  readonly updatedAt: string;
  readonly error?: string;
}

export async function readRepositoryCapacity(): Promise<RepositoryCapacityInfo> {
  const repository = await readRepositoryConfig();
  const repositoryPath = resolve(repository.path);

  try {
    await mkdir(repositoryPath, { recursive: true });
    const info = await statfs(repositoryPath);
    const blockSize = Number(info.bsize);
    const blocks = Number(info.blocks);
    const availableBlocks = Number(info.bavail);
    const freeBlocks = Number(info.bfree);
    const totalSpace = multiplyFinite(blocks, blockSize);
    const availableSpace = multiplyFinite(availableBlocks, blockSize);
    const freeSpace = multiplyFinite(freeBlocks, blockSize);

    return {
      path: repositoryPath,
      totalSpace,
      usedSpace: subtractFinite(totalSpace, availableSpace),
      availableSpace,
      freeSpace,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      path: repositoryPath,
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "无法读取存储库容量。",
    };
  }
}

function multiplyFinite(left: number, right: number): number | undefined {
  const result = left * right;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function subtractFinite(left: number | undefined, right: number | undefined): number | undefined {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return undefined;
  }
  return Math.max(Number(left) - Number(right), 0);
}
