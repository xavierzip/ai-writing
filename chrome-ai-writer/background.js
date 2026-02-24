chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ai-writer-stream") return;

  port.onMessage.addListener(async (message) => {
    if (message.type !== "chat") return;
    await handleStreamChat(port, message.prompt, message.history, message.fieldContent);
  });
});

async function handleStreamChat(port, prompt, history = [], fieldContent = "") {
  try {
    const { apiUrl, apiKey, model } = await chrome.storage.sync.get(["apiUrl", "apiKey", "model"]);

    if (!apiKey) {
      port.postMessage({ type: "error", text: "API key not configured. Please set it in the extension options." });
      return;
    }

    let systemPrompt = "You are a writing assistant embedded in a text field. When asked to write, rewrite, or generate text, output ONLY the final text — no explanations, no preamble, no quotes around it. The user will insert your output directly into their document. If the user asks a question instead, answer it briefly.";

    if (fieldContent.trim()) {
      systemPrompt += `\n\nThe text field currently contains:\n"""\n${fieldContent}\n"""`;
    }

    // Sanitize history — only allow valid roles with string content
    const safeHistory = (history || [])
      .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map(m => ({ role: m.role, content: m.content }));

    const messages = [
      { role: "system", content: systemPrompt },
      ...safeHistory,
      { role: "user", content: prompt }
    ];

    const url = apiUrl || "https://api.openai.com/v1/chat/completions";

    // Validate URL scheme
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      port.postMessage({ type: "error", text: "Invalid API URL. Must start with http:// or https://" });
      return;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || "gpt-5-mini",
        messages,
        stream: true
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err.error?.message || `API error: ${response.status}`;
      port.postMessage({ type: "error", text: msg });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          port.postMessage({ type: "done" });
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) {
            port.postMessage({ type: "chunk", text: token });
          }
        } catch {}
      }
    }

    port.postMessage({ type: "done" });
  } catch (e) {
    port.postMessage({ type: "error", text: `Network error: ${e.message}` });
  }
}
