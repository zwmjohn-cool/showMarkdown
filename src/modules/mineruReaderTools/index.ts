import katex from "katex";
import { config } from "../../../package.json";
import {
  findCachedMineruLayoutPath,
  readCachedTextFile,
  writeCachedTextFile,
} from "../mineruMarkdownPanel/cache";

const PANE_ID = "show-markdown-mineru-tools";
const BBOX_LAYER_CLASS = "show-markdown-bbox-layer";
const BBOX_CLASS = "show-markdown-bbox";
const BBOX_SCROLL_CLASS = "show-markdown-bbox-scroll";
const BBOX_TEXT_CLASS = "show-markdown-bbox-text";
const BBOX_MATH_CLASS = "show-markdown-bbox-math";
const PANE_STYLE_ID = "show-markdown-mineru-tools-style";
const PANE_STYLE_VERSION = "2026-05-19-page-tabs-v1";
const PDF_STYLE_ID = "show-markdown-bbox-style";
const PDF_STYLE_VERSION = "2026-05-19-hover-scroll-v3";
const ICON_URI = `chrome://${config.addonRef}/content/icons/icon-20.png`;
const DEFAULT_TRANSLATION_BASE_URL = "http://127.0.0.1:1234";
const DEFAULT_TRANSLATION_MODEL = "qwen/qwen3.6-27b";
const DEFAULT_TRANSLATION_CONCURRENCY = "1";
const DEFAULT_TRANSLATION_PROMPT =
  "You are a professional academic translator. Translate the user's text into Simplified Chinese. Keep names, citations, math, LaTeX, code, and numbers unchanged where appropriate. Return only the translated text. Do not return JSON. Do not use markdown. Do not include reasoning. just output plain text, 公式应该由$$包裹。";
const DEFAULT_BATCH_TRANSLATION_PROMPT =
  "You are a professional academic translator. Translate the user's JSON array of text snippets into Simplified Chinese. Keep names, citations, math, LaTeX, code, and numbers unchanged where appropriate. Return only a valid JSON array of translated strings with the same length and order. Escape backslashes correctly for JSON. Do not use markdown. Do not include reasoning.";
const DEFAULT_TRANSLATION_STRIP_STRINGS = "<text>,</text>";
const DEFAULT_TRANSLATION_CLEAR_PAGES = "all";
const MAX_TRANSLATION_CONCURRENCY = 8;
const TRANSLATION_BATCH_SIZE = 1;
const TRANSLATION_CACHE_FILE_NAME = "show-markdown-translations.json";
const DEFAULT_TRANSLATED_BOX_COLOR = "#ffffff";
const DEFAULT_TRANSLATED_BOX_BORDER_COLOR = "#f4d35e";
const DEFAULT_UNTRANSLATED_BOX_COLOR = "#ffc107";
const DEFAULT_TRANSLATION_TEXT_COLOR = "#000000";
const DEFAULT_TRANSLATION_FONT_SIZE = "9";
const PREF_TRANSLATION_BASE_URL = `${config.prefsPrefix}.translate.baseURL`;
const PREF_TRANSLATION_MODEL = `${config.prefsPrefix}.translate.model`;
const PREF_TRANSLATION_PAGES = `${config.prefsPrefix}.translate.pages`;
const PREF_TRANSLATION_SKIP_PAGES = `${config.prefsPrefix}.translate.skipPages`;
const PREF_TRANSLATION_CONCURRENCY = `${config.prefsPrefix}.translate.concurrency`;
const PREF_TRANSLATION_PROMPT = `${config.prefsPrefix}.translate.prompt`;
const PREF_TRANSLATION_STRIP_STRINGS = `${config.prefsPrefix}.translate.stripStrings`;
const PREF_TRANSLATION_CLEAR_PAGES = `${config.prefsPrefix}.translate.clearPages`;
const PREF_TRANSLATED_BOX_COLOR = `${config.prefsPrefix}.display.translatedBoxColor`;
const PREF_TRANSLATED_BOX_BORDER_COLOR = `${config.prefsPrefix}.display.translatedBoxBorderColor`;
const PREF_UNTRANSLATED_BOX_COLOR = `${config.prefsPrefix}.display.untranslatedBoxColor`;
const PREF_TRANSLATION_TEXT_COLOR = `${config.prefsPrefix}.display.textColor`;
const PREF_TRANSLATION_FONT_SIZE = `${config.prefsPrefix}.display.fontSize`;

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
  translationCachePath?: string;
};

type MineruPageLayout = {
  pageIndex: number;
  pageSize?: [number, number];
  boxes: MineruBox[];
};

type MineruBox = {
  pageIndex: number;
  bbox: [number, number, number, number];
  label?: string;
  text?: string;
  translation?: string;
};

type MathTextSegment =
  | { type: "text"; value: string }
  | { displayMode: boolean; type: "math"; value: string };

type TranslationCacheEntry = {
  bbox?: [number, number, number, number];
  label?: string;
  pageIndex?: number;
  text?: string;
  translation?: string;
  updatedAt?: string;
};

type TranslationAbortSignal = {
  aborted: boolean;
};

type TranslationAbortController = {
  signal: TranslationAbortSignal;
  abort: () => void;
};

type AbortControllerConstructor = new () => AbortController;

type ReaderOverlayState = {
  displayConfig: DisplayConfig;
  layout: MineruLayout;
  cleanupCallbacks: Array<() => void>;
  renderTimer: ReturnType<typeof globalThis.setTimeout> | null;
  translationAbortController?: TranslationAbortController;
  translationRunId?: number;
  showOcrText: boolean;
  visible: boolean;
};

type TranslationConfig = {
  baseURL: string;
  model: string;
  pages: string;
  skipPages: string;
  concurrency: string;
  clearPages: string;
  prompt: string;
  stripStrings: string;
};

type DisplayConfig = {
  translatedBoxColor: string;
  translatedBoxBorderColor: string;
  untranslatedBoxColor: string;
  textColor: string;
  fontSize: string;
};

