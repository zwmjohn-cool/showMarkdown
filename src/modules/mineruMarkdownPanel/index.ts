import { config } from "../../../package.json";
import { findCachedMineruMarkdownPath } from "./cache";

const MARKDOWN_ATTACHMENT_TITLE = "Markdown";
const MARKDOWN_CONTENT_TYPE = "text/markdown";

type SelectListenerApi = {
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
};

type PaneWithSelection = {
  getSelectedItems?: () => Zotero.Item[];
  itemsView?: false | {
    onSelect?: SelectListenerApi;
  };
};

type SelectListenerHandle = {
  pane: PaneWithSelection;
  listener: () => void;
};

let notifierObserverId: string | null = null;
const processingItemIds = new Set<number>();
const selectionListeners = new WeakMap<Window, SelectListenerHandle>();

export function registerMineruMarkdownAttachmentSync() {
  if (notifierObserverId) return;
  notifierObserverId = Zotero.Notifier.registerObserver(
    {
      notify: async (event, type, ids) => {
        if (type !== "item") return;
        if (event !== "add" && event !== "modify" && event !== "refresh") return;
        await syncItemsByIds(ids);
      },
    },
    ["item"],
    config.addonID,
  );
}

export function unregisterMineruMarkdownAttachmentSync() {
  if (!notifierObserverId) return;
  Zotero.Notifier.unregisterObserver(notifierObserverId);
  notifierObserverId = null;
  processingItemIds.clear();
}

export function registerSelectionSync(win: _ZoteroTypes.MainWindow) {
  if (selectionListeners.has(win)) return;
  const pane = (win.ZoteroPane || Zotero.getActiveZoteroPane?.()) as
    | PaneWithSelection
    | undefined;
  if (!pane) return;
  const itemsView = pane.itemsView || undefined;
  const listenerApi = itemsView?.onSelect;
  if (!listenerApi?.addListener) return;

  const listener = () => {
    void syncSelectedItems(win);
  };
  listenerApi.addListener(listener);
  selectionListeners.set(win, { pane, listener });
}

export function unregisterSelectionSync(win: Window) {
  const handle = selectionListeners.get(win);
  if (!handle) return;
  const itemsView = handle.pane.itemsView || undefined;
  itemsView?.onSelect?.removeListener?.(handle.listener);
  selectionListeners.delete(win);
}

export async function syncSelectedItems(win?: _ZoteroTypes.MainWindow) {
  const pane = (win?.ZoteroPane || Zotero.getActiveZoteroPane?.()) as
    | PaneWithSelection
    | undefined;
  const selectedItems = pane?.getSelectedItems?.() || [];
  await Promise.all(selectedItems.map((item) => syncItem(item)));
}

async function syncItemsByIds(ids: string[] | number[]) {
  await Promise.all(
    ids.map(async (id) => {
      const numericId = Number(id);
      if (!Number.isFinite(numericId)) return;
      const item = Zotero.Items.get(numericId);
      if (!item) return;
      await syncItem(item);
    }),
  );
}

async function syncItem(item: Zotero.Item) {
  if (isPdfAttachment(item)) {
    await ensureMarkdownAttachmentForPdf(item);
    return;
  }

  if (isRegularItem(item)) {
    await syncRegularItemMarkdownAttachments(item);
  }
}

export async function syncRegularItemMarkdownAttachments(parentItem: Zotero.Item) {
  if (!isRegularItem(parentItem)) return;
  const attachmentIds = parentItem.getAttachments?.() || [];
  await Promise.all(
    attachmentIds.map(async (attachmentId) => {
      const attachment = Zotero.Items.get(attachmentId);
      if (attachment && isPdfAttachment(attachment)) {
        await ensureMarkdownAttachmentForPdf(attachment);
      }
    }),
  );
}

export async function ensureMarkdownAttachmentForPdf(pdfAttachment: Zotero.Item) {
  if (!isPdfAttachment(pdfAttachment)) return;
  if (processingItemIds.has(pdfAttachment.id)) return;

  processingItemIds.add(pdfAttachment.id);
  try {
    const parentId = Number(pdfAttachment.parentID || 0);
    if (!parentId) return;

    const parentItem = Zotero.Items.get(parentId);
    if (!isRegularItem(parentItem)) return;

    const markdownPath = await findCachedMineruMarkdownPath(pdfAttachment.id);
    if (!markdownPath) return;

    const existing = await findExistingMarkdownAttachment(parentItem, markdownPath);
    if (existing) {
      await normalizeMarkdownAttachment(existing);
      return;
    }

    const linkedAttachment = await Zotero.Attachments.linkFromFile({
      file: markdownPath,
      parentItemID: parentItem.id,
      title: MARKDOWN_ATTACHMENT_TITLE,
      contentType: MARKDOWN_CONTENT_TYPE,
      charset: "utf-8",
    });
    await normalizeMarkdownAttachment(linkedAttachment);
  } catch (err) {
    ztoolkit.log("Show Markdown: failed to create Markdown attachment", err);
  } finally {
    processingItemIds.delete(pdfAttachment.id);
  }
}

async function findExistingMarkdownAttachment(
  parentItem: Zotero.Item,
  markdownPath: string,
): Promise<Zotero.Item | null> {
  const targetPath = normalizePath(markdownPath);
  const attachmentIds = parentItem.getAttachments?.() || [];

  for (const attachmentId of attachmentIds) {
    const attachment = Zotero.Items.get(attachmentId);
    if (!attachment?.isAttachment?.() || isPdfAttachment(attachment)) continue;

    const attachmentPath = await getAttachmentPath(attachment);
    if (attachmentPath && normalizePath(attachmentPath) === targetPath) {
      return attachment;
    }
  }

  return null;
}

async function normalizeMarkdownAttachment(attachment: Zotero.Item) {
  const currentTitle = String(attachment.getField?.("title") || "");
  const mutable = attachment as Zotero.Item & {
    attachmentContentType?: string;
  };

  let changed = false;
  if (currentTitle !== MARKDOWN_ATTACHMENT_TITLE) {
    attachment.setField?.("title", MARKDOWN_ATTACHMENT_TITLE);
    changed = true;
  }
  if (mutable.attachmentContentType !== MARKDOWN_CONTENT_TYPE) {
    mutable.attachmentContentType = MARKDOWN_CONTENT_TYPE;
    changed = true;
  }
  if (changed) await attachment.saveTx();
}

async function getAttachmentPath(attachment: Zotero.Item): Promise<string | null> {
  const withPath = attachment as Zotero.Item & {
    getFilePathAsync?: () => Promise<string | false | null | undefined>;
    getFilePath?: () => string | false | null | undefined;
    attachmentPath?: string;
  };

  const asyncPath = await withPath.getFilePathAsync?.();
  if (typeof asyncPath === "string" && asyncPath) return asyncPath;

  const syncPath = withPath.getFilePath?.();
  if (typeof syncPath === "string" && syncPath) return syncPath;

  return withPath.attachmentPath || null;
}

function isRegularItem(item: Zotero.Item | null | undefined): item is Zotero.Item {
  return Boolean(item?.isRegularItem?.());
}

function isPdfAttachment(item: Zotero.Item | null | undefined): item is Zotero.Item {
  if (!item?.isAttachment?.()) return false;
  const attachment = item as Zotero.Item & {
    isPDFAttachment?: () => boolean;
    attachmentContentType?: string;
    attachmentFilename?: string;
  };
  if (attachment.isPDFAttachment?.()) return true;
  if (attachment.attachmentContentType === "application/pdf") return true;
  return Boolean(attachment.attachmentFilename?.toLowerCase().endsWith(".pdf"));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}
