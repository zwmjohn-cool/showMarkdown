import { config } from "../../../package.json";
import {
  findCachedMineruLayoutPath,
  readCachedTextFile,
} from "../mineruMarkdownPanel/cache";

const PANE_ID = "show-markdown-mineru-tools";
const BBOX_LAYER_CLASS = "show-markdown-bbox-layer";
const BBOX_CLASS = "show-markdown-bbox";
const PANE_STYLE_ID = "show-markdown-mineru-tools-style";
const PDF_STYLE_ID = "show-markdown-bbox-style";
const ICON_URI = `chrome://${config.addonRef}/content/icons/icon-20.png`;

type SectionProps = _ZoteroTypes.ItemPaneManagerSection.SectionHookArgs;

type PrivatePdfReader = _ZoteroTypes.ReaderInstance<"pdf"> & {
  _lastView?: PdfViewLike;
  _primaryView?: PdfViewLike;
  _secondaryView?: PdfViewLike;
  _internalReader?: {
    _lastView?: PdfViewLike;
    _primaryView?: PdfViewLike;
    _secondaryView?: PdfViewLike;
  };
};

type PdfViewLike = {
  initializedPromise?: Promise<void>;
  _iframeWindow?: PdfWindowLike;
};

type PdfWindowLike = Window & {
  PDFViewerApplication?: PdfViewerApplicationLike;
};

type PdfViewerApplicationLike = {
  initializedPromise?: Promise<void>;
  eventBus?: PdfEventBusLike;
  pdfViewer?: {
    getPageView?: (index: number) => PdfPageViewLike | undefined;
  };
};