let paneRegistrationKey: string | null = null;
let translationRunCounter = 0;
const readerOverlayStates = new Map<string, ReaderOverlayState>();
const guardedSelectionDocuments = new WeakSet<Document>();

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
  const translationConfig = getTranslationConfig();
  const displayConfig = getDisplayConfig();

  const toggleButton = doc.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "show-markdown-mineru-button is-secondary";
  toggleButton.textContent = "Show Bounding Boxes";

  const ocrTextButton = doc.createElement("button");
  ocrTextButton.type = "button";
  ocrTextButton.className = "show-markdown-mineru-button is-secondary";
  ocrTextButton.textContent = "Show OCR Text";

  const baseURLControl = createLabeledInput(
    doc,
    "URL",
    translationConfig.baseURL,
    DEFAULT_TRANSLATION_BASE_URL,
  );
  const modelControl = createLabeledInput(
    doc,
    "Model",
    translationConfig.model,
    DEFAULT_TRANSLATION_MODEL,
  );
  const pagesControl = createLabeledInput(
    doc,
    "Pages",
    translationConfig.pages,
    "1-3,5",
  );
  const skipPagesControl = createLabeledInput(
    doc,
    "Skip",
    translationConfig.skipPages,
    "2,4-6",
  );
  const concurrencyControl = createLabeledInput(
    doc,
    "Parallel",
    translationConfig.concurrency,
    DEFAULT_TRANSLATION_CONCURRENCY,
  );
  concurrencyControl.input.type = "number";
  concurrencyControl.input.min = "1";
  concurrencyControl.input.max = String(MAX_TRANSLATION_CONCURRENCY);
  concurrencyControl.input.step = "1";
  const clearPagesControl = createLabeledInput(
    doc,
    "Clear Pages",
    translationConfig.clearPages,
    DEFAULT_TRANSLATION_CLEAR_PAGES,
  );
  const promptControl = createLabeledTextarea(
    doc,
    "Prompt",
    translationConfig.prompt,
    DEFAULT_TRANSLATION_PROMPT,
  );
  const stripStringsControl = createLabeledInput(
    doc,
    "要去掉的字符串",
    translationConfig.stripStrings,
    DEFAULT_TRANSLATION_STRIP_STRINGS,
  );
  const translatedBoxColorControl = createLabeledInput(
    doc,
    "Text Box",
    displayConfig.translatedBoxColor,
    DEFAULT_TRANSLATED_BOX_COLOR,
  );
  translatedBoxColorControl.input.type = "color";
  const translatedBoxBorderColorControl = createLabeledInput(
    doc,
    "Text Border",
    displayConfig.translatedBoxBorderColor,
    DEFAULT_TRANSLATED_BOX_BORDER_COLOR,
  );
  translatedBoxBorderColorControl.input.type = "color";
  const untranslatedBoxColorControl = createLabeledInput(
    doc,
    "Empty Box",
    displayConfig.untranslatedBoxColor,
    DEFAULT_UNTRANSLATED_BOX_COLOR,
  );
  untranslatedBoxColorControl.input.type = "color";
  const textColorControl = createLabeledInput(
    doc,
    "Font Color",
    displayConfig.textColor,
    DEFAULT_TRANSLATION_TEXT_COLOR,
  );
  textColorControl.input.type = "color";
  const fontSizeControl = createLabeledInput(
    doc,
    "Font Size",
    displayConfig.fontSize,
    DEFAULT_TRANSLATION_FONT_SIZE,
  );
  fontSizeControl.input.type = "number";
  fontSizeControl.input.min = "6";
  fontSizeControl.input.max = "32";
  fontSizeControl.input.step = "1";

  const translateButton = doc.createElement("button");
  translateButton.type = "button";
  translateButton.className = "show-markdown-mineru-button is-primary";
  translateButton.textContent = "Translate";

  const clearButton = doc.createElement("button");
  clearButton.type = "button";
  clearButton.className = "show-markdown-mineru-button is-danger";
  clearButton.textContent = "Clear Translations";

  const status = doc.createElement("div");
  status.className = "show-markdown-mineru-status";
  let activeTranslationStatus = "";
  let isStartingTranslation = false;

  const refreshButtonState = (syncStatus = false) => {
    const reader = findOpenPdfReaderForItem(item);
    const state = reader ? readerOverlayStates.get(getReaderKey(reader)) : null;
    const isVisible = Boolean(state?.visible);
    const isTranslating = Boolean(state?.translationAbortController);
    const showOcrText = Boolean(state?.showOcrText);
    toggleButton.classList.toggle("is-active", isVisible);
    toggleButton.textContent = isVisible
      ? "Hide Bounding Boxes"
      : "Show Bounding Boxes";
    ocrTextButton.classList.toggle("is-active", showOcrText);
    ocrTextButton.textContent = showOcrText ? "Hide OCR Text" : "Show OCR Text";
    translateButton.classList.toggle("is-danger", isTranslating);
    translateButton.classList.toggle("is-primary", !isTranslating);
    translateButton.disabled = isStartingTranslation && !isTranslating;
    translateButton.textContent = isTranslating
      ? "Stop Translation"
      : isStartingTranslation
        ? "Starting..."
        : "Translate";
    clearButton.disabled = isTranslating || isStartingTranslation;
    if (isTranslating && activeTranslationStatus) {
      status.textContent = activeTranslationStatus;
      return;
    }
    if (syncStatus) {
      status.textContent = isVisible
        ? "Bounding boxes visible"
        : state
          ? "Bounding boxes hidden"
          : "";
    }
  };

  const readDisplayConfig = (): DisplayConfig => ({
    translatedBoxColor: translatedBoxColorControl.input.value,
    translatedBoxBorderColor: translatedBoxBorderColorControl.input.value,
    untranslatedBoxColor: untranslatedBoxColorControl.input.value,
    textColor: textColorControl.input.value,
    fontSize: fontSizeControl.input.value,
  });

  const applyDisplayConfig = (syncInputs = true) => {
    const config = saveDisplayConfig(readDisplayConfig());
    if (syncInputs) {
      translatedBoxColorControl.input.value = config.translatedBoxColor;
      translatedBoxBorderColorControl.input.value =
        config.translatedBoxBorderColor;
      untranslatedBoxColorControl.input.value = config.untranslatedBoxColor;
      textColorControl.input.value = config.textColor;
      fontSizeControl.input.value = config.fontSize;
    }
    updateActiveDisplayConfig(item, config);
  };

  toggleButton.addEventListener("click", async () => {
    toggleButton.disabled = true;
    status.textContent = "Loading layout...";
    try {
      const result = await toggleBoundingBoxes(item);
      status.textContent = result.message;
    } finally {
      toggleButton.disabled = false;
      refreshButtonState(true);
    }
  });

  ocrTextButton.addEventListener("click", async () => {
    ocrTextButton.disabled = true;
    status.textContent = "Loading layout...";
    try {
      const result = await toggleOcrText(item);
      status.textContent = result.message;
    } finally {
      ocrTextButton.disabled = false;
      refreshButtonState(true);
    }
  });

  translateButton.addEventListener("click", async () => {
    const reader = findOpenPdfReaderForItem(item) || getActivePdfReader();
    const state = reader ? readerOverlayStates.get(getReaderKey(reader)) : null;
    if (state?.translationAbortController) {
      const result = stopTranslation(item);
      activeTranslationStatus = "";
      isStartingTranslation = false;
      status.textContent = result.message;
      refreshButtonState();
      return;
    }
    if (isStartingTranslation) return;

    const config: TranslationConfig = {
      baseURL: baseURLControl.input.value,
      model: modelControl.input.value,
      pages: pagesControl.input.value,
      skipPages: skipPagesControl.input.value,
      concurrency: concurrencyControl.input.value,
      clearPages: clearPagesControl.input.value,
      prompt: promptControl.textarea.value,
      stripStrings: stripStringsControl.input.value,
    };
    saveTranslationConfig(config);
    applyDisplayConfig();

    isStartingTranslation = true;
    status.textContent = "Preparing translation...";
    refreshButtonState();
    try {
      const result = await translateBoundingBoxes(item, config, (message) => {
        isStartingTranslation = false;
        activeTranslationStatus = message;
        status.textContent = message;
        refreshButtonState();
      });
      activeTranslationStatus = "";
      status.textContent = result.message;
    } catch (err) {
      activeTranslationStatus = "";
      ztoolkit.log("Show Markdown: translation failed", err);
      status.textContent =
        err instanceof Error ? err.message : "Translation failed.";
    } finally {
      isStartingTranslation = false;
      refreshButtonState();
    }
  });

  clearButton.addEventListener("click", async () => {
    clearButton.disabled = true;
    status.textContent = "Clearing translations...";
    try {
      const result = await clearTranslations(item, clearPagesControl.input.value);
      status.textContent = result.message;
    } catch (err) {
      ztoolkit.log("Show Markdown: failed to clear translations", err);
      status.textContent =
        err instanceof Error ? err.message : "Failed to clear translations.";
    } finally {
      clearButton.disabled = false;
      refreshButtonState();
    }
  });

  promptControl.textarea.addEventListener("change", () => {
    saveTranslationConfig({
      baseURL: baseURLControl.input.value,
      model: modelControl.input.value,
      pages: pagesControl.input.value,
      skipPages: skipPagesControl.input.value,
      concurrency: concurrencyControl.input.value,
      clearPages: clearPagesControl.input.value,
      prompt: promptControl.textarea.value,
      stripStrings: stripStringsControl.input.value,
    });
  });
  stripStringsControl.input.addEventListener("change", () => {
    saveTranslationConfig({
      baseURL: baseURLControl.input.value,
      model: modelControl.input.value,
      pages: pagesControl.input.value,
      skipPages: skipPagesControl.input.value,
      concurrency: concurrencyControl.input.value,
      clearPages: clearPagesControl.input.value,
      prompt: promptControl.textarea.value,
      stripStrings: stripStringsControl.input.value,
    });
  });
  clearPagesControl.input.addEventListener("change", () => {
    saveTranslationConfig({
      baseURL: baseURLControl.input.value,
      model: modelControl.input.value,
      pages: pagesControl.input.value,
      skipPages: skipPagesControl.input.value,
      concurrency: concurrencyControl.input.value,
      clearPages: clearPagesControl.input.value,
      prompt: promptControl.textarea.value,
      stripStrings: stripStringsControl.input.value,
    });
  });

  for (const control of [
    translatedBoxColorControl,
    translatedBoxBorderColorControl,
    untranslatedBoxColorControl,
    textColorControl,
    fontSizeControl,
  ]) {
    control.input.addEventListener("input", () => applyDisplayConfig(false));
    control.input.addEventListener("change", () => applyDisplayConfig(true));
  }

  const actions = doc.createElement("div");
  actions.className = "show-markdown-mineru-actions";
  actions.append(toggleButton, ocrTextButton, translateButton);

  const translationGroup = createConfigGroup(doc, "Translation");
  translationGroup.append(
    baseURLControl.wrapper,
    modelControl.wrapper,
    promptControl.wrapper,
    stripStringsControl.wrapper,
  );

  const pageGroup = createConfigGroup(doc, "Pages");
  const pageTabs = doc.createElement("div");
  pageTabs.className = "show-markdown-mineru-tabs";
  const translatePageTab = createTabButton(doc, "Translate");
  const clearPageTab = createTabButton(doc, "Clear");
  pageTabs.append(translatePageTab, clearPageTab);

  const translatePagesPanel = doc.createElement("div");
  translatePagesPanel.className = "show-markdown-mineru-tab-panel";
  translatePagesPanel.append(
    pagesControl.wrapper,
    skipPagesControl.wrapper,
    concurrencyControl.wrapper,
  );

  const clearPagesPanel = doc.createElement("div");
  clearPagesPanel.className = "show-markdown-mineru-tab-panel";
  clearPagesPanel.hidden = true;
  clearPagesPanel.append(
    clearPagesControl.wrapper,
    clearButton,
  );
  const setPageTab = (tab: "translate" | "clear") => {
    const isTranslate = tab === "translate";
    translatePageTab.classList.toggle("is-active", isTranslate);
    clearPageTab.classList.toggle("is-active", !isTranslate);
    translatePagesPanel.hidden = !isTranslate;
    clearPagesPanel.hidden = isTranslate;
  };
  translatePageTab.addEventListener("click", () => setPageTab("translate"));
  clearPageTab.addEventListener("click", () => setPageTab("clear"));
  setPageTab("translate");
  pageGroup.append(pageTabs, translatePagesPanel, clearPagesPanel);

  const displayGroup = createConfigGroup(doc, "Display");
  displayGroup.append(
    translatedBoxColorControl.wrapper,
    translatedBoxBorderColorControl.wrapper,
    untranslatedBoxColorControl.wrapper,
    textColorControl.wrapper,
    fontSizeControl.wrapper,
  );

  container.append(actions, status, translationGroup, pageGroup, displayGroup);
  body.append(container);
  refreshButtonState(true);
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

  const existingState = readerOverlayStates.get(getReaderKey(targetReader));
  if (existingState) {
    setBoundingBoxesVisible(targetReader, existingState, !existingState.visible);
    return {
      message: existingState.visible
        ? "Bounding boxes visible"
        : "Bounding boxes hidden",
    };
  }

  const layoutResult = await loadMineruLayout(pdfAttachment);
  if (!layoutResult.layout) return { message: layoutResult.message };

  await enableBoundingBoxes(targetReader, layoutResult.layout);
  return { message: "Bounding boxes visible" };
}

