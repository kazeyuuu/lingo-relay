importScripts("providers.js", "response-stream.js", "subscription-client.js", "provider-client.js");
// API credentials remain available to extension pages and the worker only.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
const MENU_ID = "lingo-local-translate";
const HISTORY_LIMIT = 200;
const PAGE_CLIENT_BUILD = "fresh-ui-v1";

const BUILT_IN_PROMPT_PRESETS = [
  {
    id: "all-to-zh",
    name: "全语言 → 中文",
    builtIn: true,
    prompt:
      "你是一名专业翻译。自动识别输入内容的语言，将全部内容翻译成自然、准确的简体中文。保留原文的段落、列表、术语和语气，只输出译文，不要解释。",
  },
  {
    id: "zh-to-en",
    name: "中文 → 英文",
    builtIn: true,
    prompt:
      "你是一名专业中英翻译。将输入的中文翻译成自然、准确、符合英文表达习惯的英文。保留原文的段落、列表、术语和语气，只输出英文译文，不要解释。",
  },
  {
    id: "ja-to-zh",
    name: "日文 → 中文",
    builtIn: true,
    prompt:
      "你是一名专业日中翻译。将输入的日文翻译成自然、准确的简体中文，正确处理敬语、专有名词和语境。保留原文的段落、列表和语气，只输出中文译文，不要解释。",
  },
];

const DEFAULT_SETTINGS = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "",
  systemPrompt: BUILT_IN_PROMPT_PRESETS[0].prompt,
  promptPresets: BUILT_IN_PROMPT_PRESETS,
  defaultPresetId: "all-to-zh",
  imagePrompt:
    "识别截图中的全部文字，并按照系统翻译规则进行翻译。保留原有段落、列表和语气，只输出最终译文；如果截图中没有可识别的文字，请明确说明。",
};

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "使用译流翻译“%s”",
      contexts: ["selection"],
    });
  });

  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText || !tab?.id) return;
  void translateSelection(info.selectionText.trim(), tab.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab?.id) return;
  if (command === "translate-selection") {
    void translateCurrentSelection(tab.id);
  }
  if (command === "capture-and-translate") {
    void startCaptureSelection(tab.id);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "GET_MODELS") {
    if (!isSettingsPage(sender)) return false;
    LingoClient.models(message.provider)
      .then((models) => sendResponse({ ok: true, models }))
      .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
    return true;
  }

  if (message?.type === "TEST_CONNECTION") {
    if (!isSettingsPage(sender)) return false;
    LingoClient.models(message.provider).then(models => ({ count: models.length, models }))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
    return true;
  }

  if (message?.type === "CODEX_AUTH" && isSettingsPage(sender)) {
    const action = message.action;
    if (!["status", "login", "logout", "cancel"].includes(action) || message.provider?.type !== "codex") return false;
    LingoClient.json(message.provider, `auth/${action}`, action === "status" ? {} : { body: {} })
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: friendlyError(error) }));
    return true;
  }

  if (message?.type === "GET_PROMPT_PRESETS") {
    loadSettings()
      .then((settings) =>
        sendResponse({
          ok: true,
          presets: settings.promptPresets.map(({ id, name }) => ({ id, name })),
          defaultPresetId: settings.defaultPresetId,
        }),
      )
      .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
    return true;
  }

  if (
    message?.type === "LINGO_RETRANSLATE" &&
    sender.tab?.id &&
    message.sourceText
  ) {
    sendResponse({ ok: true });
    void translateSelection(
      String(message.sourceText).trim(),
      sender.tab.id,
      message.anchor,
      message.presetId,
    );
    return false;
  }

  if (message?.type === "LINGO_CAPTURE_REGION" && sender.tab?.id) {
    sendResponse({ ok: true });
    void recognizeCapturedRegion(sender.tab, message.region);
    return false;
  }
});

function isSettingsPage(sender) {
  return sender.id === chrome.runtime.id && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("options.html");
}

async function startCaptureSelection(tabId) {
  try {
    await ensurePageClient(tabId);
    await safeSend(tabId, { type: "LINGO_CAPTURE_START" });
  } catch {
    // 受限页面不允许注入截图选择器。
  }
}

