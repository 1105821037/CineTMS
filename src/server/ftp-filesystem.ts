import { join } from "node:path";
import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { FileSystem, type FtpConnection } from "ftp-srv";

type FileStatWithName = Awaited<ReturnType<typeof stat>> & { name: string };

export class TmsRepositoryFtpFileSystem extends FileSystem {
  constructor(connection: FtpConnection, root: string) {
    super(connection, { root, cwd: "/" });
  }

  override async list(path = "."): Promise<FileStatWithName[]> {
    const entries = await super.list(path) as FileStatWithName[];
    if (entries.length > 0) {
      return entries;
    }

    // Windows Explorer may treat an entirely empty LIST response as a folder access error.
    // Expose a stable placeholder directory entry so the folder can still be opened.
    const placeholderName = ".tms-placeholder";
    const placeholderPath = join(this.root, placeholderName);
    await access(placeholderPath, constants.F_OK).catch(async () => {
      await mkdir(placeholderPath, { recursive: true });
    });

    const placeholderStat = await stat(placeholderPath) as FileStatWithName;
    placeholderStat.name = placeholderName;
    return [placeholderStat];
  }
}
