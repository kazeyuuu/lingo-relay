/* Runs only in the service worker (and isolated regression tests). */
(() => {
  class ServiceError extends Error {
    constructor(message, offline = false) { super(message); this.offline = offline; }
  }
  async function json(provider, path, { body, timeout = 0, signal } = {}) {
    LingoProviders.validate(provider, false);
    if (provider.type === "codex") return LingoSubscription.request(path, body, timeout, signal);
    const endpoint = LingoProviders.url(provider.baseUrl, path);
    const origin = new URL(endpoint);
    if (globalThis.chrome?.permissions) {
      const allowed = await chrome.permissions.contains({ origins: [`${origin.protocol}//${origin.hostname}/*`] });
      if (!allowed) throw new ServiceError(`${provider.name}：尚未授权访问该地址，请在设置页保存或测试连接`);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;
    try {
      const headers = { Accept: body?.stream ? "text/event-stream, application/json" : "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (provider.apiKey?.trim()) headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
      let response;
      try {
        response = await fetch(endpoint, { method: body === undefined ? "GET" : "POST", headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: "error" });
      } catch {
        throw new ServiceError(`${provider.name}：连接失败或等待响应超时`, true);
      }
      if (!response.ok) {
        // Avoid reflecting arbitrary remote errors (which can contain keys or submitted text).
        const hints = { 400: "输入或模型参数不被接受（可能超过上下文限制）", 401: "凭据无效或授权已过期", 403: "没有访问权限", 404: "接口路径或模型不存在", 413: "输入内容过长", 429: "额度不足或请求过于频繁", 504: "服务网关等待模型响应超时" };
        throw new ServiceError(`${provider.name}：HTTP ${response.status}，${hints[response.status] || "服务返回错误"}`, true);
      }
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const text = await LingoStream.read(response, path === "responses" ? "responses" : "chat");
        return path === "responses" ? { output_text: text } : { choices: [{ message: { content: text } }] };
      }
      try {
        const payload = await response.json();
        if (payload.error || ["failed", "incomplete"].includes(payload.status)) throw new ServiceError("服务返回生成错误或未完整完成翻译", true);
        const reason = payload.choices?.[0]?.finish_reason;
        if (reason && reason !== "stop") throw new ServiceError("服务截断了译文（长度、内容或工具限制）", true);
        return payload;
      }
      catch (error) {
        if (error instanceof ServiceError) throw error;
        if (controller.signal.aborted) throw new ServiceError(`${provider.name}：等待完整响应超时`, true);
        throw new ServiceError(`${provider.name}：响应中断或不是有效 JSON，请检查接口协议`, true);
      }
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  async function models(provider, timeout = 15000) {
    const payload = await json(provider, "models", { timeout });
    if (!Array.isArray(payload.data)) throw new ServiceError("模型列表格式无效，应包含 data 数组");
    return [...new Set(payload.data.map(item => item.id).filter(id => typeof id === "string"))].sort();
  }
  async function generate(provider, system, text, image) {
    LingoProviders.validate(provider);
    const responses = provider.protocol === "responses" && provider.type !== "codex";
    let body;
    if (responses) {
      body = { model: provider.model, instructions: system, store: false, stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text }, ...(image ? [{ type: "input_image", image_url: image }] : [])] }] };
    } else {
      body = { model: provider.model, stream: true, messages: [
        { role: "system", content: system },
        { role: "user", content: image ? [{ type: "text", text }, { type: "image_url", image_url: { url: image } }] : text },
      ] };
    }
    const payload = await json(provider, responses ? "responses" : "chat/completions", { body, timeout: 0 });
    const content = responses
      ? (payload.output_text || (payload.output || []).filter(item => item.type === "message").flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text).join("\n"))
      : payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new ServiceError(`${provider.name}：未返回文字结果，请检查模型是否支持本次输入`, true);
    return content.trim();
  }
  async function translate(settings, system, text, image, onFallback) {
    const config = LingoProviders.normalize(settings);
    const primary = config.providers.find(p => p.id === config.primaryProviderId);
    const backup = config.providers.find(p => p.id === config.backupProviderId);
    LingoProviders.validate(primary);
    const canFallback = config.autoFallback && backup && backup.id !== primary.id;
    // Keep the MV3 worker active only while a translation is pending; this is not a deadline.
    const heartbeat = globalThis.chrome?.runtime?.getPlatformInfo
      ? setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000) : null;
    try {
      return { text: await generate(primary, system, text, image), provider: primary, fallback: false };
    } catch (error) {
      if (!canFallback || !error.offline) throw error;
      LingoProviders.validate(backup);
      const primaryError = `${primary.name} 失败：${error.message}`;
      try { await onFallback?.({ primaryError, backupName: backup.name }); } catch { /* UI notification must not prevent fallback. */ }
      try { return { text: await generate(backup, system, text, image), provider: backup, fallback: true, primaryError }; }
      catch (backupError) { throw new ServiceError(`${primaryError}\n已切换备用方案“${backup.name}”，但备用也失败：${backupError.message}`); }
    } finally { if (heartbeat !== null) clearInterval(heartbeat); }
  }
  globalThis.LingoClient = { json, models, translate };
})();