async function recognizeCapturedRegion(tab, region) {
  try {
    validateCaptureRegion(region);
    const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    const croppedImage = await cropScreenshot(screenshot, region);
    const anchor = {
      x: Math.min(region.viewportWidth - 20, region.x + region.width),
      y: Math.min(region.viewportHeight - 20, region.y + region.height),
    };

    await ensurePageClient(tab.id);
    await safeSend(tab.id, {
      type: "LINGO_TRANSLATION_START",
      sourceText: "截图识别与翻译",
      anchor,
    });

    const settings = await loadSettings();
    validateSettings(settings);
    if (!settings.imagePrompt?.trim()) {
      throw new Error("截图识别提示词不能为空");
    }
    const result = await LingoClient.translate(settings, settings.systemPrompt, settings.imagePrompt, croppedImage,
      notice => safeSend(tab.id, { type: "LINGO_TRANSLATION_FALLBACK", ...notice }));
    const entry = await saveHistory({
      sourceText: "截图识别（原图不保存）",
      translatedText: result.text,
      model: result.provider.model,
      providerName: result.provider.name,
      fallback: result.fallback,
      primaryError: result.primaryError,
      kind: "image",
    });
    await safeSend(tab.id, { type: "LINGO_TRANSLATION_SUCCESS", entry });
  } catch (error) {
    await safeSend(tab.id, {
      type: "LINGO_TRANSLATION_ERROR",
      error: friendlyError(error),
    });
  }
}

async function translateCurrentSelection(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: capturePageSelection,
    });
    const selection = results
      .map((item) => item.result)
      .find((item) => item?.text?.trim());

    await ensurePageClient(tabId);
    const text = selection?.text?.trim();
    if (!text) {
      await safeSend(tabId, {
        type: "LINGO_TRANSLATION_ERROR",
        error: "没有检测到选中的文字，请先框选要翻译的内容。",
        showSettings: false,
      });
      return;
    }
    await translateSelection(text, tabId, selection.anchor);
  } catch {
    // Chrome 内置页及扩展商店等页面不允许内容脚本读取选区。
  }
}

async function translateSelection(text, tabId, anchor, requestedPresetId) {
  if (!text) return;

  await ensurePageClient(tabId);
  await safeSend(tabId, {
    type: "LINGO_TRANSLATION_START",
    sourceText: text,
    anchor,
  });

  try {
    const settings = await loadSettings();
    validateSettings(settings);
    const preset = resolvePromptPreset(settings, requestedPresetId);
    const result = await LingoClient.translate(settings, preset.prompt, text, undefined,
      notice => safeSend(tabId, { type: "LINGO_TRANSLATION_FALLBACK", ...notice }));
    const entry = await saveHistory({
      sourceText: text,
      translatedText: result.text,
      model: result.provider.model,
      providerName: result.provider.name,
      fallback: result.fallback,
      primaryError: result.primaryError,
      presetId: preset.id,
      presetName: preset.name,
    });
    await safeSend(tabId, { type: "LINGO_TRANSLATION_SUCCESS", entry });
  } catch (error) {
    await safeSend(tabId, {
      type: "LINGO_TRANSLATION_ERROR",
      error: friendlyError(error),
    });
  }
}


function validateSettings(settings) {
  if (!settings.systemPrompt?.trim()) {
    throw new Error("翻译提示词不能为空");
  }
  const config = LingoProviders.normalize(settings);
  LingoProviders.validate(config.providers.find(p => p.id === config.primaryProviderId));
}


async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return normalizeSettings(settings);
}

async function saveHistory({
  sourceText,
  translatedText,
  model,
  kind = "text",
  presetId = "",
  presetName = "",
  providerName = "",
  fallback = false,
  primaryError = "",
}) {
  const entry = {
    id: crypto.randomUUID(),
    sourceText,
    translatedText,
    model,
    kind,
    presetId,
    presetName,
    providerName,
    fallback,
    primaryError,
    createdAt: Date.now(),
  };
  const { history = [] } = await chrome.storage.local.get("history");
  await chrome.storage.local.set({
    history: [entry, ...history].slice(0, HISTORY_LIMIT),
  });
  return entry;
}

function normalizeSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...input };
  let presets = Array.isArray(input.promptPresets)
    ? input.promptPresets
        .filter((item) => item?.id && item?.name?.trim() && item?.prompt?.trim())
        .map((item) => ({
          id: String(item.id),
          name: String(item.name).trim(),
          prompt: String(item.prompt).trim(),
          builtIn: Boolean(item.builtIn),
        }))
    : [];

  if (!presets.length) {
    presets = BUILT_IN_PROMPT_PRESETS.map((item) => ({ ...item }));
    const legacyPrompt = input.systemPrompt?.trim();
    if (
      legacyPrompt &&
      !presets.some((item) => item.prompt === legacyPrompt)
    ) {
      presets.push({
        id: "legacy-default",
        name: "原默认方案",
        prompt: legacyPrompt,
        builtIn: false,
      });
    }
  } else {
    const existingById = new Map(presets.map((item) => [item.id, item]));
    const builtIns = BUILT_IN_PROMPT_PRESETS.map((item) => ({
      ...item,
      ...existingById.get(item.id),
      builtIn: true,
    }));
    const custom = presets.filter(
      (item) =>
        !BUILT_IN_PROMPT_PRESETS.some((builtIn) => builtIn.id === item.id),
    );
    presets = [...builtIns, ...custom];
  }

  let defaultPresetId = input.defaultPresetId;
  if (!presets.some((item) => item.id === defaultPresetId)) {
    defaultPresetId = presets.some((item) => item.id === "legacy-default")
      ? "legacy-default"
      : "all-to-zh";
  }
  const activePreset =
    presets.find((item) => item.id === defaultPresetId) || presets[0];

  return {
    ...merged,
    ...LingoProviders.normalize(input),
    promptPresets: presets,
    defaultPresetId: activePreset.id,
    systemPrompt: activePreset.prompt,
  };
}

