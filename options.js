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

const form = document.querySelector("#settingsForm");
const promptInput = document.querySelector("#systemPrompt");
const presetNameInput = document.querySelector("#presetName");
const defaultPresetSelect = document.querySelector("#defaultPreset");
const presetList = document.querySelector("#presetList");
const imagePromptInput = document.querySelector("#imagePrompt");
const saveButton = document.querySelector("#saveSettings");
const resetButton = document.querySelector("#resetPrompt");
const newPresetButton = document.querySelector("#newPreset");
const savePresetButton = document.querySelector("#savePreset");
const deletePresetButton = document.querySelector("#deletePreset");
const resetImagePromptButton = document.querySelector("#resetImagePrompt");
const promptCount = document.querySelector("#promptCount");
const saveHint = document.querySelector("#saveHint");
const toast = document.querySelector("#toast");
const textShortcutKeys = document.querySelector("#textShortcutKeys");
const captureShortcutKeys = document.querySelector("#captureShortcutKeys");

let savedSettings = { ...DEFAULT_SETTINGS };
let workingPresets = [];
let selectedPresetId = "";
let toastTimer;

document.querySelector("#openShortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

window.addEventListener("focus", () => void refreshShortcutDisplay());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshShortcutDisplay();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!syncEditorToPreset(true)) return;
  if (
    workingPresets.some(
      (preset) => !preset.name.trim() || !preset.prompt.trim(),
    )
  ) {
    showToast("提示词库中存在未填写完整的方案", true);
    return;
  }
  if (!form.reportValidity()) return;

  saveButton.disabled = true;
  try {
    const settings = currentSettings();
    ProviderEditor.validate(settings);
    await ProviderEditor.authorize(settings.providers.filter(p => p.id === settings.primaryProviderId || (settings.autoFallback && p.id === settings.backupProviderId)));
    await chrome.storage.local.set({ settings });
    savedSettings = settings;
    saveHint.textContent = "所有修改均已保存";
    showToast("设置已保存");
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    saveButton.disabled = false;
  }
});

form.addEventListener("input", () => {
  saveHint.textContent = "有尚未保存的修改";
});

promptInput.addEventListener("input", updatePromptCount);

resetButton.addEventListener("click", () => {
  const builtIn = BUILT_IN_PROMPT_PRESETS.find(
    (item) => item.id === selectedPresetId,
  );
  if (!builtIn) return;
  presetNameInput.value = builtIn.name;
  promptInput.value = builtIn.prompt;
  updatePromptCount();
  syncEditorToPreset(false);
  renderPresetLibrary();
  saveHint.textContent = "已恢复内置提示词，记得保存设置";
});

newPresetButton.addEventListener("click", () => {
  syncEditorToPreset(false);
  const preset = {
    id: crypto.randomUUID(),
    name: "新翻译方案",
    prompt: "",
    builtIn: false,
  };
  workingPresets.push(preset);
  selectPreset(preset.id);
  presetNameInput.select();
  saveHint.textContent = "已新建方案，请填写并保存";
});

savePresetButton.addEventListener("click", () => {
  if (!syncEditorToPreset(true)) return;
  renderPresetLibrary();
  renderDefaultPresetOptions();
  showToast("方案已保存到列表，记得保存设置");
});

deletePresetButton.addEventListener("click", () => {
  const preset = workingPresets.find((item) => item.id === selectedPresetId);
  if (!preset || preset.builtIn) return;
  if (!confirm(`确定删除“${preset.name}”吗？`)) return;

  workingPresets = workingPresets.filter((item) => item.id !== preset.id);
  if (defaultPresetSelect.value === preset.id) {
    defaultPresetSelect.value = "all-to-zh";
  }
  selectPreset(workingPresets[0]?.id || "all-to-zh");
  renderDefaultPresetOptions();
  saveHint.textContent = "方案已删除，记得保存设置";
});

defaultPresetSelect.addEventListener("change", () => {
  syncEditorToPreset(false);
  selectPreset(defaultPresetSelect.value);
  saveHint.textContent = "默认翻译方案已修改，记得保存";
});

presetList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-preset-id]");
  if (!button) return;
  syncEditorToPreset(false);
  selectPreset(button.dataset.presetId);
});

resetImagePromptButton.addEventListener("click", () => {
  imagePromptInput.value = DEFAULT_SETTINGS.imagePrompt;
  saveHint.textContent = "已恢复默认截图提示词，记得保存";
});


