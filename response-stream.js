/* Reads standard SSE without imposing a model-thinking/generation deadline. */
(() => {
  const fail = message => Object.assign(new Error(message), { offline: true });
  async function read(response, protocol) {
    if (!response.body) throw fail("服务未返回响应流");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", data = [], text = "", completed = false, size = 0;
    function event() {
      if (!data.length) return;
      const raw = data.join("\n"); data = [];
      if (raw === "[DONE]") { if (protocol === "chat") completed = true; return; }
      let item;
      try { item = JSON.parse(raw); } catch { throw fail("服务响应流格式无效"); }
      if (item.error || ["error", "response.failed", "response.incomplete"].includes(item.type)) {
        const code = item.error?.code || item.response?.error?.code || item.response?.incomplete_details?.reason;
        const safeCode = typeof code === "string" && /^[a-zA-Z0-9_-]{1,60}$/.test(code) ? `（${code}）` : "";
        throw fail(`服务报告生成失败或内容被截断${safeCode}，不是插件主动超时`);
      }
      if (protocol === "chat") {
        const choice = item.choices?.find(c => c.index === 0) || item.choices?.[0];
        if (typeof choice?.delta?.content === "string") text += choice.delta.content;
        if (choice?.finish_reason && choice.finish_reason !== "stop") throw fail(`服务未完整完成翻译（生成长度、内容或工具调用限制）`);
      } else {
        if (item.type === "response.output_text.delta" && typeof item.delta === "string") text += item.delta;
        if (item.type === "response.completed") {
          if (item.response?.status && item.response.status !== "completed") throw fail("服务未完成生成");
          completed = true;
          text = (item.response?.output || []).filter(i => i.type === "message").flatMap(i => i.content || [])
            .filter(i => i.type === "output_text").map(i => i.text || "").join("\n") || text;
        }
      }
    }
    function line(value) {
      value = value.replace(/\r$/, "");
      if (!value) event();
      else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
    }
    try {
      while (!completed) {
        let chunk;
        try { chunk = await reader.read(); } catch { throw fail("服务响应流网络中断，请重试"); }
        if (chunk.done) { buffer += decoder.decode(); if (buffer) line(buffer); event(); break; }
        size += chunk.value.byteLength;
        if (size > 8 * 1024 * 1024) throw fail("响应数据过大，请拆分文本后重试");
        buffer += decoder.decode(chunk.value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) !== -1) { line(buffer.slice(0, index)); buffer = buffer.slice(index + 1); if (completed) break; }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!completed || !text.trim()) throw fail("响应中断或未返回完整文字，不保存半截译文");
    return text;
  }
  globalThis.LingoStream = { read };
})();