type PdfEventBusLike = {
  on?: (eventName: string, listener: EventListenerOrEventListenerObject) => void;
  off?: (
    eventName: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  _on?: (
    eventName: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  _off?: (
    eventName: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
};

type PdfPageViewLike = {
  pdfPage?: {
    view?: number[];
  };
};

type MineruLayout = {
  pages: Map<number, MineruPageLayout>;
};

type MineruPageLayout = {
  pageIndex: number;
  pageSize?: [number, number];
  boxes: MineruBox[];
};

type MineruBox = {
  bbox: [number, number, number, number];
  label?: string;
};

type ReaderOverlayState = {
  layout: MineruLayout;
  cleanupCallbacks: Array<() => void>;
  renderTimer: ReturnType<typeof globalThis.setTimeout> | null;
};

let paneRegistrationKey: string | null = null;
const readerOverlayStates = new Map<string, ReaderOverlayState>();

export function registerMineruReaderTools() {
  if (paneRegistrationKey) return;

  const key = Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: config.addonID,
    sidenav: {
      icon: ICON_URI,
      l10nID: "show-markdown-mineru-tools",
    },
    header: {
      icon: ICON_URI,
      l10nID: "show-markdown-mineru-tools",
    },
    onRender: renderSection,
    onItemChange: updateSectionAvailability,
    onAsyncRender: async (props) => {
      updateSectionAvailability(props);
    },
    onInit: updateSectionAvailability,
  });

  if (key) {
    paneRegistrationKey = key;
  }
}

export function unregisterMineruReaderTools() {
  for (const reader of getAllPdfReaders()) {
    disableBoundingBoxes(reader);
  }

  if (!paneRegistrationKey) return;
  Zotero.ItemPaneManager.unregisterSection(paneRegistrationKey);
  paneRegistrationKey = null;
}

function renderSection(props: SectionProps) {
  updateSectionAvailability(props);
  injectPaneStyles(props.doc);

  const { doc, body, item } = props;
  body.replaceChildren();

  const container = doc.createElement("div");
  container.className = "show-markdown-mineru-menu";

  const toggleButton = doc.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "show-markdown-mineru-button";
  toggleButton.textContent = "Toggle";

  const translateButton = doc.createElement("button");
  translateButton.type = "button";
  translateButton.className = "show-markdown-mineru-button";
  translateButton.textContent = "Translate";
  translateButton.disabled = true;

  const status = doc.createElement("div");
  status.className = "show-markdown-mineru-status";

  const refreshButtonState = () => {
    const reader = findOpenPdfReaderForItem(item);
    const isVisible = reader ? isBoundingBoxesEnabled(reader) : false;
    toggleButton.classList.toggle("is-active", isVisible);
    status.textContent = isVisible ? "Bounding boxes visible" : "";
  };

  toggleButton.addEventListener("click", async () => {
    toggleButton.disabled = true;
    status.textContent = "Loading layout...";
    try {
      const result = await toggleBoundingBoxes(item);
      status.textContent = result.message;
    } finally {
      toggleButton.disabled = false;
      refreshButtonState();
    }
  });

  container.append(toggleButton, translateButton, status);
  body.append(container);
  refreshButtonState();
}

function updateSectionAvailability(props: SectionProps) {
  props.setEnabled(true);
}

async function toggleBoundingBoxes(
  item: Zotero.Item,
): Promise<{ message: string }> {
  const readerFromItem = findOpenPdfReaderForItem(item);
  const reader = readerFromItem || getActivePdfReader();
  const pdfAttachment = resolvePdfAttachment(item, reader);
  if (!pdfAttachment) return { message: "Open a PDF reader first." };

  const targetReader = reader || findOpenPdfReaderForItem(pdfAttachment);
  if (!targetReader) return { message: "Open this PDF in Zotero reader first." };

  if (isBoundingBoxesEnabled(targetReader)) {
    disableBoundingBoxes(targetReader);
    return { message: "Bounding boxes hidden" };
  }

  const parentTitle = getParentItemTitle(pdfAttachment);
  const layoutPath = await findCachedMineruLayoutPath(
    pdfAttachment.id,
    parentTitle,
  );
  if (!layoutPath) {
    return { message: "layout.json not found in the MinerU result folder." };
  }

  const layoutText = await readCachedTextFile(layoutPath);
  if (!layoutText) {
    return { message: "Cannot read layout.json." };
  }

  let rawLayout: unknown;
  try {
    rawLayout = JSON.parse(layoutText);
  } catch (err) {
    ztoolkit.log("Show Markdown: failed to parse MinerU layout.json", err);
    return { message: "layout.json is not valid JSON." };
  }

  const layout = parseMineruLayout(rawLayout);
  if (!getLayoutBoxCount(layout)) {
    return { message: "No bounding boxes found in layout.json." };
  }

  await enableBoundingBoxes(targetReader, layout);
  return { message: "Bounding boxes visible" };
}

async function enableBoundingBoxes(
  reader: PrivatePdfReader,
  layout: MineruLayout,
) {
  disableBoundingBoxes(reader);

  await reader._initPromise;
  const views = getReaderPdfViews(reader);
  await Promise.all(
    views.map(async (view) => {
      await view.initializedPromise;
      await view._iframeWindow?.PDFViewerApplication?.initializedPromise;
    }),
  );

  const state: ReaderOverlayState = {
    layout,
    cleanupCallbacks: [],
    renderTimer: null,
  };
  readerOverlayStates.set(getReaderKey(reader), state);

  for (const view of views) {
    const pdfWindow = view._iframeWindow;
    if (!pdfWindow) continue;
    attachRenderListeners(pdfWindow, state);
  }

  scheduleRender(reader, state);
}

function disableBoundingBoxes(reader: PrivatePdfReader) {
  const key = getReaderKey(reader);
  const state = readerOverlayStates.get(key);
  if (state?.renderTimer) {
    globalThis.clearTimeout(state.renderTimer);
  }
  for (const cleanup of state?.cleanupCallbacks || []) {
    cleanup();
  }

  for (const view of getReaderPdfViews(reader)) {
    const pdfDocument = view._iframeWindow?.document;
    if (pdfDocument) removeBoundingBoxLayers(pdfDocument);
  }

  readerOverlayStates.delete(key);
}

function attachRenderListeners(
  pdfWindow: PdfWindowLike,
  state: ReaderOverlayState,
) {
  const render = () => {
    renderBoundingBoxesInWindow(pdfWindow, state.layout);
  };
  const schedule = () => {
    if (state.renderTimer) {
      globalThis.clearTimeout(state.renderTimer);
    }
    state.renderTimer = globalThis.setTimeout(render, 40);
  };

  const eventBus = pdfWindow.PDFViewerApplication?.eventBus;
  for (const eventName of [
    "pagerendered",
    "pagesinit",
    "scalechanging",
    "rotationchanging",
    "updateviewarea",
  ]) {
    if (eventBus?.on) {
      eventBus.on(eventName, schedule);
      state.cleanupCallbacks.push(() => eventBus.off?.(eventName, schedule));
    } else if (eventBus?._on) {
      eventBus._on(eventName, schedule);
      state.cleanupCallbacks.push(() =>
        eventBus._off?.(eventName, schedule),
      );
    }
  }

  const viewerContainer = pdfWindow.document.getElementById("viewerContainer");
  pdfWindow.addEventListener("resize", schedule);
  state.cleanupCallbacks.push(() =>
    pdfWindow.removeEventListener("resize", schedule),
  );

  if (viewerContainer) {
    viewerContainer.addEventListener("scroll", schedule, true);
    state.cleanupCallbacks.push(() =>
      viewerContainer.removeEventListener("scroll", schedule, true),
    );
  }

  render();
}

function scheduleRender(reader: PrivatePdfReader, state: ReaderOverlayState) {
  if (state.renderTimer) globalThis.clearTimeout(state.renderTimer);
  state.renderTimer = globalThis.setTimeout(() => {
    for (const view of getReaderPdfViews(reader)) {
      const pdfWindow = view._iframeWindow;
      if (pdfWindow) renderBoundingBoxesInWindow(pdfWindow, state.layout);
    }
  }, 0);
}

function renderBoundingBoxesInWindow(
  pdfWindow: PdfWindowLike,
  layout: MineruLayout,
) {
  const pdfDocument = pdfWindow.document;
  injectPdfStyles(pdfDocument);

  const pageNodes = Array.from(
    pdfDocument.querySelectorAll(".page[data-page-number]"),
  ) as HTMLElement[];

  for (const pageNode of pageNodes) {
    const pageIndex = Number(pageNode.dataset.pageNumber || 0) - 1;
    const pageLayout = layout.pages.get(pageIndex);
    pageNode
      .querySelectorAll(`.${BBOX_LAYER_CLASS}`)
      .forEach((node: Element) => {
        node.remove();
      });

    if (!pageLayout?.boxes.length) continue;

    const pageWidth = pageNode.clientWidth || parseCssPixels(pageNode, "width");
    const pageHeight =
      pageNode.clientHeight || parseCssPixels(pageNode, "height");
    if (!pageWidth || !pageHeight) continue;

    const sourceSize = resolveSourcePageSize(
      pageLayout,
      pdfWindow.PDFViewerApplication,
      pageWidth,
      pageHeight,
    );
    if (!sourceSize) continue;

    if (pdfWindow.getComputedStyle(pageNode)?.position === "static") {
      pageNode.style.position = "relative";
    }

    const layer = pdfDocument.createElement("div");
    layer.className = BBOX_LAYER_CLASS;

    for (const box of pageLayout.boxes) {
      const rectangle = createBoundingBoxNode(
        pdfDocument,
        box,
        sourceSize,
        pageWidth,
        pageHeight,
      );
      if (rectangle) layer.append(rectangle);
    }

    pageNode.append(layer);
  }
}

function createBoundingBoxNode(
  doc: Document,
  box: MineruBox,
  sourceSize: [number, number],
  pageWidth: number,
  pageHeight: number,
) {
  const [sourceWidth, sourceHeight] = sourceSize;
  if (!sourceWidth || !sourceHeight) return null;

  const [x0, y0, x1, y1] = box.bbox;
  const left = (Math.min(x0, x1) / sourceWidth) * pageWidth;
  const top = (Math.min(y0, y1) / sourceHeight) * pageHeight;
  const width = (Math.abs(x1 - x0) / sourceWidth) * pageWidth;
  const height = (Math.abs(y1 - y0) / sourceHeight) * pageHeight;

  if (width <= 0 || height <= 0) return null;

  const rectangle = doc.createElement("div");
  rectangle.className = BBOX_CLASS;
  rectangle.style.left = `${left}px`;
  rectangle.style.top = `${top}px`;
  rectangle.style.width = `${width}px`;
  rectangle.style.height = `${height}px`;
  if (box.label) rectangle.title = box.label;
  return rectangle;
}

function removeBoundingBoxLayers(doc: Document) {
  doc.querySelectorAll(`.${BBOX_LAYER_CLASS}`).forEach((node: Element) => {
    node.remove();
  });
}

function resolveSourcePageSize(
  pageLayout: MineruPageLayout,
  app: PdfViewerApplicationLike | undefined,
  pageWidth: number,
  pageHeight: number,
): [number, number] | null {
  const maxBboxSize = getMaxBboxSize(pageLayout);
  if (!maxBboxSize) return null;

  if (maxBboxSize[0] <= 1 && maxBboxSize[1] <= 1) {
    return [1, 1];
  }

  if (pageLayout.pageSize) return pageLayout.pageSize;

  const pdfPageSize = getPdfPageSize(app, pageLayout.pageIndex);
  if (
    pdfPageSize &&
    maxBboxSize[0] <= 1000 &&
    maxBboxSize[1] <= 1000 &&
    (maxBboxSize[0] > pdfPageSize[0] * 1.1 ||
      maxBboxSize[1] > pdfPageSize[1] * 1.1)
  ) {
    return [1000, 1000];
  }

  return pdfPageSize || [pageWidth, pageHeight];
}

function getPdfPageSize(
  app: PdfViewerApplicationLike | undefined,
  pageIndex: number,
): [number, number] | null {
  const view = app?.pdfViewer?.getPageView?.(pageIndex)?.pdfPage?.view;
  if (!view || view.length < 4) return null;

  const width = Math.abs(Number(view[2]) - Number(view[0]));
  const height = Math.abs(Number(view[3]) - Number(view[1]));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return [width, height];
}

function getMaxBboxSize(pageLayout: MineruPageLayout): [number, number] | null {
  let maxX = 0;
  let maxY = 0;
  for (const box of pageLayout.boxes) {
    maxX = Math.max(maxX, box.bbox[0], box.bbox[2]);
    maxY = Math.max(maxY, box.bbox[1], box.bbox[3]);
  }

  if (!maxX || !maxY) return null;
  return [maxX, maxY];
}

function parseMineruLayout(rawLayout: unknown): MineruLayout {
  const pages = new Map<number, MineruPageLayout>();
  const seenBoxes = new Set<string>();

  if (isPlainObject(rawLayout) && Array.isArray(rawLayout.pdf_info)) {
    rawLayout.pdf_info.forEach((page, index) => {
      if (!isPlainObject(page)) return;
      const pageIndex = readPageIndex(page) ?? index;
      const pageSize = readPageSize(page);
      ensurePageLayout(pages, pageIndex, pageSize);

      if (Array.isArray(page.layout_bboxes) && page.layout_bboxes.length) {
        collectBlocks(page.layout_bboxes, pageIndex, pageSize, pages, seenBoxes);
        return;
      }

      const candidateKeys = [
        "layouts",
        "layout",
        "layout_dets",
        "detections",
        "blocks",
        "para_blocks",
      ];
      for (const key of candidateKeys) {
        const value = page[key];
        if (Array.isArray(value) && value.length) {
          collectBlocks(value, pageIndex, pageSize, pages, seenBoxes);
          return;
        }
      }

      if (Array.isArray(page.preproc_blocks)) {
        collectBlocks(page.preproc_blocks, pageIndex, pageSize, pages, seenBoxes);
      }
    });
  } else if (Array.isArray(rawLayout)) {
    parseArrayLayout(rawLayout, pages, seenBoxes);
  } else if (isPlainObject(rawLayout)) {
    const pageArrays = [
      "pages",
      "layouts",
      "layout",
      "layout_bboxes",
      "layout_dets",
      "detections",
      "blocks",
    ];
    for (const key of pageArrays) {
      if (Array.isArray(rawLayout[key])) {
        parseArrayLayout(rawLayout[key], pages, seenBoxes);
        break;
      }
    }
  }

  return { pages };
}

function parseArrayLayout(
  value: unknown[],
  pages: Map<number, MineruPageLayout>,
  seenBoxes: Set<string>,
) {
  if (value.every(Array.isArray)) {
    value.forEach((pageBlocks, pageIndex) => {
      collectBlocks(pageBlocks, pageIndex, undefined, pages, seenBoxes);
    });
    return;
  }

  collectBlocks(value, 0, undefined, pages, seenBoxes);
}

function collectBlocks(
  blocks: unknown,
  fallbackPageIndex: number,
  fallbackPageSize: [number, number] | undefined,
  pages: Map<number, MineruPageLayout>,
  seenBoxes: Set<string>,
) {
  if (!Array.isArray(blocks)) return;

  for (const block of blocks) {
    if (!isPlainObject(block)) continue;
    const pageIndex = readPageIndex(block) ?? fallbackPageIndex;
    const pageSize = readPageSize(block) || fallbackPageSize;
    const bbox = readBBox(block);
    if (bbox) {
      const key = `${pageIndex}:${bbox.join(",")}`;
      if (!seenBoxes.has(key)) {
        seenBoxes.add(key);
        ensurePageLayout(pages, pageIndex, pageSize).boxes.push({
          bbox,
          label: readBoxLabel(block),
        });
      }
    } else {
      ensurePageLayout(pages, pageIndex, pageSize);
    }

    for (const childKey of [
      "sub_layout",
      "children",
      "layouts",
      "layout",
      "layout_bboxes",
      "layout_dets",
      "detections",
      "blocks",
    ]) {
      collectBlocks(block[childKey], pageIndex, pageSize, pages, seenBoxes);
    }
  }
}

function ensurePageLayout(
  pages: Map<number, MineruPageLayout>,
  pageIndex: number,
  pageSize: [number, number] | undefined,
): MineruPageLayout {
  const existing = pages.get(pageIndex);
  if (existing) {
    if (!existing.pageSize && pageSize) existing.pageSize = pageSize;
    return existing;
  }

  const pageLayout = {
    pageIndex,
    pageSize,
    boxes: [],
  };
  pages.set(pageIndex, pageLayout);
  return pageLayout;
}

function readBBox(value: Record<string, unknown>) {
  return (
    normalizeBBox(value.layout_bbox) ||
    normalizeBBox(value.bbox) ||
    normalizeBBox(value.poly)
  );
}

function normalizeBBox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value)) return null;

  const numbers = value.map((entry) => Number(entry));
  if (numbers.length === 4 && numbers.every(Number.isFinite)) {
    return [numbers[0], numbers[1], numbers[2], numbers[3]];
  }

  if (numbers.length >= 8 && numbers.every(Number.isFinite)) {
    const xs = numbers.filter((_, index) => index % 2 === 0);
    const ys = numbers.filter((_, index) => index % 2 === 1);
    return [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ];
  }

  return null;
}

