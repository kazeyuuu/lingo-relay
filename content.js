(() => {
  const CLIENT_BUILD = "fresh-ui-v1";
  if (window.__LINGO_LOCAL_CLIENT_BUILD__ === CLIENT_BUILD) return;
  window.__LINGO_LOCAL_CLIENT_BUILD__ = CLIENT_BUILD;
  document.querySelector("#lingo-local-panel")?.remove();
  document.querySelector("#lingo-capture-overlay")?.remove();

  let lastContextPoint = { x: window.innerWidth / 2, y: window.innerHeight / 3 };
  let panel = null;
  let currentEntry = null;

  document.addEventListener(
    "contextmenu",
    (event) => {
      lastContextPoint = { x: event.clientX, y: event.clientY };
    },
    true,
  );

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LINGO_PING") {
      sendResponse({ ready: true, build: CLIENT_BUILD });
      return false;
    }
    if (message?.type === "LINGO_CAPTURE_START") {
      startCaptureOverlay();
      return false;
    }
    if (message?.type === "LINGO_TRANSLATION_START") {
      if (
        Number.isFinite(message.anchor?.x) &&
        Number.isFinite(message.anchor?.y)
      ) {
        lastContextPoint = message.anchor;
      }
      renderPanel({
        state: "loading",
        sourceText: message.sourceText,
      });
    }
    if (message?.type === "LINGO_TRANSLATION_SUCCESS") {
      renderPanel({
        state: "success",
        sourceText: message.entry.sourceText,
        translatedText: message.entry.translatedText,
        entry: message.entry,
      });
    }
    if (message?.type === "LINGO_TRANSLATION_FALLBACK" && panel && panel.dataset.state === "loading") {
      panel.querySelector("[data-status]").textContent = `主方案失败，正在使用备用方案 · ${message.backupName}`;
      const warning = panel.querySelector("[data-warning]");
      warning.textContent = message.primaryError;
      warning.hidden = false;
      panel.querySelector("[data-result]").textContent = "已切换，正在等待备用模型响应…";
      positionPanel();
    }
    if (message?.type === "LINGO_TRANSLATION_ERROR") {
      renderPanel({
        state: "error",
        error: message.error,
        showSettings: message.showSettings,
      });
    }
    return false;
  });

  function renderPanel(data) {
    if (!panel) panel = createPanel();
    const source = panel.querySelector("[data-source]");
    const result = panel.querySelector("[data-result]");
    const status = panel.querySelector("[data-status]");
    const loader = panel.querySelector("[data-loader]");
    const copy = panel.querySelector("[data-copy]");
    const settings = panel.querySelector("[data-settings]");
    const alternatives = panel.querySelector("[data-alternatives]");
    const presetMenu = panel.querySelector("[data-preset-menu]");
    const warning = panel.querySelector("[data-warning]");
    warning.textContent = data.entry?.primaryError || "";
    warning.hidden = !data.entry?.primaryError;

    panel.dataset.state = data.state;
    loader.hidden = data.state !== "loading";
    copy.hidden = data.state !== "success";
    settings.hidden = data.state !== "error" || data.showSettings === false;
    presetMenu.hidden = true;
    alternatives.hidden =
      data.state !== "success" || data.entry?.kind === "image";

    if (data.state === "loading") {
      status.textContent = "正在翻译…";
      source.textContent = data.sourceText;
      source.hidden = false;
      result.textContent = "正在等待模型响应…";
    } else if (data.state === "success") {
      currentEntry = data.entry;
      status.textContent = `${data.entry?.fallback ? "已自动切换 · " : ""}${data.entry?.providerName || "翻译完成"}`;
      source.textContent = data.sourceText;
      source.hidden = false;
      result.textContent = data.translatedText;
      copy.dataset.value = data.translatedText;
    } else {
      currentEntry = null;
      status.textContent = "翻译失败";
      source.hidden = true;
      result.textContent = data.error || "发生未知错误";
    }

    panel.hidden = false;
    positionPanel();
  }

  function createPanel() {
    const root = document.createElement("section");
    root.id = "lingo-local-panel";
    root.hidden = true;
    root.innerHTML = `
      <div class="lingo-panel-head">
        <div class="lingo-brand-mark" aria-hidden="true">L</div>
        <div class="lingo-status-wrap">
          <strong>LingoRelay</strong>
          <span data-status></span>
        </div>
        <span class="lingo-loader" data-loader hidden></span>
        <button class="lingo-icon-button" data-close aria-label="关闭">×</button>
      </div>
      <div class="lingo-panel-body">
        <p class="lingo-warning" data-warning hidden></p>
        <p class="lingo-source" data-source></p>
        <div class="lingo-divider"></div>
        <div class="lingo-result" data-result></div>
      </div>
      <div class="lingo-panel-actions">
        <div class="lingo-preset-menu" data-preset-menu hidden></div>
        <button class="lingo-text-button" data-settings hidden>打开设置</button>
        <button class="lingo-alternative-button" data-alternatives hidden>
          其它方案⌄
        </button>
        <button class="lingo-copy-button" data-copy hidden>
          <span aria-hidden="true">⧉</span> 复制译文
        </button>
      </div>
    `;

    root.querySelector("[data-close]").addEventListener("click", () => {
      root.hidden = true;
    });
    root.querySelector("[data-settings]").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
    });
    root
      .querySelector("[data-alternatives]")
      .addEventListener("click", () => void togglePresetMenu(root));
    root.querySelector("[data-copy]").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(button.dataset.value || "");
        button.textContent = "✓ 已复制";
        setTimeout(() => {
          button.innerHTML = '<span aria-hidden="true">⧉</span> 复制译文';
        }, 1400);
      } catch {
        button.textContent = "复制失败";
      }
    });

    document.documentElement.appendChild(root);
    return root;
  }

  async function togglePresetMenu(root) {
    const menu = root.querySelector("[data-preset-menu]");
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }

    menu.replaceChildren();
    const loading = document.createElement("span");
    loading.className = "lingo-preset-menu-loading";
    loading.textContent = "读取方案…";
    menu.append(loading);
    menu.hidden = false;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "GET_PROMPT_PRESETS",
      });
      if (!response?.ok) throw new Error(response?.error || "无法读取方案");
      menu.replaceChildren(
        ...response.presets.map((preset) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "lingo-preset-option";
          if (preset.id === currentEntry?.presetId) {
            button.classList.add("active");
          }
          button.textContent = preset.name;
          button.addEventListener("click", () => {
            if (!currentEntry?.sourceText) return;
            menu.hidden = true;
            chrome.runtime.sendMessage({
              type: "LINGO_RETRANSLATE",
              sourceText: currentEntry.sourceText,
              presetId: preset.id,
            });
          });
          return button;
        }),
      );
    } catch (error) {
      loading.textContent = error.message || "读取失败";
    }
  }

  function startCaptureOverlay() {
    document.querySelector("#lingo-capture-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "lingo-capture-overlay";
    overlay.innerHTML = `
      <div class="lingo-capture-tip">
        <span class="lingo-capture-crosshair" aria-hidden="true">＋</span>
        拖动框选要识别的区域
        <kbd>Esc</kbd>
        取消
      </div>
      <div class="lingo-capture-box" data-capture-box hidden>
        <span data-capture-size></span>
      </div>
    `;

    const box = overlay.querySelector("[data-capture-box]");
    const sizeLabel = overlay.querySelector("[data-capture-size]");
    let start = null;
    let current = null;

    const onKeyDown = (event) => {
      if (event.key === "Escape") cleanup();
    };

    const cleanup = () => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
    };

    overlay.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      start = { x: event.clientX, y: event.clientY };
      current = start;
      box.hidden = false;
      overlay.setPointerCapture(event.pointerId);
      updateCaptureBox();
    });

    overlay.addEventListener("pointermove", (event) => {
      if (!start) return;
      current = { x: event.clientX, y: event.clientY };
      updateCaptureBox();
    });

    overlay.addEventListener("pointerup", (event) => {
      if (!start || event.button !== 0) return;
      current = { x: event.clientX, y: event.clientY };
      const region = normalizedRegion(start, current);
      cleanup();

      if (region.width < 8 || region.height < 8) return;
      chrome.runtime.sendMessage({
        type: "LINGO_CAPTURE_REGION",
        region: {
          ...region,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        },
      });
    });

    function updateCaptureBox() {
      const region = normalizedRegion(start, current);
      box.style.left = `${region.x}px`;
      box.style.top = `${region.y}px`;
      box.style.width = `${region.width}px`;
      box.style.height = `${region.height}px`;
      sizeLabel.textContent = `${Math.round(region.width)} × ${Math.round(region.height)}`;
    }

    document.addEventListener("keydown", onKeyDown, true);
    document.documentElement.appendChild(overlay);
  }

  function normalizedRegion(start, end) {
    return {
      x: Math.max(0, Math.min(start.x, end.x)),
      y: Math.max(0, Math.min(start.y, end.y)),
      width: Math.min(window.innerWidth, Math.abs(end.x - start.x)),
      height: Math.min(window.innerHeight, Math.abs(end.y - start.y)),
    };
  }

  function positionPanel() {
    if (!panel) return;
    const margin = 14;
    const width = Math.min(420, window.innerWidth - margin * 2);
    panel.style.width = `${width}px`;

    const rect = panel.getBoundingClientRect();
    let left = lastContextPoint.x + 12;
    let top = lastContextPoint.y + 12;
    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, lastContextPoint.x - width - 12);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    panel.style.left = `${Math.max(margin, left)}px`;
    panel.style.top = `${Math.max(margin, top)}px`;
  }

  window.addEventListener("resize", positionPanel);
})();
