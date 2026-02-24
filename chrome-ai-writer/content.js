(() => {
  let activeField = null;
  let hostEl = null;
  let shadowRoot = null;
  let dialogEl = null;
  let triggerEl = null;
  let chatHistory = []; // { role, content }[]
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  // ── Helpers ──────────────────────────────────────────────

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") {
      // Skip login/auth fields
      if (el.type === "password") return false;
      const name = (el.name || el.id || el.autocomplete || "").toLowerCase();
      if (/username|login|passwd|password|email|phone/.test(name)) return false;
      if (el.autocomplete === "username" || el.autocomplete === "email" ||
          el.autocomplete === "current-password" || el.autocomplete === "new-password") return false;
      if (el.type === "text" || el.type === "search" || el.type === "url" || !el.type) return true;
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function getFieldRect(el) {
    return el.getBoundingClientRect();
  }

  // ── Lightweight Markdown → HTML ────────────────────────

  function renderMarkdown(md) {
    // Escape HTML
    let html = md
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Fenced code blocks: ```lang\n...\n```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g,
      (_, lang, code) => `<pre><code>${code.trim()}</code></pre>`);

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Headings (### h3, ## h2, # h1)
    html = html.replace(/^### (.+)$/gm, "<strong>$1</strong>");
    html = html.replace(/^## (.+)$/gm, "<strong>$1</strong>");
    html = html.replace(/^# (.+)$/gm, "<strong style='font-size:1.1em'>$1</strong>");

    // Bold & italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // Links [text](url) — only allow http/https URLs
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Unordered list items
    html = html.replace(/^[*\-] (.+)$/gm, "<li>$1</li>");
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

    // Ordered list items
    html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

    // Paragraphs: double newline → break
    html = html.replace(/\n\n/g, "<br><br>");
    // Single newlines (outside pre) → break
    html = html.replace(/\n/g, "<br>");

    return html;
  }

  function fireFieldEvents(field) {
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    // React ≥ 16: override native setter to trigger synthetic events
    const nativeSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field), "value"
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(field, field.value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // Append text at the end of the field
  function appendTextField(field, text) {
    if (!field) return;
    field.focus();

    if (field.isContentEditable) {
      // Move cursor to end
      const sel = window.getSelection();
      sel.selectAllChildren(field);
      sel.collapseToEnd();
      document.execCommand("insertText", false, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    const sep = field.value.length > 0 ? "\n" : "";
    field.value += sep + text;
    field.selectionStart = field.selectionEnd = field.value.length;
    fireFieldEvents(field);
  }

  // Replace all content in the field
  function replaceTextField(field, text) {
    if (!field) return;
    field.focus();

    if (field.isContentEditable) {
      document.execCommand("selectAll");
      document.execCommand("insertText", false, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    field.value = text;
    field.selectionStart = field.selectionEnd = text.length;
    fireFieldEvents(field);
  }

  // ── Shadow DOM setup ─────────────────────────────────────

  function ensureHost() {
    if (hostEl) return;
    hostEl = document.createElement("div");
    hostEl.className = "ai-writer-host";
    document.body.appendChild(hostEl);
    shadowRoot = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = getShadowStyles();
    shadowRoot.appendChild(style);
  }

  // ── Trigger button ───────────────────────────────────────

  function showTrigger(field) {
    ensureHost();
    if (triggerEl) triggerEl.remove();

    triggerEl = document.createElement("button");
    triggerEl.className = "aw-trigger";
    triggerEl.title = "AI Writing Assistant";
    triggerEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    shadowRoot.appendChild(triggerEl);

    positionTrigger(field);

    triggerEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    triggerEl.addEventListener("click", (e) => {
      e.stopPropagation();
      showDialog(field);
    });
  }

  function positionTrigger(field) {
    if (!triggerEl) return;
    const rect = getFieldRect(field);
    triggerEl.style.left = `${rect.right - 36}px`;
    triggerEl.style.top = `${rect.top + 4}px`;
  }

  function hideTrigger() {
    if (triggerEl) { triggerEl.remove(); triggerEl = null; }
  }

  // ── Dialog ───────────────────────────────────────────────

  function showDialog(field) {
    if (dialogEl) return;
    chatHistory = [];

    dialogEl = document.createElement("div");
    dialogEl.className = "aw-dialog";

    // Header (draggable)
    const header = document.createElement("div");
    header.className = "aw-header";
    header.innerHTML = `<span class="aw-title">AI Writing Assistant</span>`;
    const closeBtn = document.createElement("button");
    closeBtn.className = "aw-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", closeDialog);
    header.appendChild(closeBtn);
    dialogEl.appendChild(header);

    // Disclaimer
    const disclaimer = document.createElement("div");
    disclaimer.className = "aw-disclaimer";
    disclaimer.textContent = "Field content is sent to your configured API.";
    dialogEl.appendChild(disclaimer);

    // Messages area
    const msgs = document.createElement("div");
    msgs.className = "aw-messages";
    dialogEl.appendChild(msgs);

    // Input area
    const inputArea = document.createElement("div");
    inputArea.className = "aw-input-area";
    const input = document.createElement("textarea");
    input.className = "aw-input";
    input.placeholder = "Ask the AI to write something…";
    input.rows = 2;
    const sendBtn = document.createElement("button");
    sendBtn.className = "aw-send";
    sendBtn.textContent = "Send";
    inputArea.appendChild(input);
    inputArea.appendChild(sendBtn);
    dialogEl.appendChild(inputArea);

    shadowRoot.appendChild(dialogEl);

    // Position dialog near field (fixed viewport coordinates)
    const rect = getFieldRect(field);
    const dialogWidth = 360;
    let left = rect.left;
    let top = rect.bottom + 8;

    // Keep within viewport
    if (left + dialogWidth > window.innerWidth - 16) {
      left = window.innerWidth - dialogWidth - 16;
    }
    if (left < 8) left = 8;
    if (top + 480 > window.innerHeight) {
      top = rect.top - 480 - 8; // flip above if no room below
      if (top < 8) top = 8;
    }

    dialogEl.style.left = `${left}px`;
    dialogEl.style.top = `${top}px`;

    // Dragging
    header.addEventListener("mousedown", startDrag);

    // Send logic (streaming via port)
    function send() {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      sendBtn.disabled = true;
      addMessage("user", text);
      chatHistory.push({ role: "user", content: text });

      let fullText = "";
      const bubble = addMessage("assistant", "");
      bubble.classList.add("aw-loading");

      let port;
      try {
        port = chrome.runtime.connect({ name: "ai-writer-stream" });
      } catch (err) {
        bubble.remove();
        addMessage("assistant", "Extension was reloaded. Please refresh this page and try again.", true);
        sendBtn.disabled = false;
        return;
      }

      port.onMessage.addListener((msg) => {
        const msgs = shadowRoot.querySelector(".aw-messages");
        if (msg.type === "chunk") {
          fullText += msg.text;
          bubble.classList.remove("aw-loading");
          // Update rendered markdown live
          bubble.innerHTML = renderMarkdown(fullText);
          msgs.scrollTop = msgs.scrollHeight;
        } else if (msg.type === "done") {
          chatHistory.push({ role: "assistant", content: fullText });
          // Final render + add action buttons
          bubble.innerHTML = renderMarkdown(fullText);
          addActionButtons(bubble, fullText, field);
          msgs.scrollTop = msgs.scrollHeight;
          sendBtn.disabled = false;
          port.disconnect();
        } else if (msg.type === "error") {
          bubble.remove();
          addMessage("assistant", msg.text, true);
          sendBtn.disabled = false;
          port.disconnect();
        }
      });

      port.onDisconnect.addListener(() => {
        sendBtn.disabled = false;
      });

      // Read current field content as context — skip entirely if too long
      const MAX_FIELD_CHARS = 4000;
      let fieldContent = field.isContentEditable
        ? field.innerText
        : field.value;
      if (fieldContent && fieldContent.length > MAX_FIELD_CHARS) {
        fieldContent = "";
        addMessage("assistant", "Field content is too long (>4000 chars) and was excluded from context.", true);
      }

      port.postMessage({
        type: "chat",
        prompt: text,
        history: chatHistory.slice(-10, -1), // keep last 10 messages
        fieldContent: fieldContent || ""
      });
    }

    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    // Escape to close
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDialog();
    });

    input.focus();
  }

  function addMessage(role, text, isError = false) {
    const msgs = shadowRoot.querySelector(".aw-messages");
    const bubble = document.createElement("div");
    bubble.className = `aw-bubble aw-${role}` + (isError ? " aw-error" : "");

    if (role === "assistant" && !isError && text) {
      bubble.innerHTML = renderMarkdown(text);
    } else {
      bubble.textContent = text;
    }

    msgs.appendChild(bubble);
    msgs.scrollTop = msgs.scrollHeight;
    return bubble;
  }

  function addActionButtons(bubble, text, field) {
    if (!field) return;
    const btnGroup = document.createElement("div");
    btnGroup.className = "aw-btn-group";

    const appendBtn = document.createElement("button");
    appendBtn.className = "aw-insert";
    appendBtn.textContent = "Append";
    appendBtn.addEventListener("click", () => appendTextField(field, text));

    const replaceBtn = document.createElement("button");
    replaceBtn.className = "aw-insert aw-replace";
    replaceBtn.textContent = "Replace";
    replaceBtn.addEventListener("click", () => replaceTextField(field, text));

    btnGroup.appendChild(appendBtn);
    btnGroup.appendChild(replaceBtn);
    bubble.appendChild(btnGroup);
  }

  function closeDialog() {
    if (dialogEl) { dialogEl.remove(); dialogEl = null; }
  }

  // ── Dragging ─────────────────────────────────────────────

  function startDrag(e) {
    isDragging = true;
    dragOffset.x = e.clientX - dialogEl.getBoundingClientRect().left;
    dragOffset.y = e.clientY - dialogEl.getBoundingClientRect().top;
    document.addEventListener("mousemove", onDrag);
    document.addEventListener("mouseup", stopDrag);
    e.preventDefault();
  }

  function onDrag(e) {
    if (!isDragging || !dialogEl) return;
    dialogEl.style.left = `${e.clientX - dragOffset.x}px`;
    dialogEl.style.top = `${e.clientY - dragOffset.y}px`;
  }

  function stopDrag() {
    isDragging = false;
    document.removeEventListener("mousemove", onDrag);
    document.removeEventListener("mouseup", stopDrag);
  }

  // ── Focus / Blur listeners ───────────────────────────────

  document.addEventListener("focusin", (e) => {
    if (isTextField(e.target)) {
      activeField = e.target;
      showTrigger(e.target);
    }
  });

  document.addEventListener("focusout", (e) => {
    // Delay so clicks on trigger/dialog aren't interrupted
    setTimeout(() => {
      const active = document.activeElement;
      if (!isTextField(active) && !dialogEl) {
        hideTrigger();
        activeField = null;
      }
    }, 150);
  });

  // Close dialog on Escape (global)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDialog();
  });

  // ── Shadow styles ────────────────────────────────────────

  function getShadowStyles() {
    return `
      :host { all: initial; }

      .aw-trigger {
        position: fixed;
        pointer-events: auto;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 6px;
        background: #4f46e5;
        color: #fff;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        transition: background 0.15s;
      }
      .aw-trigger:hover { background: #4338ca; }

      .aw-dialog {
        position: fixed;
        pointer-events: auto;
        width: 360px;
        height: 420px;
        min-width: 280px;
        min-height: 250px;
        resize: both;
        overflow: auto;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.18);
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
        color: #1a1a1a;
      }

      .aw-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: #4f46e5;
        color: #fff;
        cursor: grab;
        user-select: none;
      }
      .aw-title { font-weight: 600; font-size: 13px; }
      .aw-close {
        background: none;
        border: none;
        color: #fff;
        font-size: 20px;
        cursor: pointer;
        line-height: 1;
        padding: 0 2px;
      }
      .aw-close:hover { opacity: 0.7; }

      .aw-disclaimer {
        padding: 4px 14px;
        font-size: 11px;
        color: #888;
        background: #f9f9f9;
        border-bottom: 1px solid #eee;
        text-align: center;
      }

      .aw-messages {
        flex: 1;
        overflow-y: auto;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 0;
      }

      .aw-bubble {
        max-width: 85%;
        padding: 8px 12px;
        border-radius: 10px;
        line-height: 1.45;
        word-wrap: break-word;
        white-space: pre-wrap;
      }
      .aw-user {
        align-self: flex-end;
        background: #4f46e5;
        color: #fff;
        border-bottom-right-radius: 3px;
      }
      .aw-assistant {
        align-self: flex-start;
        background: #f0f0f0;
        color: #1a1a1a;
        border-bottom-left-radius: 3px;
      }
      .aw-error {
        background: #fef2f2;
        color: #dc2626;
      }
      .aw-loading {
        opacity: 0.6;
        font-style: italic;
      }

      .aw-assistant pre {
        background: #e5e5e5;
        border-radius: 6px;
        padding: 8px 10px;
        overflow-x: auto;
        margin: 6px 0;
        font-size: 12px;
      }
      .aw-assistant code {
        font-family: "SF Mono", Menlo, Consolas, monospace;
        font-size: 12px;
      }
      .aw-assistant :not(pre) > code {
        background: #e0e0e0;
        padding: 1px 5px;
        border-radius: 3px;
      }
      .aw-assistant ul {
        margin: 4px 0;
        padding-left: 18px;
      }
      .aw-assistant li {
        margin: 2px 0;
      }
      .aw-assistant a {
        color: #4f46e5;
        text-decoration: underline;
      }

      .aw-btn-group {
        display: flex;
        gap: 6px;
        margin-top: 6px;
      }
      .aw-insert {
        padding: 3px 10px;
        font-size: 12px;
        font-weight: 600;
        background: #4f46e5;
        color: #fff;
        border: none;
        border-radius: 5px;
        cursor: pointer;
      }
      .aw-insert:hover { background: #4338ca; }
      .aw-replace {
        background: #6b7280;
      }
      .aw-replace:hover { background: #4b5563; }

      .aw-input-area {
        display: flex;
        gap: 8px;
        padding: 10px 12px;
        border-top: 1px solid #e5e5e5;
        background: #fafafa;
      }

      .aw-input {
        flex: 1;
        padding: 8px 10px;
        border: 1px solid #ddd;
        border-radius: 8px;
        font-size: 13px;
        font-family: inherit;
        resize: none;
        outline: none;
      }
      .aw-input:focus { border-color: #4f46e5; }

      .aw-send {
        padding: 8px 14px;
        background: #4f46e5;
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
      }
      .aw-send:hover { background: #4338ca; }
    `;
  }
})();