async function toggleOcrText(item: Zotero.Item): Promise<{ message: string }> {
  const readerFromItem = findOpenPdfReaderForItem(item);
  const reader = readerFromItem || getActivePdfReader();
  const pdfAttachment = resolvePdfAttachment(item, reader);
  if (!pdfAttachment) return { message: "Open a PDF reader first." };

  const targetReader = reader || findOpenPdfReaderForItem(pdfAttachment);
  if (!targetReader) return { message: "Open this PDF in Zotero reader first." };

  let state = readerOverlayStates.get(getReaderKey(targetReader));
  if (!state) {
    const layoutResult = await loadMineruLayout(pdfAttachment);
    if (!layoutResult.layout) return { message: layoutResult.message };
    state = await enableBoundingBoxes(targetReader, layoutResult.layout);
  }

  state.showOcrText = !state.showOcrText;
  if (state.showOcrText) state.visible = true;
  scheduleRender(targetReader, state);
  return {
    message: state.showOcrText
      ? "OCR text visible in bounding boxes"
      : "OCR text hidden",
  };
}

async function clearTranslations(
  item: Zotero.Item,
  pageSpec: string,
): Promise<{ message: string }> {
  const readerFromItem = findOpenPdfReaderForItem(item);
  const reader = readerFromItem || getActivePdfReader();
  const pdfAttachment = resolvePdfAttachment(item, reader);
  if (!pdfAttachment) return { message: "Open or select a PDF item first." };

  const targetReader = reader || findOpenPdfReaderForItem(pdfAttachment);
  const state = targetReader
    ? readerOverlayStates.get(getReaderKey(targetReader))
    : undefined;
  if (state?.translationAbortController) {
    return { message: "Stop translation before clearing translations." };
  }

  let layout = state?.layout;
  if (!layout) {
    const layoutResult = await loadMineruLayout(pdfAttachment);
    if (!layoutResult.layout) return { message: layoutResult.message };
    layout = layoutResult.layout;
  }

  const pageIndexes = getClearPageIndexes(layout, pageSpec);
  if (!pageIndexes.size) {
    return { message: "No pages selected for clearing." };
  }

  let clearedCount = 0;
  for (const pageIndex of pageIndexes) {
    const page = layout.pages.get(pageIndex);
    if (!page) continue;
    for (const box of page.boxes) {
      if (!normalizeText(box.translation || "")) continue;
      box.translation = "";
      clearedCount += 1;
    }
  }

  await saveTranslationCache(layout);
  if (state && targetReader) scheduleRender(targetReader, state);

  if (!clearedCount) return { message: "No cached translations to clear." };
  return {
    message: `Cleared ${clearedCount} translations from ${formatPageSelection(pageIndexes)}.`,
  };
}

async function translateBoundingBoxes(
  item: Zotero.Item,
  config: TranslationConfig,
  onProgress: (message: string) => void,
): Promise<{ message: string }> {
  const readerFromItem = findOpenPdfReaderForItem(item);
  const reader = readerFromItem || getActivePdfReader();
  const pdfAttachment = resolvePdfAttachment(item, reader);
  if (!pdfAttachment) return { message: "Open a PDF reader first." };

  const targetReader = reader || findOpenPdfReaderForItem(pdfAttachment);
  if (!targetReader) return { message: "Open this PDF in Zotero reader first." };

  let state = readerOverlayStates.get(getReaderKey(targetReader));
  if (!state) {
    const layoutResult = await loadMineruLayout(pdfAttachment);
    if (!layoutResult.layout) return { message: layoutResult.message };
    state = await enableBoundingBoxes(targetReader, layoutResult.layout);
  }

  const selectedPageIndexes = getSelectedPageIndexes(state.layout, config);
  const candidateBoxes = getTranslatableBoxes(state.layout, selectedPageIndexes);
  if (!candidateBoxes.length) {
    return { message: "No translatable text boxes in the selected pages." };
  }
  const boxes = candidateBoxes.filter((box) => !normalizeText(box.translation || ""));
  const cachedCount = candidateBoxes.length - boxes.length;
  if (!boxes.length) {
    scheduleRender(targetReader, state);
    return {
      message: `All ${candidateBoxes.length} selected boxes already translated.`,
    };
  }

  const runId = ++translationRunCounter;
  const abortController = createTranslationAbortController(targetReader);
  state.translationRunId = runId;
  state.translationAbortController = abortController;
  const endpoint = getChatCompletionsEndpoint(config.baseURL);
  const batches = createTranslationBatches(boxes);
  const concurrency = Math.min(
    getTranslationConcurrency(config),
    batches.length,
  );
  let nextBatchIndex = 0;
  let completedCount = 0;
  const progressSuffix = `${concurrency} parallel${
    cachedCount ? `, ${cachedCount} cached` : ""
  }`;
  let savePromise: Promise<unknown> = Promise.resolve();
  const queueSave = () => {
    savePromise = savePromise.then(() => saveTranslationCache(state.layout));
    return savePromise;
  };
  onProgress(`Translating block 0/${boxes.length} (${progressSuffix})...`);

  try {
    const translateWorker = async () => {
      while (true) {
        if (
          state.translationRunId !== runId ||
          abortController.signal.aborted
        ) {
          return;
        }

        const batchIndex = nextBatchIndex;
        nextBatchIndex += 1;
        const batch = batches[batchIndex];
        if (!batch) return;

        const translations = await translateBatchWithFallback(
          endpoint,
          config.model,
          config.prompt,
          config.stripStrings,
          batch.map((box) => box.text || ""),
          abortController.signal,
        );
        if (
          state.translationRunId !== runId ||
          abortController.signal.aborted
        ) {
          return;
        }

        batch.forEach((box, index) => {
          box.translation = translations[index] || "";
        });
        completedCount += batch.length;
        scheduleRender(targetReader, state);
        onProgress(
          `Translating block ${Math.min(completedCount, boxes.length)}/${boxes.length} (${progressSuffix})...`,
        );
        queueSave();
      }
    };

    await Promise.all(
      Array.from({ length: concurrency }, () => translateWorker()),
    );

    if (state.translationRunId !== runId || abortController.signal.aborted) {
      return { message: "Translation stopped." };
    }

    scheduleRender(targetReader, state);
    await savePromise;
    return {
      message: `Translated ${boxes.length} bounding boxes${
        cachedCount ? `; reused ${cachedCount} cached.` : "."
      }`,
    };
  } catch (err) {
    if (abortController.signal.aborted || isAbortError(err)) {
      return { message: "Translation stopped." };
    }
    abortController.abort();
    throw err;
  } finally {
    if (state.translationRunId === runId) {
      state.translationAbortController = undefined;
    }
  }
}

function stopTranslation(item: Zotero.Item): { message: string } {
  const reader = findOpenPdfReaderForItem(item) || getActivePdfReader();
  if (!reader) return { message: "No open PDF reader." };

  const state = readerOverlayStates.get(getReaderKey(reader));
  if (!state?.translationAbortController) {
    return { message: "No active translation." };
  }

  state.translationRunId = ++translationRunCounter;
  state.translationAbortController.abort();
  state.translationAbortController = undefined;
  return { message: "Translation stopped." };
}

function updateActiveDisplayConfig(item: Zotero.Item, config: DisplayConfig) {
  const reader = findOpenPdfReaderForItem(item) || getActivePdfReader();
  if (!reader) return;

  const state = readerOverlayStates.get(getReaderKey(reader));
  if (!state) return;

  state.displayConfig = config;
  scheduleRender(reader, state);
}

function setBoundingBoxesVisible(
  reader: PrivatePdfReader,
  state: ReaderOverlayState,
  visible: boolean,
) {
  state.visible = visible;
  if (visible) {
    scheduleRender(reader, state);
    return;
  }

  if (state.renderTimer) {
    globalThis.clearTimeout(state.renderTimer);
    state.renderTimer = null;
  }
  for (const view of getReaderPdfViews(reader)) {
    const pdfDocument = view._iframeWindow?.document;
    if (pdfDocument) removeBoundingBoxLayers(pdfDocument);
  }
}

function createTranslationAbortController(
  reader: PrivatePdfReader,
): TranslationAbortController {
  const AbortControllerCtor = getAbortControllerConstructor(reader);
  if (AbortControllerCtor) return new AbortControllerCtor();

  const signal = { aborted: false };
  return {
    signal,
    abort: () => {
      signal.aborted = true;
    },
  };
}

function getAbortControllerConstructor(
  reader: PrivatePdfReader,
): AbortControllerConstructor | null {
  const globalConstructor = (globalThis as unknown as {
    AbortController?: AbortControllerConstructor;
  }).AbortController;
  if (typeof globalConstructor === "function") return globalConstructor;

  const mainWindowConstructor = (Zotero.getMainWindow?.() as unknown as
    | { AbortController?: AbortControllerConstructor }
    | undefined)?.AbortController;
  if (typeof mainWindowConstructor === "function") {
    return mainWindowConstructor;
  }

  for (const view of getReaderPdfViews(reader)) {
    const viewConstructor = (view._iframeWindow as unknown as
      | { AbortController?: AbortControllerConstructor }
      | undefined)?.AbortController;
    if (typeof viewConstructor === "function") return viewConstructor;
  }

  return null;
}

async function applyTranslationCache(layout: MineruLayout): Promise<number> {
  if (!layout.translationCachePath) return 0;

  const cacheText = await readCachedTextFile(layout.translationCachePath);
  if (!cacheText) return 0;

  let rawCache: unknown;
  try {
    rawCache = JSON.parse(cacheText);
  } catch (err) {
    ztoolkit.log("Show Markdown: failed to parse translation cache", err);
    return 0;
  }

  const entries = getTranslationCacheEntries(rawCache);
  if (!entries) return 0;

  let count = 0;
  for (const page of layout.pages.values()) {
    for (const box of page.boxes) {
      const translation = readCachedTranslation(entries[getBoxCacheKey(box)], box);
      if (!translation) continue;
      box.translation = translation;
      count += 1;
    }
  }

  return count;
}

