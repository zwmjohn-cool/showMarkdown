const MINERU_CACHE_DIR_NAME = "llm-for-zotero-mineru";

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
};

type OSFileLike = {
  exists?: (path: string) => Promise<boolean>;
};

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getOSFile(): OSFileLike | undefined {
  return (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
}

function getBaseDir(): string {
  const zotero = Zotero as unknown as {
    DataDirectory?: { dir?: string };
    Profile?: { dir?: string };
  };
  const dataDir = zotero.DataDirectory?.dir;
  if (typeof dataDir === "string" && dataDir.trim()) return dataDir.trim();
  const profileDir = zotero.Profile?.dir;
  if (typeof profileDir === "string" && profileDir.trim()) {
    return profileDir.trim();
  }
  throw new Error("Cannot resolve Zotero data directory");
}

function getPathUtils(): { join?: (...parts: string[]) => string } | undefined {
  return (globalThis as { PathUtils?: { join?: (...parts: string[]) => string } })
    .PathUtils;
}

function joinLocalPath(...parts: string[]): string {
  const pathUtils = getPathUtils();
  if (pathUtils?.join) return pathUtils.join(...parts);

  const filtered = parts.filter(Boolean);
  if (!filtered.length) return "";
  const first = filtered[0].replace(/[\\/]+$/g, "");
  const rest = filtered.slice(1).map((part) =>
    part
      .replace(/^[\\/]+/g, "")
      .replace(/[\\/]+$/g, ""),
  );
  return [first, ...rest].filter(Boolean).join("/");
}

export function getMineruCacheDir(): string {
  return joinLocalPath(getBaseDir(), MINERU_CACHE_DIR_NAME);
}

export function getMineruItemDir(attachmentId: number): string {
  return joinLocalPath(getMineruCacheDir(), String(attachmentId));
}

function getMarkdownCandidates(attachmentId: number): string[] {
  return [
    joinLocalPath(getMineruItemDir(attachmentId), "full.md"),
    joinLocalPath(getMineruItemDir(attachmentId), "_content.md"),
    joinLocalPath(getMineruCacheDir(), `${attachmentId}.md`),
  ];
}

async function pathExists(path: string): Promise<boolean> {
  const io = getIOUtils();
  if (io?.exists) {
    try {
      return Boolean(await io.exists(path));
    } catch {
      return false;
    }
  }
  const osFile = getOSFile();
  if (osFile?.exists) {
    try {
      return Boolean(await osFile.exists(path));
    } catch {
      return false;
    }
  }
  return false;
}

export async function findCachedMineruMarkdownPath(
  pdfAttachmentId: number,
): Promise<string | null> {
  for (const path of getMarkdownCandidates(pdfAttachmentId)) {
    if (await pathExists(path)) return path;
  }
  return null;
}
