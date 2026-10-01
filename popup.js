const historyList = document.querySelector("#historyList");
const emptyState = document.querySelector("#emptyState");
const historyCount = document.querySelector("#historyCount");
const clearButton = document.querySelector("#clearHistory");
const toast = document.querySelector("#toast");
const shortcutInstruction = document.querySelector("#shortcutInstruction");

document.querySelector("#openSettings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

clearButton.addEventListener("click", async () => {
  const { history = [] } = await chrome.storage.local.get("history");
  if (!history.length) return;
  if (!confirm(`确定删除全部 ${history.length} 条翻译记录吗？`)) return;
  await chrome.storage.local.set({ history: [] });
  await renderHistory();
});

historyList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest("[data-id]");
  if (!card) return;

  if (button.dataset.action === "copy") {
    await navigator.clipboard.writeText(button.dataset.value || "");
    showToast("译文已复制");
    return;
  }

  if (button.dataset.action === "delete") {
    const { history = [] } = await chrome.storage.local.get("history");
    await chrome.storage.local.set({
      history: history.filter((entry) => entry.id !== card.dataset.id),
    });
    await renderHistory();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.history) void renderHistory();
});

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  historyList.replaceChildren(...history.map(createHistoryCard));
  historyCount.textContent = `${history.length} 条记录`;
  emptyState.hidden = history.length > 0;
  clearButton.hidden = history.length === 0;
}

async function renderShortcutInstruction() {
  const commands = await chrome.commands.getAll();
  const textCommand = commands.find(
    (item) => item.name === "translate-selection",
  );
  const captureCommand = commands.find(
    (item) => item.name === "capture-and-translate",
  );
  shortcutInstruction.replaceChildren();

  appendShortcutLine(
    shortcutInstruction,
    "文本框选",
    textCommand?.shortcut || "",
  );
  shortcutInstruction.append(document.createElement("br"));
  appendShortcutLine(
    shortcutInstruction,
    "截图识别",
    captureCommand?.shortcut || "",
  );
}

function appendShortcutLine(container, label, shortcut) {
  container.append(`${label}：`);
  if (!shortcut) {
    const warning = document.createElement("span");
    warning.className = "unassigned-shortcut";
    warning.textContent = "未设置";
    container.append(warning);
    return;
  }
  shortcut.split("+").forEach((part, index) => {
    if (index) container.append(" + ");
    const key = document.createElement("kbd");
    key.textContent = part;
    container.append(key);
  });
}

function createHistoryCard(entry) {
  const card = document.createElement("article");
  card.className = "history-card";
  card.dataset.id = entry.id;

  const meta = document.createElement("div");
  meta.className = "history-meta";

  const time = document.createElement("time");
  time.textContent = formatTime(entry.createdAt);
  const separator = document.createElement("span");
  separator.textContent = "·";
  const model = document.createElement("span");
  model.className = "history-model";
  model.textContent = entry.model || "未知模型";
  model.title = [entry.providerName, entry.model, entry.fallback ? "自动切换" : "", entry.primaryError].filter(Boolean).join(" · ");

  const preset = document.createElement("span");
  preset.className = "history-preset";
  preset.textContent =
    entry.kind === "image" ? "截图识别" : entry.presetName || "";
  preset.title = preset.textContent;

  const actions = document.createElement("div");
  actions.className = "history-actions";
  actions.append(
    makeActionButton("copy", "复制译文", "⧉", entry.translatedText),
    makeActionButton("delete", "删除记录", "×"),
  );
  actions.lastElementChild.classList.add("delete");
  meta.append(time, separator, model);
  if (preset.textContent) {
    const presetSeparator = document.createElement("span");
    presetSeparator.textContent = "·";
    meta.append(presetSeparator, preset);
  }
  meta.append(actions);

  const source = document.createElement("p");
  source.className = "source-text";
  source.textContent = entry.sourceText;
  source.title = entry.sourceText;

  const translated = document.createElement("p");
  translated.className = "translated-text";
  translated.textContent = entry.translatedText;
  translated.title = entry.translatedText;

  card.append(meta, source, translated);
  return card;
}

function makeActionButton(action, label, symbol, value = "") {
  const button = document.createElement("button");
  button.className = "mini-button";
  button.dataset.action = action;
  button.dataset.value = value;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = symbol;
  return button;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat("zh-CN", {
    month: sameDay ? undefined : "numeric",
    day: sameDay ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 1500);
}

void renderHistory();
void renderShortcutInstruction();