async function saveTranslationCache(layout: MineruLayout): Promise<number> {
  if (!layout.translationCachePath) return 0;

  const translations: Record<string, TranslationCacheEntry> = {};
  let count = 0;
  const updatedAt = new Date().toISOString();
  for (const page of layout.pages.values()) {
    for (const box of page.boxes) {
      const translation = normalizeText(box.translation || "");
      if (!translation) continue;

      translations[getBoxCacheKey(box)] = {
        bbox: box.bbox,
        label: box.label,
        pageIndex: box.pageIndex,
        text: normalizeText(box.text || ""),
        translation,
        updatedAt,
      };
      count += 1;
    }
  }

  await writeCachedTextFile(
    layout.translationCachePath,
    JSON.stringify({ version: 1, translations }, null, 2),
  );
  return count;
}

function getTranslationCacheEntries(
  rawCache: unknown,
): Record<string, unknown> | null {
  if (!isPlainObject(rawCache)) return null;

  const translations = rawCache.translations;
  if (isPlainObject(translations)) return translations;

  return rawCache;
}

function readCachedTranslation(
  entry: unknown,
  box: MineruBox,
): string | undefined {
  if (typeof entry === "string") return normalizeText(entry) || undefined;
  if (!isPlainObject(entry)) return undefined;

  const translation =
    typeof entry.translation === "string"
      ? normalizeText(entry.translation)
      : "";
  if (!translation) return undefined;

  const cachedText =
    typeof entry.text === "string" ? normalizeText(entry.text) : "";
  const boxText = normalizeText(box.text || "");
  if (cachedText && boxText && cachedText !== boxText) return undefined;

  return translation;
}

function getTranslationCachePath(layoutPath: string): string {
  const directory = getDirectoryPath(layoutPath);
  return directory ? `${directory}/${TRANSLATION_CACHE_FILE_NAME}` : "";
}

function getDirectoryPath(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+/g, "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex <= 0) return "";
  return normalizedPath.slice(0, separatorIndex);
}

function getBoxCacheKey(box: MineruBox): string {
  return `${box.pageIndex}:${box.bbox.map(formatBboxNumber).join(",")}`;
}

function formatBboxNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(3)));
}

async function loadMineruLayout(
  pdfAttachment: Zotero.Item,
): Promise<{ layout: MineruLayout | null; message: string }> {
  const parentTitle = getParentItemTitle(pdfAttachment);
  const layoutPath = await findCachedMineruLayoutPath(
    pdfAttachment.id,
    parentTitle,
  );
  if (!layoutPath) {
    return {
      layout: null,
      message: "layout.json not found in the MinerU result folder.",
    };
  }

  const layoutText = await readCachedTextFile(layoutPath);
  if (!layoutText) {
    return { layout: null, message: "Cannot read layout.json." };
  }

  let rawLayout: unknown;
  try {
    rawLayout = JSON.parse(layoutText);
  } catch (err) {
    ztoolkit.log("Show Markdown: failed to parse MinerU layout.json", err);
    return { layout: null, message: "layout.json is not valid JSON." };
  }

  const layout = parseMineruLayout(rawLayout);
  if (!getLayoutBoxCount(layout)) {
    return { layout: null, message: "No bounding boxes found in layout.json." };
  }
  layout.translationCachePath = getTranslationCachePath(layoutPath);
  const cachedCount = await applyTranslationCache(layout);

  return {
    layout,
    message: cachedCount
      ? `Loaded layout.json and ${cachedCount} cached translations.`
      : "Loaded layout.json.",
  };
}

async function enableBoundingBoxes(
  reader: PrivatePdfReader,
  layout: MineruLayout,
): Promise<ReaderOverlayState> {
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
    displayConfig: getDisplayConfig(),
    layout,
    cleanupCallbacks: [],
    renderTimer: null,
    showOcrText: false,
    visible: true,
  };
  readerOverlayStates.set(getReaderKey(reader), state);

  for (const view of views) {
    const pdfWindow = view._iframeWindow;
    if (!pdfWindow) continue;
    attachRenderListeners(pdfWindow, state);
  }

  scheduleRender(reader, state);
  return state;
}

function disableBoundingBoxes(reader: PrivatePdfReader) {
  const key = getReaderKey(reader);
  const state = readerOverlayStates.get(key);
  if (state) {
    state.translationRunId = ++translationRunCounter;
    state.translationAbortController?.abort();
    state.translationAbortController = undefined;
  }
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
    renderBoundingBoxesInWindow(pdfWindow, state);
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

  pdfWindow.addEventListener("resize", schedule);
  state.cleanupCallbacks.push(() =>
    pdfWindow.removeEventListener("resize", schedule),
  );

  render();
}

function scheduleRender(reader: PrivatePdfReader, state: ReaderOverlayState) {
  if (state.renderTimer) globalThis.clearTimeout(state.renderTimer);
  state.renderTimer = globalThis.setTimeout(() => {
    for (const view of getReaderPdfViews(reader)) {
      const pdfWindow = view._iframeWindow;
      if (pdfWindow) renderBoundingBoxesInWindow(pdfWindow, state);
    }
  }, 0);
}