function readPageIndex(value: Record<string, unknown>): number | null {
  for (const key of ["page_idx", "pageIndex", "page_index"]) {
    const pageIndex = Number(value[key]);
    if (Number.isInteger(pageIndex) && pageIndex >= 0) return pageIndex;
  }

  for (const key of ["page_num", "pageNumber", "page_number", "page"]) {
    const pageNumber = Number(value[key]);
    if (Number.isInteger(pageNumber) && pageNumber > 0) return pageNumber - 1;
  }

  return null;
}

function readPageSize(
  value: Record<string, unknown>,
): [number, number] | undefined {
  const pageSize = value.page_size;
  if (Array.isArray(pageSize) && pageSize.length >= 2) {
    const width = Number(pageSize[0]);
    const height = Number(pageSize[1]);
    if (isPositiveFinite(width) && isPositiveFinite(height)) {
      return [width, height];
    }
  }

  const width =
    readNumber(value.width) ||
    readNumber(value.page_width) ||
    readNumber(value.pdf_width);
  const height =
    readNumber(value.height) ||
    readNumber(value.page_height) ||
    readNumber(value.pdf_height);

  return width && height ? [width, height] : undefined;
}

function readNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return isPositiveFinite(numberValue) ? numberValue : null;
}

function readBoxLabel(value: Record<string, unknown>): string | undefined {
  for (const key of ["type", "label", "layout_label", "category"]) {
    const label = value[key];
    if (typeof label === "string" && label.trim()) return label.trim();
  }
  return undefined;
}

