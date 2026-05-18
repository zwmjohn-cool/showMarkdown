const MINERU_CACHE_DIR_NAME = "llm-for-zotero-mineru";

const MAX_FILE_NAME_LENGTH = 180;

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  write?: (path: string, data: Uint8Array) => Promise<unknown>;
};

type OSFileLike = {
  exists?: (path: string) => Promise<boolean>;
  makeDir?: (
    path: string,
    options?: { from?: string; ignoreExisting?: boolean },
  ) => Promise<void>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  writeAtomic?: (path: string, data: Uint8Array) => Promise<void>;
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
  return (
    globalThis as { PathUtils?: { join?: (...parts: string[]) => string } }
  ).PathUtils;
}

function joinLocalPath(...parts: string[]): string {
  const pathUtils = getPathUtils();
  if (pathUtils?.join) return pathUtils.join(...parts);

  const filtered = parts.filter(Boolean);
  if (!filtered.length) return "";
  const first = filtered[0].replace(/[\\/]+$/g, "");
  const rest = filtered
    .slice(1)
    .map((part) => part.replace(/^[\\/]+/g, "").replace(/[\\/]+$/g, ""));
  return [first, ...rest].filter(Boolean).join("/");
}

export function getMineruCacheDir(): string {
  return joinLocalPath(getBaseDir(), MINERU_CACHE_DIR_NAME);
}

export function isMineruCachePath(path: string): boolean {
  return normalizePath(path).startsWith(
    `${normalizePath(getMineruCacheDir())}/`,
  );
}

export function isMineruMarkdownPathForAttachment(
  attachmentId: number,
  path: string,
): boolean {
  const normalizedPath = normalizePath(path);
  return (
    normalizedPath.startsWith(
      `${normalizePath(getMineruItemDir(attachmentId))}/`,
    ) ||
    normalizedPath ===
      normalizePath(joinLocalPath(getMineruCacheDir(), `${attachmentId}.md`))
  );
}

export function getMineruItemDir(attachmentId: number): string {
  return joinLocalPath(getMineruCacheDir(), String(attachmentId));
}

export function getMineruLayoutPath(attachmentId: number): string {
  return joinLocalPath(getMineruItemDir(attachmentId), "layout.json");
}

function getMarkdownCandidates(
  attachmentId: number,
  itemTitle: string,
): string[] {
  return [
    joinLocalPath(getMineruItemDir(attachmentId), "full.md"),
    joinLocalPath(getMineruItemDir(attachmentId), "_content.md"),
    joinLocalPath(getMineruCacheDir(), `${attachmentId}.md`),
    getNamedMarkdownPath(attachmentId, itemTitle),
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

async function ensureDir(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.makeDirectory) {
    await io.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return;
  }

  const osFile = getOSFile();
  if (osFile?.makeDir) {
    await osFile.makeDir(path, { ignoreExisting: true });
  }
}

async function readFileBytes(path: string): Promise<Uint8Array | null> {
  const io = getIOUtils();
  if (io?.read) {
    try {
      const data = await io.read(path);
      return data instanceof Uint8Array
        ? data
        : new Uint8Array(data as ArrayBuffer);
    } catch {
      return null;
    }
  }

  const osFile = getOSFile();
  if (osFile?.read) {
    try {
      const data = await osFile.read(path);
      return data instanceof Uint8Array
        ? data
        : new Uint8Array(data as ArrayBuffer);
    } catch {
      return null;
    }
  }

  return null;
}

export async function readCachedTextFile(path: string): Promise<string | null> {
  const bytes = await readFileBytes(path);
  if (!bytes) return null;
  return new TextDecoder("utf-8").decode(bytes);
}

async function writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
  const io = getIOUtils();
  if (io?.write) {
    await io.write(path, bytes);
    return;
  }

  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    await osFile.writeAtomic(path, bytes);
  }
}

export async function findCachedMineruMarkdownPath(
  pdfAttachmentId: number,
  itemTitle: string,
): Promise<string | null> {
  for (const path of getMarkdownCandidates(pdfAttachmentId, itemTitle)) {
    if (await pathExists(path)) return path;
  }
  return null;
}

export async function findCachedMineruLayoutPath(
  pdfAttachmentId: number,
  itemTitle: string,
): Promise<string | null> {
  const candidates = [
    getMineruLayoutPath(pdfAttachmentId),
    ...getMarkdownCandidates(pdfAttachmentId, itemTitle).map((path) =>
      joinLocalPath(getDirectoryPath(path), "layout.json"),
    ),
  ];
  const seen = new Set<string>();

  for (const path of candidates) {
    const normalizedPath = normalizePath(path);
    if (seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    if (await pathExists(path)) return path;
  }

  return null;
}

export async function ensureNamedMineruMarkdownFile(
  pdfAttachmentId: number,
  itemTitle: string,
): Promise<string | null> {
  const sourcePath = await findCachedMineruMarkdownPath(
    pdfAttachmentId,
    itemTitle,
  );
  if (!sourcePath) return null;

  const targetPath = getNamedMarkdownPath(pdfAttachmentId, itemTitle);
  if (normalizePath(sourcePath) === normalizePath(targetPath))
    return targetPath;

  const bytes = await readFileBytes(sourcePath);
  if (!bytes) return null;

  await ensureDir(getMineruItemDir(pdfAttachmentId));
  await writeFileBytes(targetPath, bytes);
  return targetPath;
}

function getNamedMarkdownPath(attachmentId: number, itemTitle: string): string {
  return joinLocalPath(
    getMineruItemDir(attachmentId),
    `${sanitizeFileName(itemTitle)}.md`,
  );
}

function getDirectoryPath(path: string): string {
  const normalizedPath = normalizePath(path);
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex <= 0) return "";
  return normalizedPath.slice(0, separatorIndex);
}

function sanitizeFileName(value: string): string {
  const normalized = Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  return (normalized || "Untitled").slice(0, MAX_FILE_NAME_LENGTH);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}
