(() => {
  let activeField = null;
  let hostEl = null;
  let shadowRoot = null;
  let dialogEl = null;
  let triggerEl = null;
  let chatHistory = []; // { role, content }[]
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };
  let selectedText = "";
  let selectionMode = false;
  let toolbarEl = null;

  const MAX_FIELD_CHARS = 4000;

  const QUICK_ACTIONS = [
    { label: "Draft a reply", prompt: (text) => `Draft a reply to the following text:\n"""\n${text}\n"""` },
    { label: "Explain simply", prompt: (text) => `Explain the following text so that a 4-year-old can understand:\n"""\n${text}\n"""` },
    { label: "Rephrase it", prompt: (text) => `Rephrase the following text:\n"""\n${text}\n"""` },
    { label: "Fix grammar", prompt: (text) => `Fix the grammar in the following text:\n"""\n${text}\n"""` },
    { label: "To English", prompt: (text) => `Translate the following text to English. Only output the translation, nothing else:\n"""\n${text}\n"""` },
    { label: "中文翻译", prompt: (text) => `将以下文本翻译成中文，只输出翻译结果:\n"""\n${text}\n"""` },
  ];

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

    // Prevent mouse events from reaching the host page.
    // This stops popups/dropdowns from closing when clicking our UI
    // (host pages often use document-level "click outside" listeners).
    ["mousedown", "click", "pointerdown"].forEach((evt) => {
      hostEl.addEventListener(evt, (e) => e.stopPropagation());
    });

    const style = document.createElement("style");
    style.textContent = getShadowStyles();
    shadowRoot.appendChild(style);
  }

  // ── Trigger button ───────────────────────────────────────

  let triggerDragged = false;

  function createTrigger(left, top, onClick) {
    ensureHost();
    if (triggerEl) triggerEl.remove();
    hideToolbar();

    triggerEl = document.createElement("button");
    triggerEl.className = "aw-trigger";
    triggerEl.title = "AI Writing Assistant — drag to move";
    triggerEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    triggerEl.style.left = `${left}px`;
    triggerEl.style.top = `${top}px`;
    shadowRoot.appendChild(triggerEl);

    // Drag-to-move with click threshold (5px)
    triggerEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerDragged = false;
      const startX = e.clientX, startY = e.clientY;
      const origLeft = parseFloat(triggerEl.style.left);
      const origTop = parseFloat(triggerEl.style.top);

      function onMove(ev) {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!triggerDragged && Math.abs(dx) + Math.abs(dy) < 5) return;
        triggerDragged = true;
        triggerEl.style.left = `${origLeft + dx}px`;
        triggerEl.style.top = `${origTop + dy}px`;
        hideToolbar();
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    triggerEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (triggerDragged) { triggerDragged = false; return; }
      onClick();
    });
  }

  function showTrigger(field) {
    const rect = getFieldRect(field);
    createTrigger(rect.right - 36, rect.top + 4, () => {
      if (selectionMode) showToolbar();
      else showDialog(field);
    });
  }

  function showTriggerForSelection(rect) {
    let left = rect.right + 4;
    let top = rect.top;
    if (left + 28 > window.innerWidth - 8) left = rect.left - 32;
    if (top < 8) top = 8;
    createTrigger(left, top, () => showToolbar());
  }

  function positionTrigger(field) {
    if (!triggerEl) return;
    const rect = getFieldRect(field);
    triggerEl.style.left = `${rect.right - 36}px`;
    triggerEl.style.top = `${rect.top + 4}px`;
  }

  function hideTrigger() {
    if (triggerEl) { triggerEl.remove(); triggerEl = null; }
    hideToolbar();
  }

  // ── Quick Action Toolbar ────────────────────────────────

  function showToolbar() {
    hideToolbar();
    if (!triggerEl) return;

    toolbarEl = document.createElement("div");
    toolbarEl.className = "aw-actions-toolbar";

    QUICK_ACTIONS.forEach((action) => {
      const btn = document.createElement("button");
      btn.className = "aw-action-btn";
      btn.textContent = action.label;
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const prompt = action.prompt(selectedText);
        hideToolbar();
        hideTrigger();
        showDialogWithAutoSend(prompt);
      });
      toolbarEl.appendChild(btn);
    });

    shadowRoot.appendChild(toolbarEl);

    // Position toolbar near trigger
    const triggerRect = triggerEl.getBoundingClientRect();
    const toolbarWidth = 150;
    const toolbarHeight = 160;
    let left = triggerRect.right + 6;
    let top = triggerRect.top;

    // Flip left if no room on right
    if (left + toolbarWidth > window.innerWidth - 8) {
      left = triggerRect.left - toolbarWidth - 6;
    }
    // Flip up if no room below
    if (top + toolbarHeight > window.innerHeight - 8) {
      top = window.innerHeight - toolbarHeight - 8;
    }
    if (top < 8) top = 8;

    toolbarEl.style.left = `${left}px`;
    toolbarEl.style.top = `${top}px`;
  }

  function hideToolbar() {
    if (toolbarEl) { toolbarEl.remove(); toolbarEl = null; }
  }

  // ── Dialog ───────────────────────────────────────────────

  function showDialogWithAutoSend(prompt) {
    // Open dialog in selection mode (no field), then auto-send the prompt
    showDialog(null, prompt);
  }

  function showDialog(field, autoSendPrompt) {
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
    disclaimer.textContent = field
      ? "Field content is sent to your configured API."
      : "Selected text is sent to your configured API.";
    dialogEl.appendChild(disclaimer);

    // Messages area
    const msgs = document.createElement("div");
    msgs.className = "aw-messages";
    dialogEl.appendChild(msgs);

    // Show context snippet
    const contextSource = field
      ? (field.isContentEditable ? field.innerText : field.value)
      : (autoSendPrompt ? null : selectedText); // auto-send already includes the text in the prompt
    if (contextSource && contextSource.trim()) {
      const truncated = contextSource.length > 120
        ? contextSource.slice(0, 120) + "…"
        : contextSource;
      const ctxBubble = document.createElement("div");
      ctxBubble.className = "aw-bubble aw-context";
      ctxBubble.textContent = truncated;
      msgs.appendChild(ctxBubble);
    }

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

    // Position dialog — use field rect if available, otherwise center-ish
    let left, top;
    const dialogWidth = 360;
    if (field) {
      const rect = getFieldRect(field);
      left = rect.left;
      top = rect.bottom + 8;
    } else {
      left = Math.max(8, (window.innerWidth - dialogWidth) / 2);
      top = Math.max(8, window.innerHeight / 2 - 240);
    }

    // Keep within viewport
    if (left + dialogWidth > window.innerWidth - 16) {
      left = window.innerWidth - dialogWidth - 16;
    }
    if (left < 8) left = 8;
    if (top + 480 > window.innerHeight) {
      top = field ? getFieldRect(field).top - 480 - 8 : 8;
      if (top < 8) top = 8;
    }

    dialogEl.style.left = `${left}px`;
    dialogEl.style.top = `${top}px`;

    // Prevent keyboard events from leaking to the host page
    // (e.g. GitHub uses "l" to open Labels, "e" to edit, etc.)
    dialogEl.addEventListener("keydown", (e) => e.stopPropagation());
    dialogEl.addEventListener("keyup", (e) => e.stopPropagation());
    dialogEl.addEventListener("keypress", (e) => e.stopPropagation());

    // Dragging
    header.addEventListener("mousedown", startDrag);

    // Send logic (streaming via port)
    function send(overrideText) {
      const text = overrideText || input.value.trim();
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
          bubble.innerHTML = renderMarkdown(fullText);
          msgs.scrollTop = msgs.scrollHeight;
        } else if (msg.type === "done") {
          chatHistory.push({ role: "assistant", content: fullText });
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
      let fieldContent = "";
      if (field) {
        fieldContent = field.isContentEditable
          ? field.innerText
          : field.value;
        if (fieldContent && fieldContent.length > MAX_FIELD_CHARS) {
          fieldContent = "";
          addMessage("assistant", "Field content is too long (>4000 chars) and was excluded from context.", true);
        }
      }

      port.postMessage({
        type: "chat",
        prompt: text,
        history: chatHistory.slice(-10, -1),
        fieldContent: fieldContent || ""
      });
    }

    sendBtn.addEventListener("click", () => send());
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

    // Auto-send if a prompt was provided (selection quick action)
    if (autoSendPrompt) {
      send(autoSendPrompt);
    } else {
      input.focus();
    }
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
    const btnGroup = document.createElement("div");
    btnGroup.className = "aw-btn-group";

    const copyBtn = document.createElement("button");
    copyBtn.className = "aw-btn-copy";
    copyBtn.textContent = "📑 Copy";
    copyBtn.title = "Copy to clipboard";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "✅ Copied";
        setTimeout(() => { copyBtn.textContent = "📑 Copy"; }, 1500);
      });
    });
    btnGroup.appendChild(copyBtn);

    if (field) {
      const appendBtn = document.createElement("button");
      appendBtn.className = "aw-btn-append";
      appendBtn.textContent = "➕ Append";
      appendBtn.title = "Insert after existing text";
      appendBtn.addEventListener("click", () => appendTextField(field, text));

      const replaceBtn = document.createElement("button");
      replaceBtn.className = "aw-btn-replace";
      replaceBtn.textContent = "📝 Replace";
      replaceBtn.title = "Replace current text";
      replaceBtn.addEventListener("click", () => {
        const current = field.isContentEditable ? field.innerText : field.value;
        showConfirmDialog("Replace all content in the field?", current, () => {
          replaceTextField(field, text);
        });
      });

      btnGroup.appendChild(appendBtn);
      btnGroup.appendChild(replaceBtn);
    }

    bubble.appendChild(btnGroup);
  }

  function showConfirmDialog(message, fieldContent, onConfirm) {
    const overlay = document.createElement("div");
    overlay.className = "aw-confirm-overlay";

    const box = document.createElement("div");
    box.className = "aw-confirm-box";

    const msg = document.createElement("div");
    msg.className = "aw-confirm-msg";
    msg.textContent = message;
    box.appendChild(msg);

    // Show a truncated preview of the current field content
    if (fieldContent && fieldContent.trim()) {
      const preview = document.createElement("div");
      preview.className = "aw-confirm-preview";
      const truncated = fieldContent.length > 80
        ? fieldContent.slice(0, 80) + "…"
        : fieldContent;
      preview.textContent = `"${truncated}"`;
      box.appendChild(preview);
    }

    const btns = document.createElement("div");
    btns.className = "aw-confirm-btns";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "aw-confirm-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => overlay.remove());

    const okBtn = document.createElement("button");
    okBtn.className = "aw-confirm-ok";
    okBtn.textContent = "Replace";
    okBtn.addEventListener("click", () => {
      overlay.remove();
      onConfirm();
    });

    btns.appendChild(cancelBtn);
    btns.appendChild(okBtn);
    box.appendChild(btns);
    overlay.appendChild(box);
    shadowRoot.appendChild(overlay);

    okBtn.focus();
  }

  function closeDialog() {
    if (dialogEl) { dialogEl.remove(); dialogEl = null; }
    clearSelectionState();
  }

  function clearSelectionState() {
    selectedText = "";
    selectionMode = false;
    hideToolbar();
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
      clearSelectionState();
      activeField = e.target;
      showTrigger(e.target);
    }
  });

  document.addEventListener("focusout", (e) => {
    // Delay so clicks on trigger/dialog aren't interrupted
    setTimeout(() => {
      const active = document.activeElement;
      if (!isTextField(active) && !dialogEl && !selectionMode) {
        hideTrigger();
        activeField = null;
      }
    }, 150);
  });

  // ── Text Selection Detection ────────────────────────────

  document.addEventListener("mouseup", (e) => {
    // Don't interfere with clicks on our own UI
    if (hostEl && hostEl.contains(e.target)) return;

    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";

      if (text.length > 0 && text.length <= MAX_FIELD_CHARS) {
        // Don't activate selection mode if a text field is focused
        if (isTextField(document.activeElement)) return;

        selectedText = text;
        selectionMode = true;

        try {
          const range = sel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            showTriggerForSelection(rect);
          }
        } catch (_) {
          // getRangeAt can throw if selection is gone
        }
      } else if (!dialogEl) {
        // Selection cleared — hide trigger only if not in field mode
        if (selectionMode) {
          hideTrigger();
          clearSelectionState();
        }
      }
    }, 10);
  });

  // Close dialog on Escape (global)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (toolbarEl) {
        hideToolbar();
      } else {
        closeDialog();
      }
    }
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
        cursor: grab;
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        transition: background 0.15s;
      }
      .aw-trigger:hover { background: #4338ca; }
      .aw-trigger:active { cursor: grabbing; }

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
      .aw-context {
        align-self: stretch;
        max-width: 100%;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        color: #666;
        font-size: 12px;
        font-style: italic;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .aw-context::before {
        content: "Context:";
        display: block;
        font-style: normal;
        font-weight: 600;
        font-size: 11px;
        color: #999;
        margin-bottom: 3px;
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
      .aw-btn-copy, .aw-btn-append, .aw-btn-replace {
        padding: 4px 12px;
        font-size: 12px;
        font-weight: 600;
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.15s;
      }
      .aw-btn-copy {
        background: linear-gradient(135deg, #4f46e5, #7c3aed);
        color: #fff;
        border: none;
      }
      .aw-btn-copy:hover {
        background: linear-gradient(135deg, #4338ca, #6d28d9);
      }
      .aw-btn-append {
        background: transparent;
        color: #4f46e5;
        border: 1.5px solid #4f46e5;
      }
      .aw-btn-append:hover {
        background: #4f46e5;
        color: #fff;
      }
      .aw-btn-replace {
        background: transparent;
        color: #ea580c;
        border: 1.5px solid #ea580c;
      }
      .aw-btn-replace:hover {
        background: #ea580c;
        color: #fff;
      }
      .aw-confirm-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
        z-index: 2;
        animation: aw-fade-in 0.15s ease;
      }
      .aw-confirm-box {
        background: #fff;
        border-radius: 12px;
        padding: 20px 24px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        max-width: 300px;
        text-align: center;
      }
      .aw-confirm-msg {
        font-size: 14px;
        font-weight: 500;
        color: #1a1a1a;
        margin-bottom: 16px;
        line-height: 1.4;
      }
      .aw-confirm-preview {
        font-size: 12px;
        color: #666;
        background: #f5f5f5;
        border-radius: 6px;
        padding: 8px 10px;
        margin-bottom: 14px;
        line-height: 1.4;
        max-height: 60px;
        overflow: hidden;
        word-break: break-word;
        font-style: italic;
      }
      .aw-confirm-btns {
        display: flex;
        gap: 10px;
        justify-content: center;
      }
      .aw-confirm-cancel, .aw-confirm-ok {
        padding: 7px 20px;
        font-size: 13px;
        font-weight: 600;
        border: none;
        border-radius: 8px;
        cursor: pointer;
      }
      .aw-confirm-cancel {
        background: #f0f0f0;
        color: #333;
      }
      .aw-confirm-cancel:hover { background: #e0e0e0; }
      .aw-confirm-ok {
        background: #dc2626;
        color: #fff;
      }
      .aw-confirm-ok:hover { background: #b91c1c; }
      @keyframes aw-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }

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

      .aw-actions-toolbar {
        position: fixed;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 6px;
        background: #fff;
        border-radius: 10px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.18);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        z-index: 1;
      }

      .aw-action-btn {
        display: block;
        width: 100%;
        padding: 7px 14px;
        font-size: 13px;
        font-weight: 500;
        color: #1a1a1a;
        background: #f5f5f5;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        text-align: left;
        white-space: nowrap;
        transition: background 0.12s;
      }
      .aw-action-btn:hover {
        background: #4f46e5;
        color: #fff;
      }

    `;
  }
})();