function getLayoutBoxCount(layout: MineruLayout): number {
  let count = 0;
  for (const page of layout.pages.values()) {
    count += page.boxes.length;
  }
  return count;
}

function isBoundingBoxesEnabled(reader: PrivatePdfReader): boolean {
  return readerOverlayStates.has(getReaderKey(reader));
}

function getAllPdfReaders(): PrivatePdfReader[] {
  const readers = Zotero.Reader?._readers || [];
  return readers.filter((reader) => reader.type === "pdf") as PrivatePdfReader[];
}

function findOpenPdfReaderForItem(
  item: Zotero.Item | null | undefined,
): PrivatePdfReader | null {
  if (!item) return null;
  return (
    getAllPdfReaders().find((reader) => {
      const readerItemId = Number(reader.itemID || reader._item?.id);
      if (readerItemId === item.id) return true;
      const readerItem = reader._item || Zotero.Items.get(readerItemId);
      return Number(readerItem?.parentID || 0) === item.id;
    }) || null
  );
}

function getActivePdfReader(): PrivatePdfReader | null {
  const tabs = (globalThis as {
    Zotero_Tabs?: { selectedID?: string; selectedType?: string };
  }).Zotero_Tabs;
  if (tabs?.selectedType === "reader" && tabs.selectedID) {
    const reader = Zotero.Reader.getByTabID(tabs.selectedID);
    if (reader?.type === "pdf") return reader as PrivatePdfReader;
  }

  return getAllPdfReaders()[0] || null;
}

