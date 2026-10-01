/* Shared by the options page and the service worker. No credentials go to content scripts. */
(() => {
  const defaults = [
    { id: "first", name: "本地 LM Studio", type: "local", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "", model: "", protocol: "chat" },
    { id: "second", name: "在线模型", type: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "", protocol: "chat" },
  ];
  function normalize(settings = {}) {
    const entries = Array.isArray(settings.providers) && settings.providers.length ? settings.providers
      : [{ ...defaults[0], baseUrl: settings.baseUrl || defaults[0].baseUrl, model: settings.model || "" }, defaults[1]];
    const ids = new Set();
    const providers = entries.map((input, index) => {
      let id = typeof input.id === "string" && input.id ? input.id : defaults[index]?.id || `connection-${index + 1}`;
      while (ids.has(id)) id += "-copy";
      ids.add(id);
      const provider = { ...defaults[index === 0 ? 0 : 1], ...input, id };
      // Subscription transport uses fixed official endpoints, never an old bridge/key.
      if (provider.type === "codex") Object.assign(provider, { baseUrl: "", apiKey: "", protocol: "chat" });
      return provider;
    });
    const primaryProviderId = ids.has(settings.primaryProviderId) ? settings.primaryProviderId : providers[0].id;
    const backupProviderId = settings.backupProviderId === undefined
      ? providers.find(p => p.id !== primaryProviderId)?.id || ""
      : ids.has(settings.backupProviderId) && settings.backupProviderId !== primaryProviderId ? settings.backupProviderId : "";
    return { providers, primaryProviderId, backupProviderId, autoFallback: settings.autoFallback === true };
  }
  function url(baseUrl, path) {
    const parsed = new URL(baseUrl.trim());
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("服务地址必须是无用户名、密码、查询参数的 HTTP(S) API 基础地址");
    }
    // Root URLs get /v1; explicit gateway paths are preserved (e.g. /api/v4).
    const prefix = parsed.pathname.replace(/\/+$/, "") || "/v1";
    return `${parsed.origin}${prefix}/${path}`;
  }
  function validate(provider, requireModel = true) {
    if (!provider || !["local", "openai", "codex"].includes(provider.type)) throw new Error("请选择有效的服务类型");
    if (provider.type !== "codex") url(provider.baseUrl, "models");
    if (requireModel && !provider.model?.trim()) throw new Error(`${provider.name}：请先选择或填写模型 ID`);
  }
  globalThis.LingoProviders = { defaults, normalize, url, validate };
})();
