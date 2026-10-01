(() => {
  const $ = id => document.getElementById(id);
  const fields = { name: $("providerName"), type: $("providerType"), baseUrl: $("baseUrl"), apiKey: $("apiKey"), model: $("model"), protocol: $("providerProtocol") };
  let config = LingoProviders.normalize();
  let selected = "first";
  let viewRevision = 0;
  const caches = new Map();
  const catalogs = new Map();
  const catalogKey = p => `${p.id}:${p.type}:${p.baseUrl}`;
  function dirty() { $("saveHint").textContent = "有未保存的修改"; }
  function flush() {
    Object.assign(config.providers.find(p => p.id === selected), Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value.trim()])));
    updateLabels();
  }
  function updateLabels() {
    for (const id of ["providerSlot", "primaryProvider", "backupProvider"]) {
      for (const option of $(id).options) {
        const provider = config.providers.find(p => p.id === option.value);
        if (provider) option.textContent = provider.name || "未命名方案";
      }
    }
  }
  function renderSelectors() {
    $("providerSlot").replaceChildren(...config.providers.map(p => new Option(p.name, p.id)));
    $("primaryProvider").replaceChildren(...config.providers.map(p => new Option(p.name, p.id)));
    $("backupProvider").replaceChildren(new Option("不使用备用方案", ""), ...config.providers.filter(p => p.id !== config.primaryProviderId).map(p => new Option(p.name, p.id)));
    $("providerSlot").value = selected;
    $("primaryProvider").value = config.primaryProviderId;
    $("backupProvider").value = config.backupProviderId;
    $("deleteProvider").disabled = config.providers.length <= 1;
  }
  function renderModels(ids = []) {
    $("availableModels").replaceChildren(new Option(ids.length ? "选择模型" : "刷新模型列表", ""), ...ids.map(id => new Option(id, id)));
    $("availableModels").value = ids.includes(fields.model.value) ? fields.model.value : "";
  }
  $("availableModels").addEventListener("change", () => {
    if (!$("availableModels").value) return;
    fields.model.value = $("availableModels").value;
    flush(); dirty();
  });
  fields.model.addEventListener("input", () => { renderModels(catalogs.get(catalogKey(current())) || []); dirty(); });
  $("primaryProvider").addEventListener("change", () => {
    config.primaryProviderId = $("primaryProvider").value;
    if (config.backupProviderId === config.primaryProviderId) config.backupProviderId = "";
    renderSelectors(); dirty();
  });
  $("backupProvider").addEventListener("change", () => { config.backupProviderId = $("backupProvider").value; dirty(); });
  $("addProvider").addEventListener("click", () => {
    flush();
    const p = { ...LingoProviders.defaults[1], id: crypto.randomUUID(), name: "新连接方案", apiKey: "", model: "" };
    config.providers.push(p); selected = p.id;
    renderSelectors(); display(); dirty();
  });
  $("deleteProvider").addEventListener("click", () => {
    if (config.providers.length <= 1 || !confirm("删除当前连接方案？点击底部保存设置后生效；不会退出订阅账号。")) return;
    flush();
    const removed = selected;
    config.providers = config.providers.filter(p => p.id !== removed);
    if (config.primaryProviderId === removed) config.primaryProviderId = config.providers[0].id;
    if (config.backupProviderId === removed || config.backupProviderId === config.primaryProviderId) config.backupProviderId = "";
    if (!config.backupProviderId) $("autoFallback").checked = false;
    selected = config.primaryProviderId;
    renderSelectors(); display(); dirty();
  });
  $("saveProvider").addEventListener("click", async () => {
    const button = $("saveProvider"); button.disabled = true;
    try {
      const provider = current();
      if (!provider.name) throw new Error("请填写方案名称");
      LingoProviders.validate(provider);
      await authorize([provider]);
      const { settings = {} } = await chrome.storage.local.get("settings");
      const stored = LingoProviders.normalize(settings);
      const index = stored.providers.findIndex(p => p.id === provider.id);
      if (index >= 0) stored.providers[index] = provider;
      else stored.providers.push(provider);
      await chrome.storage.local.set({ settings: { ...settings, ...stored } });
      $("saveHint").textContent = `“${provider.name}”已保存，其它修改待保存`;
    } catch (error) { $("saveHint").textContent = error.message; }
    finally { button.disabled = false; }
  });
  function current() { flush(); return { ...config.providers.find(p => p.id === selected) }; }
  function display() {
    viewRevision++;
    updateLabels();
    const p = config.providers.find(p => p.id === selected);
    for (const [key, el] of Object.entries(fields)) el.value = p[key];
    $("codexAuth").hidden = p.type !== "codex";
    $("protocolField").hidden = p.type === "codex";
    $("baseUrlField").hidden = p.type === "codex";
    $("apiKeyField").hidden = p.type === "codex";
    $("connectionBadge").textContent = "未检测";
    $("connectionBadge").className = "connection-badge";
    renderModels(catalogs.get(catalogKey(p)) || []);
    $("modelHelp").textContent = "";
    $("authStatus").textContent = "读取登录状态…";
    $("codexLogin").textContent = "登录 ChatGPT / Codex";
    $("codexLogout").disabled = true;
    $("codexLoginHelp").open = false;
    $("codexDevicePanel").hidden = true;
    if (p.type === "codex" && globalThis.chrome?.runtime?.sendMessage) void auth("status", $("codexStatus"));
  }
  fields.name.addEventListener("input", flush);
  $("providerSlot").addEventListener("change", () => { flush(); selected = $("providerSlot").value; display(); });
  fields.type.addEventListener("change", () => {
    const p = config.providers.find(p => p.id === selected);
    // Remember settings for each type when switching back and forth.
    caches.set(`${selected}:${p.type}`, { ...p, ...Object.fromEntries(Object.entries(fields).filter(([k]) => k !== "type").map(([k, el]) => [k, el.value])) });
    const type = fields.type.value;
    Object.assign(p, caches.get(`${selected}:${type}`) || {
      type, name: type === "codex" ? "Codex 订阅" : type === "local" ? "本地 LM Studio" : "在线模型",
      baseUrl: type === "codex" ? "" : type === "local" ? "http://127.0.0.1:1234/v1" : "https://api.openai.com/v1",
      model: "", apiKey: "", protocol: "chat",
    });
    display();
  });
  function read() {
    flush();
    return { providers: config.providers.map(p => ({ ...p })), primaryProviderId: $("primaryProvider").value,
      backupProviderId: $("backupProvider").value, autoFallback: $("autoFallback").checked };
  }
  function validate(settings) {
    const primary = settings.providers.find(p => p.id === settings.primaryProviderId);
    LingoProviders.validate(primary);
    if (settings.autoFallback) {
      const backup = settings.providers.find(p => p.id === settings.backupProviderId);
      if (!backup || backup.id === primary.id) throw new Error("请选择与优先方案不同的备用方案");
      LingoProviders.validate(backup);
    }
  }
  // Call synchronously from the user click to preserve Chrome's permission gesture.
  function authorize(providers) {
    const origins = [...new Set(providers.flatMap(p => {
      if (p.type === "codex") return ["https://auth.openai.com/*", "https://chatgpt.com/*"];
      if (!p.baseUrl) return [];
      LingoProviders.validate(p, false);
      const u = new URL(p.baseUrl);
      return `${u.protocol}//${u.hostname}/*`;
    }))];
    if (!origins.length) return Promise.resolve();
    return chrome.permissions.request({ origins }).then(ok => { if (!ok) throw new Error("未授予服务地址访问权限"); });
  }
  async function models(button, requestPermission = true) {
    const provider = current();
    const revision = viewRevision;
    button.disabled = true;
    try {
      if (requestPermission) await authorize([provider]);
      const response = await chrome.runtime.sendMessage({ type: "GET_MODELS", provider });
      if (!response?.ok) throw new Error(response?.error || "连接失败");
      if (revision !== viewRevision || selected !== provider.id || fields.baseUrl.value !== provider.baseUrl || fields.apiKey.value !== provider.apiKey) return;
      catalogs.set(catalogKey(provider), response.models);
      if (!fields.model.value && response.models.length) {
        fields.model.value = response.models[0];
        $("saveHint").textContent = "模型已选择，待保存";
      }
      renderModels(response.models);
      $("modelHelp").textContent = `${response.models.length} 个模型`;
      $("connectionBadge").className = "connection-badge online";
      $("connectionBadge").textContent = "已连接";
    } catch (error) {
      if (revision !== viewRevision) return;
      $("modelHelp").textContent = error.message; $("connectionBadge").textContent = "连接失败";
    }
    finally { button.disabled = false; }
  }
  for (const id of ["refreshModels", "testConnection"]) $(id).addEventListener("click", event => void models(event.currentTarget));
  async function auth(action, button) {
    const provider = current();
    const revision = viewRevision;
    let completedLogout = false;
    if (provider.type !== "codex") return;
    if (action === "logout" && !confirm("清除本插件保存的订阅凭据并停止等待登录？不会退出 ChatGPT 网站或撤销服务端授权。")) return;
    button.disabled = true;
    try {
      if (action === "login") await authorize([provider]);
      const response = await chrome.runtime.sendMessage({ type: "CODEX_AUTH", action, provider });
      if (!response?.ok) throw new Error(response?.error || "授权请求失败");
      if (revision !== viewRevision) return;
      completedLogout = action === "logout";
      $("codexLoginHelp").open = false;
      const result = response.result;
      const pending = result.loginPending;
      $("codexDevicePanel").hidden = !pending;
      $("codexDeviceCode").textContent = result.userCode || "正在申请…";
      $("copyDeviceCode").disabled = !result.userCode;
      $("copyDeviceCode").textContent = "复制设备码";
      $("codexDeviceExpiry").textContent = pending && result.expiresAt
        ? `有效期至 ${new Date(result.expiresAt).toLocaleTimeString()}` : "";
      {
        const signedIn = result.authenticated;
        $("codexLogout").disabled = !signedIn;
        $("codexLogin").textContent = signedIn ? "更换账号" : "登录 ChatGPT / Codex";
        $("authStatus").textContent = signedIn
          ? `已登录${result.planType ? ` · ${result.planType}` : ""}${pending ? " · 等待新账号授权" : ""}`
          : pending ? "请在授权页输入设备码" : "尚未登录";
        if (result.error) { $("authStatus").textContent += ` ${result.error}`; $("codexLoginHelp").open = true; }
        if (signedIn && !pending) await models($("refreshModels"), false);
        else {
          renderModels();
          $("connectionBadge").textContent = "尚未登录";
          $("connectionBadge").className = "connection-badge";
        }
      }
      if (action === "login" && pending) {
        if (result.authUrl !== "https://auth.openai.com/codex/device") throw new Error("授权地址不是预期的官方设备码页面");
        await chrome.tabs.create({ url: result.authUrl });
      }
    } catch (error) {
      if (revision !== viewRevision) return;
      $("authStatus").textContent = error.message;
      $("codexLoginHelp").open = true;
    }
    finally { if (!completedLogout) button.disabled = false; }
  }
  $("copyDeviceCode").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("codexDeviceCode").textContent); $("copyDeviceCode").textContent = "已复制"; }
    catch { $("authStatus").textContent = "复制失败，请手动复制上方设备码。"; }
  });
  globalThis.chrome?.runtime?.onMessage?.addListener(message => {
    if (message?.type !== "LINGO_CODEX_AUTH_CHANGED" || fields.type.value !== "codex") return;
    void auth("status", $("codexStatus"));
  });
  for (const [id, action] of [["codexLogin", "login"], ["codexStatus", "status"], ["codexLogout", "logout"], ["codexCancel", "cancel"]]) {
    $(id).addEventListener("click", event => void auth(action, event.currentTarget));
  }
  globalThis.ProviderEditor = {
    read, validate, authorize,
    initialize(settings) {
      config = LingoProviders.normalize(settings); selected = config.primaryProviderId; caches.clear(); catalogs.clear();
      $("autoFallback").checked = config.autoFallback;
      renderSelectors(); display();
    },
  };
})();