function resolvePdfAttachment(
  item: Zotero.Item | null | undefined,
  reader: PrivatePdfReader | null,
): Zotero.Item | null {
  if (isPdfAttachment(item)) return item;

  const readerItemId = Number(reader?.itemID || reader?._item?.id || 0);
  const readerItem =
    reader?._item || (readerItemId ? Zotero.Items.get(readerItemId) : null);
  if (isPdfAttachment(readerItem)) return readerItem;

  const regularItem = item as unknown as Zotero.Item | null | undefined;
  if (regularItem?.isRegularItem?.()) {
    const attachmentIds = regularItem.getAttachments?.() || [];
    for (const attachmentId of attachmentIds) {
      const attachment = Zotero.Items.get(attachmentId);
      if (isPdfAttachment(attachment)) return attachment;
    }
  }

  return null;
}

function getReaderPdfViews(reader: PrivatePdfReader): PdfViewLike[] {
  const views = [
    reader._primaryView,
    reader._secondaryView,
    reader._lastView,
    reader._internalReader?._primaryView,
    reader._internalReader?._secondaryView,
    reader._internalReader?._lastView,
  ].filter(Boolean) as PdfViewLike[];

  return Array.from(new Set(views));
}

function getReaderKey(reader: PrivatePdfReader): string {
  return reader._instanceID || reader.tabID || String(reader.itemID);
}

