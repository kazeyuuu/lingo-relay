/* Service-worker only. Experimental Codex device authorization, no native process.
 * Credentials are never returned over runtime messaging or included in history.
 */
(() => {
  const AUTH = "https://auth.openai.com";
  const API = "https://chatgpt.com/backend-api/codex";
  // Public OAuth client identifier, NOT a client secret or an API key.
  const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
  const ORIGINS = ["https://auth.openai.com/*", "https://chatgpt.com/*"];
  const KEY = "lingoSubscriptionAuth";
  const ALARM = "lingo-subscription-login";
  const VERIFY = `${AUTH}/codex/device`;
  const secureStorage = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  let queue = Promise.resolve(), pollFlight, refreshFlight, timer;
  const changed = () => { chrome.runtime.sendMessage({ type: "LINGO_CODEX_AUTH_CHANGED" }).catch(() => {}); };
  async function read() { await secureStorage; return (await chrome.storage.local.get(KEY))[KEY] || {}; }
  // Serialize all read-modify-writes. Network I/O deliberately stays outside this lock.
  function mutate(fn) {
    const operation = queue.then(async () => {
      const state = await read();
      const result = fn(state);
      await chrome.storage.local.set({ [KEY]: state });
      return result;
    });
    queue = operation.catch(() => {});
    return operation;
  }
  function failure(status, stage = "订阅服务") {
    const hints = { 400: "请求不被接受，请重新登录或检查模型", 401: "授权失效，请重新登录",
      403: "无访问权限；请检查账号、设备码登录开关或工作区限制", 404: "此接口或模型暂不可用",
      429: "订阅额度不足或请求过于频繁，请稍后重试" };
    const error = new Error(`${stage}：HTTP ${status}，${hints[status] || "服务暂时不可用"}`);
    error.status = status;
    error.offline = true;
    return error;
  }
  async function network(url, options, consume, timeout = 25000, signal) {
    if (!await chrome.permissions.contains({ origins: ORIGINS })) throw new Error("请点击登录或刷新模型，授予官方站点访问权限");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { signal.removeEventListener("abort", abort); throw Object.assign(new Error("请求已超时"), { offline: true }); }
    const timeoutId = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;
    try {
      let response;
      try { response = await fetch(url, { ...options, credentials: "omit", redirect: "error", signal: controller.signal }); }
      catch { throw Object.assign(new Error("无法连接官方订阅服务（网络、浏览器限制或超时）；请检查网络后重试"), { offline: true }); }
      try { return await consume(response); }
      catch (error) {
        if (controller.signal.aborted) throw Object.assign(new Error("订阅服务等待响应超时，请重试"), { offline: true });
        throw error;
      }
    } finally { clearTimeout(timeoutId); signal?.removeEventListener("abort", abort); }
  }
  async function parseJSON(response) {
    try { return await response.json(); }
    catch { throw new Error("官方服务返回了非预期响应，请稍后重试"); }
  }
  function postJSON(body) { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }
  async function tokens(form) {
    const payload = { client_id: CLIENT_ID, ...form };
    const options = form.grant_type === "refresh_token" ? postJSON(payload)
      : { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(payload).toString() };
    return network(`${AUTH}/oauth/token`, options, async response => {
      if (!response.ok) { const error = failure(response.status, "授权交换"); error.status = response.status; throw error; }
      return parseJSON(response);
    });
  }
  function claims(token) {
    // Metadata from the HTTPS token response only, not local proof of entitlement.
    // No imported JWTs, cookies, existing Codex files or user-supplied tokens accepted.
    try {
      const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), c => c.charCodeAt(0))));
    } catch { return {}; }
  }
  function credentials(payload, previous) {
    if (typeof payload.access_token !== "string" || !payload.access_token) throw new Error("授权未返回访问凭据，请重新登录");
    const access = claims(payload.access_token);
    const id = claims(payload.id_token || "");
    const info = { ...access["https://api.openai.com/auth"], ...id["https://api.openai.com/auth"] };
    const accountId = info.chatgpt_account_id || previous?.accountId;
    if (typeof accountId !== "string" || !accountId || /[\r\n]/.test(accountId)) throw new Error("授权缺少订阅账号信息，请重新登录");
    if (previous && accountId !== previous.accountId) throw new Error("刷新后的账号不一致，请重新登录");
    const refreshToken = payload.refresh_token || previous?.refreshToken;
    if (typeof refreshToken !== "string" || !refreshToken) throw new Error("授权缺少刷新凭据，请重新登录");
    const expiresAt = Number(payload.expires_in) > 0 ? Date.now() + Number(payload.expires_in) * 1000
      : Number(access.exp) > 0 ? Number(access.exp) * 1000 : Date.now() + 3600000;
    return { sessionId: previous?.sessionId || crypto.randomUUID(), accessToken: payload.access_token,
      refreshToken, accountId, planType: typeof info.chatgpt_plan_type === "string" ? info.chatgpt_plan_type : previous?.planType || "",
      expiresAt };
  }
  async function status() {
    const state = await read();
    const flow = state.flow;
    const pending = !!flow && flow.expiresAt > Date.now();
    return { authenticated: !!state.credentials, planType: state.credentials?.planType || "",
      loginPending: pending, userCode: pending ? flow.userCode || "" : "", authUrl: VERIFY,
      expiresAt: pending ? flow.expiresAt : null,
      error: state.error || (flow && !pending ? "设备码已过期，请重新登录" : "") };
  }
  async function schedule() {
    clearTimeout(timer);
    const { flow } = await read();
    if (!flow) { await chrome.alarms.clear(ALARM); return; }
    // Alarm survives worker suspension; short timer improves interactive latency.
    await chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    timer = setTimeout(() => void poll().catch(() => {}), Math.max(1000, (flow.nextPollAt || 0) - Date.now()));
  }
  async function login() {
    const id = crypto.randomUUID();
    await mutate(state => { state.flow = { id, expiresAt: Date.now() + 900000, nextPollAt: Date.now() + 30000 }; delete state.error; });
    try {
      const result = await network(`${AUTH}/api/accounts/deviceauth/usercode`, postJSON({ client_id: CLIENT_ID }), async response => {
        if (!response.ok) throw failure(response.status, "申请设备码");
        return parseJSON(response);
      });
      const userCode = result.user_code || result.usercode;
      if (typeof result.device_auth_id !== "string" || !result.device_auth_id || typeof userCode !== "string" || !userCode) {
        throw new Error("设备码响应无效，请重新登录");
      }
      const seconds = Number(result.interval);
      const interval = Math.max(5, Number.isFinite(seconds) ? seconds : 5) * 1000;
      await mutate(state => {
        if (state.flow?.id !== id) throw new Error("此次登录已取消");
        Object.assign(state.flow, { deviceAuthId: result.device_auth_id, userCode, interval, nextPollAt: Date.now() + interval });
      });
      await schedule();
      return status();
    } catch (error) {
      await mutate(state => { if (state.flow?.id === id) { delete state.flow; state.error = error.message; } });
      await schedule();
      throw error;
    }
  }
  async function finishFlow(id, error, credential) {
    const applied = await mutate(state => {
      if (state.flow?.id !== id) return false;
      delete state.flow;
      state.error = error || "";
      if (credential) state.credentials = credential;
      return true;
    });
    if (applied) changed();
  }
  async function pollOnce() {
    const { flow } = await read();
    if (!flow) return;
    if (Date.now() >= flow.expiresAt) { await finishFlow(flow.id, "设备码已过期，请重新登录"); return; }
    if (flow.exchanging) { await finishFlow(flow.id, "授权交换被中断，请重新登录"); return; }
    if (!flow.deviceAuthId) {
      if (Date.now() >= flow.nextPollAt) await finishFlow(flow.id, "设备码申请被中断，请重新登录");
      return;
    }
    if (Date.now() < flow.nextPollAt) return;
    // Persist before network so worker restart cannot cause rapid duplicate polling.
    await mutate(state => { if (state.flow?.id === flow.id) state.flow.nextPollAt = Date.now() + flow.interval; });
    let result;
    try {
      result = await network(`${AUTH}/api/accounts/deviceauth/token`, postJSON({ device_auth_id: flow.deviceAuthId, user_code: flow.userCode }), async response => {
        if ([403, 404].includes(response.status)) return null;
        if (response.status === 429 || response.status >= 500) {
          const header = response.headers.get("Retry-After");
          const retryMs = Number(header) > 0 ? Number(header) * 1000 : Date.parse(header) - Date.now();
          await mutate(state => { if (state.flow?.id === flow.id) state.flow.nextPollAt = Date.now() + Math.max(flow.interval, 30000, retryMs || 0); });
          return null;
        }
        if (!response.ok) throw failure(response.status, "等待授权");
        return parseJSON(response);
      });
    } catch (error) {
      if (error.status) { await finishFlow(flow.id, error.message); return; }
      // A temporary connection failure must not discard a valid device code.
      await mutate(state => { if (state.flow?.id === flow.id) state.flow.nextPollAt = Date.now() + Math.max(30000, flow.interval); });
      return;
    }
    if (!result) return;
    if (typeof result.authorization_code !== "string" || typeof result.code_verifier !== "string") {
      await finishFlow(flow.id, "设备授权响应无效，请重新登录"); return;
    }
    const proceed = await mutate(state => {
      if (state.flow?.id !== flow.id) return false;
      state.flow.exchanging = true;
      return true;
    });
    if (!proceed) return;
    try {
      const payload = await tokens({ grant_type: "authorization_code", code: result.authorization_code,
        code_verifier: result.code_verifier, redirect_uri: `${AUTH}/deviceauth/callback` });
      await finishFlow(flow.id, "", credentials(payload));
    } catch (error) { await finishFlow(flow.id, error.message); }
  }
  function poll() {
    if (!pollFlight) pollFlight = pollOnce().finally(async () => { pollFlight = null; await schedule(); });
    return pollFlight;
  }
  async function cancel(logout = false) {
    await mutate(state => { delete state.flow; delete state.error; if (logout) delete state.credentials; });
    await schedule();
    changed();
    return status();
  }
  async function authorizedCredential(forceFor) {
    const current = (await read()).credentials;
    if (!current) throw new Error("请先在设置中登录 ChatGPT / Codex 订阅");
    if (forceFor && forceFor.sessionId !== current.sessionId) throw new Error("账号已切换，请重新提交翻译");
    if (current.expiresAt > Date.now() + 60000 && (!forceFor || forceFor.accessToken !== current.accessToken)) return current;
    if (!refreshFlight) {
      refreshFlight = (async () => {
        try {
          const payload = await tokens({ grant_type: "refresh_token", refresh_token: current.refreshToken });
          const updated = credentials(payload, current);
          await mutate(state => {
            if (state.credentials?.sessionId !== current.sessionId) throw new Error("登录状态已改变，请重新提交");
            state.credentials = updated;
          });
          return updated;
        } catch (error) {
          if ([400, 401, 403].includes(error.status)) {
            await mutate(state => {
              if (state.credentials?.sessionId === current.sessionId) { delete state.credentials; state.error = "订阅授权已失效，请重新登录"; }
            });
            changed();
          }
          throw error;
        }
      })().finally(() => { refreshFlight = null; });
    }
    const updated = await refreshFlight;
    if (updated.sessionId !== current.sessionId) throw new Error("账号已切换，请重新提交");
    return updated;
  }
  async function api(path, body, consume, timeout, signal) {
    let credential = await authorizedCredential();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await network(`${API}/${path}`, {
        method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${credential.accessToken}`,
          "ChatGPT-Account-Id": credential.accountId, originator: "lingo_local_extension",
          Accept: body ? "text/event-stream" : "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }, async response => {
        if (response.status === 401 && attempt === 0) { await response.body?.cancel(); return { retry: true }; }
        if (!response.ok) throw failure(response.status);
        return { value: await consume(response) };
      }, timeout, signal);
      if (!result.retry) return result.value;
      credential = await authorizedCredential(credential);
    }
  }
  async function request(path, body, timeout = 0, signal) {
    if (path === "auth/status") return status();
    if (path === "auth/login") return login();
    if (path === "auth/cancel") return cancel();
    if (path === "auth/logout") return cancel(true);
    if (path === "models") {
      const version = encodeURIComponent(chrome.runtime.getManifest().version);
      const payload = await api(`models?client_version=${version}`, null, parseJSON, timeout);
      if (!Array.isArray(payload.models)) throw new Error("订阅模型目录格式无效；可手动填写模型 ID");
      return { data: payload.models.filter(m => m.visibility !== "hide").map(m => ({ id: m.slug })).filter(m => typeof m.id === "string" && m.id) };
    }
    if (path !== "chat/completions") throw new Error("不支持的订阅请求");
    // Whitelist exactly one current input; never forward arbitrary chat history/tools.
    if (body?.messages?.length !== 2 || body.messages[0].role !== "system" || body.messages[1].role !== "user") throw new Error("订阅翻译必须是独立请求");
    const user = body.messages[1].content;
    const content = typeof user === "string" ? [{ type: "input_text", text: user }]
      : user.map(part => part.type === "text" ? { type: "input_text", text: part.text }
        : { type: "input_image", image_url: part.image_url.url });
    return api("responses", { model: body.model, instructions: body.messages[0].content,
      input: [{ role: "user", content }], store: false, stream: true },
      async response => ({ choices: [{ message: { content: await LingoStream.read(response, "responses") } }] }), timeout, signal);
  }
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void poll().catch(() => {}); });
  // Rehydrate the scheduler on each worker start, including extension reloads.
  void schedule().catch(() => {});
  globalThis.LingoSubscription = { request };
})();