async function initialize() {
  const { settings } = await chrome.storage.local.get("settings");
  savedSettings = normalizeSettings(settings);
  workingPresets = savedSettings.promptPresets.map((item) => ({ ...item }));
  ProviderEditor.initialize(savedSettings);
  imagePromptInput.value = savedSettings.imagePrompt;
  selectedPresetId = savedSettings.defaultPresetId;
  renderDefaultPresetOptions();
  selectPreset(selectedPresetId);
  saveHint.textContent = "设置已载入";
  await refreshShortcutDisplay();
}


function currentSettings() {
  const defaultPreset =
    workingPresets.find((item) => item.id === defaultPresetSelect.value) ||
    workingPresets[0];
  return {
    ...ProviderEditor.read(),
    systemPrompt: defaultPreset.prompt,
    promptPresets: workingPresets.map((item) => ({ ...item })),
    defaultPresetId: defaultPreset.id,
    imagePrompt: imagePromptInput.value.trim(),
  };
}


function updatePromptCount() {
  promptCount.textContent = `${promptInput.value.length} 字`;
}

function selectPreset(presetId) {
  const preset =
    workingPresets.find((item) => item.id === presetId) || workingPresets[0];
  if (!preset) return;

  selectedPresetId = preset.id;
  presetNameInput.value = preset.name;
  promptInput.value = preset.prompt;
  resetButton.disabled = !preset.builtIn;
  deletePresetButton.disabled = preset.builtIn;
  updatePromptCount();
  renderPresetLibrary();
}

function syncEditorToPreset(validate) {
  const preset = workingPresets.find((item) => item.id === selectedPresetId);
  if (!preset) return false;
  const name = presetNameInput.value.trim();
  const prompt = promptInput.value.trim();
  if (validate && (!name || !prompt)) {
    showToast("方案名称和翻译提示词不能为空", true);
    return false;
  }
  preset.name = name || preset.name;
  preset.prompt = prompt;
  return true;
}

function renderPresetLibrary() {
  presetList.replaceChildren(
    ...workingPresets.map((preset) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `preset-item${
        preset.id === selectedPresetId ? " active" : ""
      }`;
      button.dataset.presetId = preset.id;

      const name = document.createElement("span");
      name.className = "preset-item-name";
      name.textContent = preset.name;
      button.append(name);

      if (preset.builtIn) {
        const badge = document.createElement("span");
        badge.className = "preset-item-badge";
        badge.textContent = "内置";
        button.append(badge);
      }
      return button;
    }),
  );
}

function renderDefaultPresetOptions() {
  const selected = defaultPresetSelect.value || savedSettings.defaultPresetId;
  defaultPresetSelect.replaceChildren(
    ...workingPresets.map(
      (preset) =>
        new Option(
          preset.name,
          preset.id,
          false,
          preset.id === selected,
        ),
    ),
  );
  if (!defaultPresetSelect.value && workingPresets.length) {
    defaultPresetSelect.value = workingPresets[0].id;
  }
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
      (item) => !BUILT_IN_PROMPT_PRESETS.some((builtIn) => builtIn.id === item.id),
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
    promptPresets: presets,
    defaultPresetId: activePreset.id,
    systemPrompt: activePreset.prompt,
  };
}

async function refreshShortcutDisplay() {
  const commands = await chrome.commands.getAll();
  const textCommand = commands.find(
    (item) => item.name === "translate-selection",
  );
  const captureCommand = commands.find(
    (item) => item.name === "capture-and-translate",
  );
  renderShortcut(textShortcutKeys, textCommand?.shortcut || "");
  renderShortcut(captureShortcutKeys, captureCommand?.shortcut || "");
}

function renderShortcut(container, shortcut) {
  container.replaceChildren();
  container.classList.toggle("unassigned", !shortcut);
  if (!shortcut) {
    container.textContent = "未分配快捷键";
    return;
  }

  const parts = shortcut.split("+");
  parts.forEach((part, index) => {
    if (index) {
      const separator = document.createElement("span");
      separator.textContent = "+";
      container.append(separator);
    }
    const key = document.createElement("kbd");
    key.textContent = part;
    container.append(key);
  });
  container.setAttribute("aria-label", shortcut);
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast${isError ? " error" : ""}`;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

void initialize();