function getParentItemTitle(item: Zotero.Item): string {
  const parentId = Number(item.parentID || 0);
  const parentItem = parentId ? Zotero.Items.get(parentId) : null;
  return String(
    parentItem?.getField?.("title") || item.getField?.("title") || "Untitled",
  );
}

function isPdfAttachment(
  item: Zotero.Item | null | undefined,
): item is Zotero.Item {
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

function injectPaneStyles(doc: Document) {
  if (doc.getElementById(PANE_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = PANE_STYLE_ID;
  style.textContent = `
    .show-markdown-mineru-menu {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px 0;
    }

    .show-markdown-mineru-button {
      appearance: none;
      border: 1px solid var(--fill-quinary, rgba(127, 127, 127, 0.35));
      border-radius: 6px;
      background: var(--material-background, transparent);
      color: inherit;
      cursor: pointer;
      font: inherit;
      min-height: 28px;
      padding: 4px 10px;
      text-align: left;
    }

    .show-markdown-mineru-button:hover:not(:disabled),
    .show-markdown-mineru-button.is-active {
      background: var(--fill-quaternary, rgba(127, 127, 127, 0.16));
    }

    .show-markdown-mineru-button:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .show-markdown-mineru-status {
      color: var(--fill-secondary, currentColor);
      font-size: 0.92em;
      min-height: 1.2em;
    }
  `;
  appendStyle(doc, style);
}

function injectPdfStyles(doc: Document) {
  if (doc.getElementById(PDF_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = PDF_STYLE_ID;
  style.textContent = `
    .${BBOX_LAYER_CLASS} {
      inset: 0;
      pointer-events: none;
      position: absolute;
      z-index: 30;
    }

    .${BBOX_CLASS} {
      background: rgba(255, 193, 7, 0.08);
      border: 1.5px solid rgba(255, 193, 7, 0.95);
      border-radius: 2px;
      box-sizing: border-box;
      position: absolute;
    }
  `;
  appendStyle(doc, style);
}

function parseCssPixels(element: HTMLElement, property: "width" | "height") {
  const view = element.ownerDocument?.defaultView;
  const value = Number.parseFloat(
    view?.getComputedStyle(element)?.[property] || "",
  );
  return Number.isFinite(value) ? value : 0;
}

function appendStyle(doc: Document, style: HTMLStyleElement) {
  (doc.head || doc.documentElement || doc.body)?.append(style);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