function renderBoundingBoxesInWindow(
  pdfWindow: PdfWindowLike,
  state: ReaderOverlayState,
) {
  const pdfDocument = pdfWindow.document;
  injectPdfStyles(pdfDocument);

  if (!state.visible) {
    removeBoundingBoxLayers(pdfDocument);
    return;
  }

  const pageNodes = Array.from(
    pdfDocument.querySelectorAll(".page[data-page-number]"),
  ) as HTMLElement[];

  for (const pageNode of pageNodes) {
    const pageIndex = Number(pageNode.dataset.pageNumber || 0) - 1;
    const pageLayout = state.layout.pages.get(pageIndex);
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
    installBBoxLayerEventGuards(layer);

    for (const box of pageLayout.boxes) {
      const rectangle = createBoundingBoxNode(
        pdfDocument,
        box,
        sourceSize,
        pageWidth,
        pageHeight,
        state.displayConfig,
        state.showOcrText,
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
  displayConfig: DisplayConfig,
  showOcrText: boolean,
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
  rectangle.style.boxSizing = "border-box";
  rectangle.style.contain = "paint";
  rectangle.style.overflow = "hidden";
  rectangle.style.position = "absolute";
  rectangle.title = [box.label, box.text, box.translation]
    .filter(Boolean)
    .join("\n\n");

  const displayText = showOcrText
    ? normalizeText(box.text || "")
    : normalizeText(box.translation || "");

  if (displayText) {
    rectangle.classList.add("has-translation");
    rectangle.style.background = displayConfig.translatedBoxColor;
    rectangle.style.borderColor = displayConfig.translatedBoxBorderColor;
    rectangle.style.pointerEvents = "auto";
    const scroll = doc.createElement("div");
    scroll.className = BBOX_SCROLL_CLASS;
    scroll.tabIndex = 0;
    scroll.setAttribute("aria-label", showOcrText ? "OCR text" : "Translation");
    scroll.style.color = displayConfig.textColor;
    const pageScale = getPageScale(sourceSize, pageWidth, pageHeight);
    const fontSize = getTranslationFontSize(displayConfig, pageScale);
    scroll.style.setProperty(
      "--bbox-font-size",
      `${fontSize}px`,
    );
    scroll.style.background = "transparent";
    scroll.style.boxSizing = "border-box";
    scroll.style.colorScheme = "light";
    scroll.style.cursor = "text";
    scroll.style.fontSize = `${fontSize}px`;
    scroll.style.height = "100%";
    scroll.style.inset = "0";
    scroll.style.lineHeight = "1.25";
    scroll.style.maxHeight = "100%";
    scroll.style.maxWidth = "100%";
    scroll.style.minHeight = "0";
    scroll.style.outline = "none";
    scroll.style.overflowX = "hidden";
    scroll.style.overflowY = "auto";
    scroll.style.padding = "2px 3px";
    scroll.style.pointerEvents = "auto";
    scroll.style.position = "absolute";
    scroll.style.userSelect = "text";
    scroll.style.width = "100%";
    scroll.style.setProperty("-moz-user-select", "text");
    scroll.style.setProperty("overscroll-behavior", "contain");
    scroll.style.setProperty("scrollbar-gutter", "stable");
    scroll.style.setProperty("scrollbar-width", "none");

    const text = doc.createElement("div");
    text.className = BBOX_TEXT_CLASS;
    text.style.background = "transparent";
    text.style.color = "inherit";
    text.style.display = "block";
    text.style.fontSize = `${fontSize}px`;
    text.style.lineHeight = "1.25";
    text.style.maxWidth = "100%";
    text.style.overflowWrap = "anywhere";
    text.style.position = "static";
    text.style.userSelect = "text";
    text.style.whiteSpace = "pre-wrap";
    text.style.wordBreak = "break-word";
    text.style.setProperty("-moz-user-select", "text");
    renderTextWithMath(doc, text, displayText);
    scroll.append(text);

    installTranslatedBoxEventGuards(rectangle, scroll);
    rectangle.append(scroll);
  } else {
    rectangle.classList.add("no-translation");
    rectangle.style.background = colorWithAlpha(
      displayConfig.untranslatedBoxColor,
      0.08,
    );
    rectangle.style.borderColor = displayConfig.untranslatedBoxColor;
    rectangle.style.pointerEvents = "none";
  }

  return rectangle;
}

function renderTextWithMath(doc: Document, container: HTMLElement, value = "") {
  container.replaceChildren();

  for (const segment of parseMathText(value)) {
    if (segment.type === "text") {
      container.append(doc.createTextNode(segment.value));
      continue;
    }

    const wrapper = doc.createElement(segment.displayMode ? "div" : "span");
    wrapper.className = `${BBOX_MATH_CLASS} ${
      segment.displayMode ? "is-display" : "is-inline"
    }`;
    wrapper.setAttribute("data-tex", segment.value);

    try {
      wrapper.innerHTML = katex.renderToString(segment.value, {
        displayMode: segment.displayMode,
        output: "mathml",
        strict: "ignore",
        throwOnError: false,
        trust: false,
      });
    } catch (err) {
      ztoolkit.log("Show Markdown: failed to render math", err);
      wrapper.textContent = segment.displayMode
        ? `$$${segment.value}$$`
        : `$${segment.value}$`;
    }

    container.append(wrapper);
  }
}

function parseMathText(value: string): MathTextSegment[] {
  const segments: MathTextSegment[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const opener = findNextMathDelimiter(value, cursor);
    if (!opener) {
      segments.push({ type: "text", value: value.slice(cursor) });
      break;
    }

    if (opener.index > cursor) {
      segments.push({ type: "text", value: value.slice(cursor, opener.index) });
    }

    const contentStart = opener.index + opener.length;
    const closerIndex = findClosingMathDelimiter(
      value,
      contentStart,
      opener.length,
    );
    if (closerIndex < 0) {
      segments.push({ type: "text", value: value.slice(opener.index) });
      break;
    }

    const math = value.slice(contentStart, closerIndex).trim();
    if (math) {
      segments.push({
        displayMode: opener.length === 2,
        type: "math",
        value: math,
      });
    } else {
      segments.push({
        type: "text",
        value: value.slice(opener.index, closerIndex + opener.length),
      });
    }
    cursor = closerIndex + opener.length;
  }

  return segments.length ? segments : [{ type: "text", value }];
}

function findNextMathDelimiter(value: string, start: number) {
  for (let index = start; index < value.length; index++) {
    if (value[index] !== "$" || isEscaped(value, index)) continue;
    const isDisplay = value[index + 1] === "$";
    return { index, length: isDisplay ? 2 : 1 };
  }
  return null;
}

function findClosingMathDelimiter(
  value: string,
  start: number,
  delimiterLength: number,
) {
  for (let index = start; index < value.length; index++) {
    if (value[index] !== "$" || isEscaped(value, index)) continue;
    if (delimiterLength === 2) {
      if (value[index + 1] === "$") return index;
      continue;
    }
    if (value[index + 1] !== "$") return index;
  }
  return -1;
}

function isEscaped(value: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function removeBoundingBoxLayers(doc: Document) {
  doc.querySelectorAll(`.${BBOX_LAYER_CLASS}`).forEach((node: Element) => {
    node.remove();
  });
}

function installBBoxLayerEventGuards(layer: HTMLElement) {
  const doc = layer.ownerDocument;
  if (!doc) return;
  installDocumentSelectionGuard(doc);

  layer.addEventListener(
    "selectstart",
    (event) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (closestElement(target, `.${BBOX_SCROLL_CLASS}`)) {
        event.stopPropagation();
        return;
      }
      if (closestElement(target, `.${BBOX_CLASS}.has-translation`)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );

  for (const eventName of ["mousedown", "pointerdown"]) {
    layer.addEventListener(
      eventName,
      (event: Event) => {
        const target = event.target as Node | null;
        if (!target) return;
        const translatedBox = closestElement(
          target,
          `.${BBOX_CLASS}.has-translation`,
        );
        if (!translatedBox) return;
        if (!closestElement(target, `.${BBOX_SCROLL_CLASS}`)) {
          event.preventDefault();
        }
        event.stopPropagation();
      },
      true,
    );
  }
}

function installDocumentSelectionGuard(doc: Document) {
  if (guardedSelectionDocuments.has(doc)) return;
  guardedSelectionDocuments.add(doc);

  doc.addEventListener(
    "copy",
    (event) => {
      const copyEvent = event as ClipboardEvent;
      const selection = doc.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const anchor = selection.anchorNode;
      if (!anchor) return;
      const scroll = closestElement(anchor, `.${BBOX_SCROLL_CLASS}`) as
        | HTMLElement
        | null;
      if (!scroll) return;
      const copiedText = getSelectionTextInside(selection, scroll);
      if (!copiedText) return;
      copyEvent.preventDefault();
      copyEvent.stopPropagation();
      copyEvent.clipboardData?.setData("text/plain", copiedText);
    },
    true,
  );

  doc.addEventListener("selectionchange", () => {
    const selection = doc.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const anchor = selection.anchorNode;
    if (!anchor) return;
    const scroll = closestElement(anchor, `.${BBOX_SCROLL_CLASS}`);
    if (!(scroll instanceof HTMLElement)) return;
    const focus = selection.focusNode;
    if (focus && scroll.contains(focus)) return;

    const range = doc.createRange();
    range.selectNodeContents(scroll);
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

function installTranslatedBoxEventGuards(
  rectangle: HTMLElement,
  scroll: HTMLElement,
) {
  let hideScrollbarTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const showScrollbar = () => {
    if (hideScrollbarTimer) {
      globalThis.clearTimeout(hideScrollbarTimer);
      hideScrollbarTimer = null;
    }
    scroll.style.setProperty("scrollbar-width", "auto");
  };
  const hideScrollbar = () => {
    if (hideScrollbarTimer) globalThis.clearTimeout(hideScrollbarTimer);
    hideScrollbarTimer = globalThis.setTimeout(() => {
      scroll.style.setProperty("scrollbar-width", "none");
      hideScrollbarTimer = null;
    }, 500);
  };

  for (const eventName of ["mouseenter", "mousemove", "focus"]) {
    scroll.addEventListener(eventName, showScrollbar, true);
  }
  scroll.addEventListener("mouseleave", hideScrollbar, true);
  scroll.addEventListener("blur", hideScrollbar, true);

  scroll.addEventListener(
    "wheel",
    (event) => {
      const wheelEvent = event as WheelEvent;
      showScrollbar();
      hideScrollbar();
      if (scroll.scrollHeight <= scroll.clientHeight) return;
      const atTop = scroll.scrollTop <= 0;
      const atBottom =
        Math.ceil(scroll.scrollTop + scroll.clientHeight) >= scroll.scrollHeight;
      const goingUp = wheelEvent.deltaY < 0;
      const goingDown = wheelEvent.deltaY > 0;
      if ((goingUp && !atTop) || (goingDown && !atBottom)) {
        wheelEvent.stopPropagation();
      }
    },
    { passive: true },
  );

  for (const eventName of [
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "pointerdown",
    "pointerup",
    "pointermove",
    "selectstart",
  ]) {
    scroll.addEventListener(
      eventName,
      (event: Event) => {
        event.stopPropagation();
      },
      true,
    );
  }

  scroll.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const isSelectAll =
      (keyboardEvent.ctrlKey || keyboardEvent.metaKey) &&
      keyboardEvent.key.toLowerCase() === "a";
    if (!isSelectAll) return;
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
    const doc = scroll.ownerDocument;
    if (!doc) return;
    const selection = doc.getSelection();
    if (!selection) return;
    const range = doc.createRange();
    range.selectNodeContents(scroll);
    selection.removeAllRanges();
    selection.addRange(range);
  });

  rectangle.addEventListener(
    "pointerdown",
    (event) => {
      event.stopPropagation();
    },
    true,
  );
}

function closestElement(node: Node, selector: string): Element | null {
  if (node.nodeType === Node.ELEMENT_NODE) {
    return (node as Element).closest(selector);
  }
  return node.parentElement?.closest(selector) || null;
}

function getSelectionTextInside(
  selection: Selection,
  container: HTMLElement,
): string {
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if (anchor && focus && container.contains(anchor) && container.contains(focus)) {
    const text = selection.toString().trim();
    if (text) return text;
  }

  return container.innerText.trim();
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
  const seenBoxes = new Map<string, MineruBox>();

  if (isPlainObject(rawLayout) && Array.isArray(rawLayout.pdf_info)) {
    rawLayout.pdf_info.forEach((page, index) => {
      if (!isPlainObject(page)) return;
      const pageIndex = readPageIndex(page) ?? index;
      const pageSize = readPageSize(page);
      ensurePageLayout(pages, pageIndex, pageSize);

      const candidateKeys = [
        "layout_bboxes",
        "layouts",
        "layout",
        "layout_dets",
        "detections",
        "blocks",
        "para_blocks",
        "preproc_blocks",
      ];
      for (const key of candidateKeys) {
        const value = page[key];
        if (Array.isArray(value) && value.length) {
          collectBlocks(value, pageIndex, pageSize, pages, seenBoxes);
        }
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
      "para_blocks",
      "preproc_blocks",
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
  seenBoxes: Map<string, MineruBox>,
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
  seenBoxes: Map<string, MineruBox>,
) {
  if (!Array.isArray(blocks)) return;

  for (const block of blocks) {
    if (!isPlainObject(block)) continue;
    const pageIndex = readPageIndex(block) ?? fallbackPageIndex;
    const pageSize = readPageSize(block) || fallbackPageSize;
    const bbox = readBBox(block);
    if (bbox) {
      const key = `${pageIndex}:${bbox.join(",")}`;
      const label = readBoxLabel(block);
      const text = readBlockText(block);
      const existing = seenBoxes.get(key);
      if (existing) {
        if (!existing.label && label) existing.label = label;
        if (!existing.text && text) existing.text = text;
      } else {
        const box = { pageIndex, bbox, label, text };
        seenBoxes.set(key, box);
        ensurePageLayout(pages, pageIndex, pageSize).boxes.push(box);
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
      "para_blocks",
      "preproc_blocks",
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

function readBlockText(value: Record<string, unknown>): string | undefined {
  for (const key of ["text", "content", "table_body"]) {
    const directValue = value[key];
    if (typeof directValue === "string" && directValue.trim()) {
      return normalizeText(directValue);
    }
  }

  const lines = value.lines;
  if (!Array.isArray(lines)) return undefined;

  const lineTexts = lines
    .map((line) => {
      if (!isPlainObject(line) || !Array.isArray(line.spans)) return "";
      return line.spans
        .map((span) => {
          if (!isPlainObject(span)) return "";
          const content = span.content;
          return typeof content === "string" ? content : "";
        })
        .filter(Boolean)
        .join(" ");
    })
    .filter(Boolean);

  return normalizeText(lineTexts.join("\n")) || undefined;
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getLayoutBoxCount(layout: MineruLayout): number {
  let count = 0;
  for (const page of layout.pages.values()) {
    count += page.boxes.length;
  }
  return count;
}

function getSelectedPageIndexes(
  layout: MineruLayout,
  config: TranslationConfig,
): Set<number> {
  const pageIndexes = Array.from(layout.pages.keys()).sort((a, b) => a - b);
  const maxPageIndex = Math.max(...pageIndexes, 0);
  const included = parsePageSpec(config.pages, maxPageIndex);
  const selected = included || new Set(pageIndexes);
  const skipped = parsePageSpec(config.skipPages, maxPageIndex);

  for (const pageIndex of skipped || []) {
    selected.delete(pageIndex);
  }

  return selected;
}

function getClearPageIndexes(
  layout: MineruLayout,
  pageSpec: string,
): Set<number> {
  const normalized = normalizeText(pageSpec).toLowerCase();
  const pageIndexes = Array.from(layout.pages.keys()).sort((a, b) => a - b);
  if (!normalized || normalized === "all" || normalized === "*") {
    return new Set(pageIndexes);
  }

  const maxPageIndex = Math.max(...pageIndexes, 0);
  const parsedPages = parsePageSpec(pageSpec, maxPageIndex);
  if (!parsedPages) return new Set(pageIndexes);
  for (const pageIndex of Array.from(parsedPages)) {
    if (!layout.pages.has(pageIndex)) parsedPages.delete(pageIndex);
  }
  return parsedPages;
}

function formatPageSelection(pageIndexes: Set<number>): string {
  const pages = Array.from(pageIndexes)
    .sort((a, b) => a - b)
    .map((pageIndex) => pageIndex + 1);
  if (!pages.length) return "no pages";
  if (pages.length > 5) return `${pages.length} pages`;
  return `page${pages.length > 1 ? "s" : ""} ${pages.join(", ")}`;
}

function getTranslatableBoxes(
  layout: MineruLayout,
  selectedPageIndexes: Set<number>,
): MineruBox[] {
  const boxes: MineruBox[] = [];
  const skipLabels = new Set(["image", "table", "interline_equation"]);

  for (const pageIndex of Array.from(selectedPageIndexes).sort((a, b) => a - b)) {
    const page = layout.pages.get(pageIndex);
    if (!page) continue;

    for (const box of page.boxes) {
      const text = normalizeText(box.text || "");
      if (!text) continue;
      if (box.label && skipLabels.has(box.label)) continue;
      box.text = text;
      boxes.push(box);
    }
  }

  return boxes;
}

function createTranslationBatches(boxes: MineruBox[]): MineruBox[][] {
  const batches: MineruBox[][] = [];
  for (let index = 0; index < boxes.length; index += TRANSLATION_BATCH_SIZE) {
    batches.push(boxes.slice(index, index + TRANSLATION_BATCH_SIZE));
  }
  return batches;
}

function getTranslationConcurrency(config: TranslationConfig): number {
  const value = Number.parseInt(config.concurrency, 10);
  if (!Number.isInteger(value)) return Number(DEFAULT_TRANSLATION_CONCURRENCY);
  return Math.max(1, Math.min(MAX_TRANSLATION_CONCURRENCY, value));
}

function parsePageSpec(
  value: string,
  maxPageIndex: number,
): Set<number> | null {
  const normalized = value
    .replace(/[，、；;]/g, ",")
    .replace(/\s+/g, "")
    .trim();
  if (!normalized) return null;

  const pageIndexes = new Set<number>();
  for (const token of normalized.split(",").filter(Boolean)) {
    const rangeMatch = token.match(/^(\d+)(?:-|~|到|至)(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
      for (let page = Math.min(start, end); page <= Math.max(start, end); page++) {
        addPageIndex(pageIndexes, page, maxPageIndex);
      }
      continue;
    }

    const page = Number(token);
    if (Number.isInteger(page)) addPageIndex(pageIndexes, page, maxPageIndex);
  }

  return pageIndexes;
}

function addPageIndex(
  pageIndexes: Set<number>,
  oneBasedPage: number,
  maxPageIndex: number,
) {
  const pageIndex = oneBasedPage - 1;
  if (pageIndex < 0 || pageIndex > maxPageIndex) return;
  pageIndexes.add(pageIndex);
}

async function translateBatchWithFallback(
  endpoint: string,
  model: string,
  prompt: string,
  stripStrings: string,
  texts: string[],
  signal: TranslationAbortSignal,
): Promise<string[]> {
  try {
    return await requestTranslations(
      endpoint,
      model,
      prompt,
      stripStrings,
      texts,
      signal,
    );
  } catch (err) {
    if (signal.aborted || isAbortError(err)) throw err;
    if (texts.length === 1) throw err;
    ztoolkit.log("Show Markdown: batch translation failed, retrying singly", err);
  }

  const translations: string[] = [];
  for (const text of texts) {
    if (signal.aborted) throw new Error("Translation stopped.");
    const [translation] = await requestTranslations(
      endpoint,
      model,
      prompt,
      stripStrings,
      [text],
      signal,
    );
    translations.push(translation || "");
  }
  return translations;
}

async function requestTranslations(
  endpoint: string,
  model: string,
  prompt: string,
  stripStrings: string,
  texts: string[],
  signal: TranslationAbortSignal,
): Promise<string[]> {
  const singleText = texts.length === 1 ? texts[0] : "";
  const systemPrompt = normalizeText(prompt || "") || DEFAULT_TRANSLATION_PROMPT;
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: singleText ? systemPrompt : DEFAULT_BATCH_TRANSLATION_PROMPT,
        },
        {
          role: "user",
          content: singleText
            ? `/no_think\nTranslate the following source text. Return only the translation, without wrappers or labels.\n\nSOURCE:\n${singleText}`
            : `/no_think\n${JSON.stringify(texts)}`,
        },
      ],
    }),
  };
  if (isNativeAbortSignal(signal)) requestInit.signal = signal;

  const response = await globalThis.fetch(endpoint, requestInit);

  if (!response.ok) {
    const detail = await readTranslationErrorMessage(response);
    throw new Error(
      `Translation request failed: ${response.status}${
        detail ? ` - ${detail}` : ""
      }`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: { content?: string };
      text?: string;
    }>;
  };
  const content =
    data.choices?.[0]?.message?.content || data.choices?.[0]?.text || "";
  if (singleText) {
    return [cleanTranslationText(parseSingleTranslation(content), stripStrings)];
  }
  return parseTranslationArray(content, texts.length).map((translation) =>
    cleanTranslationText(translation, stripStrings),
  );
}

async function readTranslationErrorMessage(
  response: Response,
): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return "";
  }

  const trimmedText = normalizeText(text);
  if (!trimmedText) return "";

  try {
    const data = JSON.parse(trimmedText) as unknown;
    const message = readErrorMessage(data);
    if (message) return truncateStatusText(message);
  } catch {
    // Fall through to the raw body text.
  }

  return truncateStatusText(trimmedText);
}

function readErrorMessage(value: unknown): string {
  if (typeof value === "string") return normalizeText(value);
  if (!isPlainObject(value)) return "";

  const directMessage = value.message || value.detail;
  if (typeof directMessage === "string") return normalizeText(directMessage);

  const error = value.error;
  if (typeof error === "string") return normalizeText(error);
  if (isPlainObject(error)) {
    const errorMessage = error.message || error.detail || error.type;
    if (typeof errorMessage === "string") {
      return normalizeText(errorMessage);
    }
  }

  return "";
}

function truncateStatusText(value: string): string {
  return value.length > 320 ? `${value.slice(0, 317)}...` : value;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  if (!err || typeof err !== "object") return false;
  return String((err as { name?: unknown }).name || "") === "AbortError";
}

function isNativeAbortSignal(
  signal: TranslationAbortSignal,
): signal is AbortSignal {
  return typeof (signal as AbortSignal).addEventListener === "function";
}

function parseTranslationArray(value: string, expectedLength: number): string[] {
  const withoutThinking = value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  const jsonText =
    withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ||
    withoutThinking.slice(
      Math.max(0, withoutThinking.indexOf("[")),
      withoutThinking.lastIndexOf("]") + 1,
    );
  const parsed = parseJsonWithLooseBackslashes(jsonText);
  if (!Array.isArray(parsed)) {
    throw new Error("Translation response is not an array");
  }

  const translations = parsed.map((entry) => normalizeText(String(entry || "")));
  if (translations.length !== expectedLength) {
    throw new Error(
      `Translation response length mismatch: ${translations.length}/${expectedLength}`,
    );
  }
  return translations;
}

function parseSingleTranslation(value: string): string {
  let text = value.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = text.match(/```(?:text|markdown|json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();

  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = parseJsonWithLooseBackslashes(text);
      if (Array.isArray(parsed)) {
        return normalizeText(String(parsed[0] || ""));
      }
    } catch {
      // Fall through to plain text cleanup.
    }
  }

  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1);
  }

  return normalizeText(text);
}

function cleanTranslationText(value: string, stripStrings: string): string {
  let text = value;
  for (const token of parseStripStrings(stripStrings)) {
    text = text.split(token).join("");
  }
  return normalizeText(text);
}

function parseStripStrings(value: string): string[] {
  return value
    .split(/[，,]/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function parseJsonWithLooseBackslashes(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (err) {
    const repaired = value.replace(
      /\\(?!["\\/bfnrtu])/g,
      "\\\\",
    );
    return JSON.parse(repaired);
  }
}

function getChatCompletionsEndpoint(baseURL: string): string {
  const trimmed = (baseURL || DEFAULT_TRANSLATION_BASE_URL).trim();
  const withoutTrailingSlash = trimmed.replace(/\/+$/g, "");
  if (/\/chat\/completions$/i.test(withoutTrailingSlash)) {
    return withoutTrailingSlash;
  }
  if (/\/v1$/i.test(withoutTrailingSlash)) {
    return `${withoutTrailingSlash}/chat/completions`;
  }
  return `${withoutTrailingSlash}/v1/chat/completions`;
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

function createLabeledInput(
  doc: Document,
  labelText: string,
  value: string,
  placeholder: string,
) {
  const wrapper = doc.createElement("label");
  wrapper.className = "show-markdown-mineru-field";

  const label = doc.createElement("span");
  label.className = "show-markdown-mineru-field-label";
  label.textContent = labelText;

  const input = doc.createElement("input");
  input.className = "show-markdown-mineru-input";
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;

  wrapper.append(label, input);
  return { wrapper, input };
}

function createConfigGroup(doc: Document, title: string) {
  const section = doc.createElement("section");
  section.className = "show-markdown-mineru-config-group";

  const heading = doc.createElement("div");
  heading.className = "show-markdown-mineru-config-heading";
  heading.textContent = title;

  section.append(heading);
  return section;
}

function createTabButton(doc: Document, label: string) {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "show-markdown-mineru-tab";
  button.textContent = label;
  return button;
}

function createLabeledTextarea(
  doc: Document,
  labelText: string,
  value: string,
  placeholder: string,
) {
  const wrapper = doc.createElement("label");
  wrapper.className = "show-markdown-mineru-field";

  const label = doc.createElement("span");
  label.className = "show-markdown-mineru-field-label";
  label.textContent = labelText;

  const textarea = doc.createElement("textarea");
  textarea.className = "show-markdown-mineru-textarea";
  textarea.value = value;
  textarea.placeholder = placeholder;
  textarea.rows = 7;
  textarea.spellcheck = false;

  wrapper.append(label, textarea);
  return { wrapper, textarea };
}

function getTranslationConfig(): TranslationConfig {
  return {
    baseURL: getPrefString(
      PREF_TRANSLATION_BASE_URL,
      DEFAULT_TRANSLATION_BASE_URL,
    ),
    model: getPrefString(PREF_TRANSLATION_MODEL, DEFAULT_TRANSLATION_MODEL),
    pages: getPrefString(PREF_TRANSLATION_PAGES, ""),
    skipPages: getPrefString(PREF_TRANSLATION_SKIP_PAGES, ""),
    concurrency: getPrefString(
      PREF_TRANSLATION_CONCURRENCY,
      DEFAULT_TRANSLATION_CONCURRENCY,
    ),
    clearPages: getPrefString(
      PREF_TRANSLATION_CLEAR_PAGES,
      DEFAULT_TRANSLATION_CLEAR_PAGES,
    ),
    prompt: getPrefString(PREF_TRANSLATION_PROMPT, DEFAULT_TRANSLATION_PROMPT),
    stripStrings: getPrefString(
      PREF_TRANSLATION_STRIP_STRINGS,
      DEFAULT_TRANSLATION_STRIP_STRINGS,
    ),
  };
}

function saveTranslationConfig(config: TranslationConfig) {
  Zotero.Prefs.set(
    PREF_TRANSLATION_BASE_URL,
    config.baseURL.trim() || DEFAULT_TRANSLATION_BASE_URL,
    true,
  );
  Zotero.Prefs.set(
    PREF_TRANSLATION_MODEL,
    config.model.trim() || DEFAULT_TRANSLATION_MODEL,
    true,
  );
  Zotero.Prefs.set(PREF_TRANSLATION_PAGES, config.pages.trim(), true);
  Zotero.Prefs.set(
    PREF_TRANSLATION_SKIP_PAGES,
    config.skipPages.trim(),
    true,
  );
  Zotero.Prefs.set(
    PREF_TRANSLATION_CONCURRENCY,
    String(getTranslationConcurrency(config)),
    true,
  );
  Zotero.Prefs.set(
    PREF_TRANSLATION_CLEAR_PAGES,
    config.clearPages.trim() || DEFAULT_TRANSLATION_CLEAR_PAGES,
    true,
  );
  Zotero.Prefs.set(
    PREF_TRANSLATION_PROMPT,
    config.prompt.trim() || DEFAULT_TRANSLATION_PROMPT,
    true,
  );
  Zotero.Prefs.set(
    PREF_TRANSLATION_STRIP_STRINGS,
    config.stripStrings.trim() || DEFAULT_TRANSLATION_STRIP_STRINGS,
    true,
  );
}

function getDisplayConfig(): DisplayConfig {
  return {
    translatedBoxColor: getColorPref(
      PREF_TRANSLATED_BOX_COLOR,
      DEFAULT_TRANSLATED_BOX_COLOR,
    ),
    translatedBoxBorderColor: getColorPref(
      PREF_TRANSLATED_BOX_BORDER_COLOR,
      DEFAULT_TRANSLATED_BOX_BORDER_COLOR,
    ),
    untranslatedBoxColor: getColorPref(
      PREF_UNTRANSLATED_BOX_COLOR,
      DEFAULT_UNTRANSLATED_BOX_COLOR,
    ),
    textColor: getColorPref(
      PREF_TRANSLATION_TEXT_COLOR,
      DEFAULT_TRANSLATION_TEXT_COLOR,
    ),
    fontSize: getFontSizePref(PREF_TRANSLATION_FONT_SIZE),
  };
}

function saveDisplayConfig(config: DisplayConfig): DisplayConfig {
  const normalizedConfig = normalizeDisplayConfig(config);
  Zotero.Prefs.set(
    PREF_TRANSLATED_BOX_COLOR,
    normalizedConfig.translatedBoxColor,
    true,
  );
  Zotero.Prefs.set(
    PREF_TRANSLATED_BOX_BORDER_COLOR,
    normalizedConfig.translatedBoxBorderColor,
    true,
  );
  Zotero.Prefs.set(
    PREF_UNTRANSLATED_BOX_COLOR,
    normalizedConfig.untranslatedBoxColor,
    true,
  );
  Zotero.Prefs.set(PREF_TRANSLATION_TEXT_COLOR, normalizedConfig.textColor, true);
  Zotero.Prefs.set(PREF_TRANSLATION_FONT_SIZE, normalizedConfig.fontSize, true);
  return normalizedConfig;
}

function normalizeDisplayConfig(config: DisplayConfig): DisplayConfig {
  return {
    translatedBoxColor: normalizeHexColor(
      config.translatedBoxColor,
      DEFAULT_TRANSLATED_BOX_COLOR,
    ),
    translatedBoxBorderColor: normalizeHexColor(
      config.translatedBoxBorderColor,
      DEFAULT_TRANSLATED_BOX_BORDER_COLOR,
    ),
    untranslatedBoxColor: normalizeHexColor(
      config.untranslatedBoxColor,
      DEFAULT_UNTRANSLATED_BOX_COLOR,
    ),
    textColor: normalizeHexColor(config.textColor, DEFAULT_TRANSLATION_TEXT_COLOR),
    fontSize: normalizeFontSize(config.fontSize),
  };
}

function getPrefString(pref: string, fallback: string): string {
  const value = Zotero.Prefs.get(pref, true);
  return typeof value === "string" && value.trim() ? value : fallback;
}

function getColorPref(pref: string, fallback: string): string {
  return normalizeHexColor(getPrefString(pref, fallback), fallback);
}

function getFontSizePref(pref: string): string {
  const value = Zotero.Prefs.get(pref, true);
  return typeof value === "string"
    ? normalizeFontSize(value)
    : DEFAULT_TRANSLATION_FONT_SIZE;
}

function normalizeHexColor(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (/^#[\da-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[\da-f]{3}$/i.test(trimmed)) {
    return `#${trimmed
      .slice(1)
      .split("")
      .map((char) => `${char}${char}`)
      .join("")}`.toLowerCase();
  }
  return fallback;
}

function normalizeFontSize(value: string): string {
  const numberValue = Number.parseFloat(value);
  if (!Number.isFinite(numberValue)) return DEFAULT_TRANSLATION_FONT_SIZE;
  return String(Math.max(6, Math.min(32, Math.round(numberValue))));
}

function injectPaneStyles(doc: Document) {
  const existingStyle = doc.getElementById(PANE_STYLE_ID);
  if (
    existingStyle?.getAttribute("data-show-markdown-style-version") ===
    PANE_STYLE_VERSION
  ) {
    return;
  }
  existingStyle?.remove();

  const style = doc.createElement("style");
  style.id = PANE_STYLE_ID;
  style.setAttribute("data-show-markdown-style-version", PANE_STYLE_VERSION);
  style.textContent = `
    .show-markdown-mineru-menu {
      box-sizing: border-box;
      display: flex !important;
      flex-direction: column !important;
      gap: 10px !important;
      padding: 8px 2px 10px;
      width: 100%;
    }

    .show-markdown-mineru-actions {
      background: var(--material-background, rgba(127, 127, 127, 0.08));
      border: 1px solid var(--fill-quinary, rgba(127, 127, 127, 0.28));
      border-radius: 8px;
      box-sizing: border-box;
      display: flex !important;
      flex-direction: column !important;
      gap: 7px !important;
      padding: 6px;
      position: sticky;
      top: 0;
      width: 100%;
      z-index: 2;
    }

    .show-markdown-mineru-button {
      appearance: none;
      border: 1px solid transparent;
      border-radius: 6px;
      background: var(--fill-quaternary, rgba(127, 127, 127, 0.16));
      color: inherit;
      cursor: pointer;
      flex: 1 1 0;
      font: menu;
      font-weight: 600;
      min-width: 0;
      min-height: 30px;
      padding: 5px 8px;
      text-align: center;
      width: 100%;
    }

    .show-markdown-mineru-button:hover:not(:disabled) {
      filter: brightness(1.08);
    }

    .show-markdown-mineru-button:focus-visible {
      outline: 2px solid rgba(80, 145, 255, 0.75);
      outline-offset: 1px;
    }

    .show-markdown-mineru-button.is-secondary {
      background: rgba(80, 145, 255, 0.16);
      border-color: rgba(80, 145, 255, 0.34);
    }

    .show-markdown-mineru-button.is-secondary.is-active {
      background: rgba(80, 145, 255, 0.32);
      border-color: rgba(80, 145, 255, 0.65);
    }

    .show-markdown-mineru-button.is-primary {
      background: rgba(45, 164, 78, 0.18);
      border-color: rgba(45, 164, 78, 0.42);
    }

    .show-markdown-mineru-button.is-danger {
      background: rgba(220, 80, 70, 0.18);
      border-color: rgba(220, 80, 70, 0.42);
    }

    .show-markdown-mineru-button:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .show-markdown-mineru-tabs {
      background: rgba(127, 127, 127, 0.1);
      border: 1px solid var(--fill-quinary, rgba(127, 127, 127, 0.25));
      border-radius: 7px;
      box-sizing: border-box;
      display: flex !important;
      gap: 4px;
      padding: 4px;
      width: 100%;
    }

    .show-markdown-mineru-tab {
      appearance: none;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px;
      box-sizing: border-box;
      color: inherit;
      cursor: pointer;
      flex: 1 1 0;
      font: menu;
      font-weight: 600;
      min-height: 28px;
      min-width: 0;
      padding: 4px 8px;
      text-align: center;
    }

    .show-markdown-mineru-tab.is-active {
      background: rgba(80, 145, 255, 0.24);
      border-color: rgba(80, 145, 255, 0.5);
    }

    .show-markdown-mineru-tab-panel {
      display: flex !important;
      flex-direction: column !important;
      gap: 9px !important;
      width: 100%;
    }

    .show-markdown-mineru-tab-panel[hidden] {
      display: none !important;
    }

    .show-markdown-mineru-config-group {
      background: var(--material-background, rgba(127, 127, 127, 0.06));
      border: 1px solid var(--fill-quinary, rgba(127, 127, 127, 0.22));
      border-radius: 8px;
      box-sizing: border-box;
      display: flex !important;
      flex-direction: column !important;
      gap: 9px !important;
      align-items: stretch !important;
      padding: 9px;
      width: 100%;
    }

    .show-markdown-mineru-config-heading {
      color: var(--fill-secondary, currentColor);
      font-size: 0.78em;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .show-markdown-mineru-field {
      box-sizing: border-box;
      display: flex !important;
      flex-direction: column !important;
      gap: 4px !important;
      align-items: stretch !important;
      justify-content: flex-start !important;
      margin: 0;
      min-width: 0;
      text-align: left;
      width: 100% !important;
    }

    .show-markdown-mineru-field-label {
      color: var(--fill-secondary, currentColor);
      display: block;
      font-size: 0.82em;
      font-weight: 600;
      line-height: 1.25;
      text-align: left;
    }

    .show-markdown-mineru-input {
      appearance: none;
      background: var(--material-background, transparent);
      border: 1px solid var(--fill-quinary, rgba(127, 127, 127, 0.35));
      border-radius: 5px;
      box-sizing: border-box;
      color: inherit;
      display: block;
      font: inherit;
      min-height: 28px;
      min-width: 0;
      padding: 4px 7px;
      width: 100% !important;
    }

    .show-markdown-mineru-input[type="color"] {
      align-self: flex-start;
      min-height: 30px;
      padding: 2px;
      width: 96px !important;
    }

    .show-markdown-mineru-input:focus,
    .show-markdown-mineru-textarea:focus {
      border-color: rgba(80, 145, 255, 0.7);
      outline: none;
    }

    .show-markdown-mineru-textarea {
      appearance: none;
      background: var(--material-background, transparent);
      border: 1px solid var(--fill-quinary, rgba(127, 127, 127, 0.35));
      border-radius: 5px;
      box-sizing: border-box;
      color: inherit;
      display: block;
      font: inherit;
      min-height: 120px;
      min-width: 0;
      padding: 6px 7px;
      resize: vertical;
      width: 100% !important;
    }

    .show-markdown-mineru-status {
      background: rgba(127, 127, 127, 0.08);
      border-radius: 6px;
      color: var(--fill-secondary, currentColor);
      font-size: 0.92em;
      min-height: 1.3em;
      padding: 5px 7px;
    }
  `;
  appendStyle(doc, style);
}

function injectPdfStyles(doc: Document) {
  const existingStyle = doc.getElementById(PDF_STYLE_ID);
  if (
    existingStyle?.getAttribute("data-show-markdown-style-version") ===
    PDF_STYLE_VERSION
  ) {
    return;
  }
  existingStyle?.remove();

  const style = doc.createElement("style");
  style.id = PDF_STYLE_ID;
  style.setAttribute("data-show-markdown-style-version", PDF_STYLE_VERSION);
  style.textContent = `
    .${BBOX_LAYER_CLASS} {
      contain: layout paint style;
      inset: 0;
      pointer-events: none;
      position: absolute;
      user-select: none;
      z-index: 30;
      -moz-user-select: none;
    }

    .${BBOX_CLASS} {
      background: rgba(255, 193, 7, 0.08);
      border: 1.5px solid rgba(255, 193, 7, 0.95);
      border-radius: 2px;
      box-sizing: border-box;
      contain: paint;
      overflow: hidden;
      pointer-events: none;
      position: absolute;
    }

    .${BBOX_CLASS}.no-translation {
      pointer-events: none;
      user-select: none;
      -moz-user-select: none;
    }

    .${BBOX_CLASS}.has-translation {
      background: #fff;
      border-color: ${DEFAULT_TRANSLATED_BOX_BORDER_COLOR};
      contain: paint;
      overflow: hidden;
      pointer-events: auto;
      user-select: none;
      -moz-user-select: none;
    }

    .${BBOX_SCROLL_CLASS} {
      background: transparent;
      box-sizing: border-box;
      color: #000;
      color-scheme: light;
      cursor: text;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", sans-serif;
      inset: 0;
      outline: none;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 2px 3px;
      pointer-events: auto;
      position: absolute;
      scrollbar-gutter: stable;
      scrollbar-width: none;
      user-select: text;
      -moz-user-select: text;
    }

    .${BBOX_CLASS}.has-translation:hover .${BBOX_SCROLL_CLASS},
    .${BBOX_SCROLL_CLASS}:focus {
      scrollbar-width: auto;
    }

    .${BBOX_SCROLL_CLASS}:focus {
      outline: none;
    }

    .${BBOX_SCROLL_CLASS}::selection,
    .${BBOX_SCROLL_CLASS} *::selection {
      background: rgba(120, 160, 255, 0.45);
      color: #000;
    }

    .${BBOX_TEXT_CLASS} {
      background: transparent;
      color: inherit;
      display: block;
      font-family: inherit;
      font-size: var(--bbox-font-size, 12px);
      line-height: 1.25;
      overflow-wrap: anywhere;
      position: static;
      user-select: text;
      white-space: pre-wrap;
      word-break: break-word;
      -moz-user-select: text;
    }

    .${BBOX_MATH_CLASS} {
      color: inherit;
      user-select: text;
      -moz-user-select: text;
    }

    .${BBOX_MATH_CLASS}.is-inline {
      display: inline-block;
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      vertical-align: -0.2em;
    }

    .${BBOX_MATH_CLASS}.is-display {
      display: block;
      margin: 0.2em 0;
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      text-align: center;
    }

    .${BBOX_MATH_CLASS} math {
      color: inherit;
      font-size: 1em;
      max-width: 100%;
    }

    .${BBOX_LAYER_CLASS} textarea,
    .${BBOX_LAYER_CLASS} input {
      display: none !important;
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

function getTranslationFontSize(
  displayConfig: DisplayConfig,
  pageScale: number,
) {
  const configuredSize = Number.parseFloat(displayConfig.fontSize);
  const fontSize = Number.isFinite(configuredSize)
    ? configuredSize
    : Number(DEFAULT_TRANSLATION_FONT_SIZE);
  return Math.max(4, fontSize * pageScale);
}

function getPageScale(
  sourceSize: [number, number],
  pageWidth: number,
  pageHeight: number,
) {
  const [sourceWidth, sourceHeight] = sourceSize;
  if (sourceWidth <= 1 && sourceHeight <= 1) {
    return Math.max(0.1, Math.min(pageWidth / 612, pageHeight / 792));
  }

  return Math.max(
    0.1,
    Math.min(pageWidth / sourceWidth, pageHeight / sourceHeight),
  );
}

function colorWithAlpha(color: string, alpha: number): string {
  const hex = normalizeHexColor(color, DEFAULT_UNTRANSLATED_BOX_COLOR).slice(1);
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
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