function resolvePromptPreset(settings, requestedPresetId) {
  return (
    settings.promptPresets.find((item) => item.id === requestedPresetId) ||
    settings.promptPresets.find(
      (item) => item.id === settings.defaultPresetId,
    ) ||
    settings.promptPresets[0]
  );
}

function validateCaptureRegion(region) {
  const values = [
    region?.x,
    region?.y,
    region?.width,
    region?.height,
    region?.viewportWidth,
    region?.viewportHeight,
  ];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    region.width < 8 ||
    region.height < 8 ||
    region.viewportWidth <= 0 ||
    region.viewportHeight <= 0
  ) {
    throw new Error("截图区域无效，请重新框选");
  }
}

async function cropScreenshot(dataUrl, region) {
  const sourceBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const scaleX = bitmap.width / region.viewportWidth;
    const scaleY = bitmap.height / region.viewportHeight;
    const sourceX = Math.max(0, Math.round(region.x * scaleX));
    const sourceY = Math.max(0, Math.round(region.y * scaleY));
    const sourceWidth = Math.min(
      bitmap.width - sourceX,
      Math.max(1, Math.round(region.width * scaleX)),
    );
    const sourceHeight = Math.min(
      bitmap.height - sourceY,
      Math.max(1, Math.round(region.height * scaleY)),
    );

    const maxEdge = 2048;
    const resizeScale = Math.min(
      1,
      maxEdge / Math.max(sourceWidth, sourceHeight),
    );
    const outputWidth = Math.max(1, Math.round(sourceWidth * resizeScale));
    const outputHeight = Math.max(1, Math.round(sourceHeight * resizeScale));
    const canvas = new OffscreenCanvas(outputWidth, outputHeight);
    const context = canvas.getContext("2d");
    context.drawImage(
      bitmap,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      outputWidth,
      outputHeight,
    );
    const outputBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.92,
    });
    return blobToDataUrl(outputBlob);
  } finally {
    bitmap.close();
  }
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}


async function safeSend(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    // Chrome 内置页、扩展页等不允许注入内容脚本；翻译与历史仍可正常完成。
    return false;
  }
}

async function ensurePageClient(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "LINGO_PING",
    });
    if (response?.build === PAGE_CLIENT_BUILD) return;
  } catch {
    // 页面还没有当前版本的内容脚本，下面立即注入。
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

function capturePageSelection() {
  const activeElement = document.activeElement;
  const isTextControl =
    activeElement instanceof HTMLTextAreaElement ||
    (activeElement instanceof HTMLInputElement &&
      /^(text|search|url|tel|email|password)$/i.test(activeElement.type));

  if (
    isTextControl &&
    typeof activeElement.selectionStart === "number" &&
    activeElement.selectionStart !== activeElement.selectionEnd
  ) {
    const rect = activeElement.getBoundingClientRect();
    return {
      text: activeElement.value
        .slice(activeElement.selectionStart, activeElement.selectionEnd)
        .trim(),
      anchor: {
        x: Math.min(rect.right, rect.left + 48),
        y: Math.min(window.innerHeight - 20, rect.bottom),
      },
    };
  }

  const selection = window.getSelection();
  const text = selection?.toString().trim() || "";
  if (!text) return { text: "", anchor: null };

  const rect = selection.rangeCount
    ? selection.getRangeAt(0).getBoundingClientRect()
    : null;
  return {
    text,
    anchor:
      rect && (rect.width || rect.height)
        ? {
            x: Math.min(
              window.innerWidth - 20,
              rect.left + Math.min(rect.width, 48),
            ),
            y: Math.min(window.innerHeight - 20, rect.bottom),
          }
        : null,
  };
}

function friendlyError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch|NetworkError|fetch/i.test(raw)) {
    return "无法连接模型服务，请检查服务地址、授权和网络。";
  }
  return raw;
}
