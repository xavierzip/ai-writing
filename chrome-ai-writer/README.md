# AI Writing Assistant — Chrome Extension

A Chrome extension that injects a floating AI chat dialog next to any active text input field. Powered by any OpenAI-compatible API.

## Features

- **Floating chat dialog** appears next to any text input, textarea, or contenteditable field
- **Smart field detection** — skips password, username, email, and login fields
- **Field context awareness** — reads existing field content so the AI can reference/improve it (capped at 4000 chars)
- **Streaming responses** — tokens appear in real-time as they arrive
- **Markdown rendering** — code blocks, bold, italic, lists, links
- **Append / Replace** — insert AI-generated text into the active field
- **Draggable & resizable** dialog
- **Shadow DOM isolation** — styles won't conflict with host pages
- **Configurable API** — works with OpenAI, AliCloud DashScope, or any OpenAI-compatible endpoint
- **No build step** — plain JS/CSS, load directly into Chrome

## Installation

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `chrome-ai-writer/` folder

## Configuration

1. Right-click the extension icon → **Options** (or go to `chrome://extensions` → Details → Extension options)
2. Set your **API URL** (defaults to `https://api.openai.com/v1/chat/completions`)
   - For AliCloud DashScope: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`
3. Enter your **API Key**
4. Set the **Model** name (defaults to `gpt-5-mini`)
5. Click **Save**

## Usage

1. Navigate to any page with a text input (Gmail, Google Docs, GitHub, etc.)
2. Click into a text field — a small purple chat icon appears near the field
3. Click the icon — a chat dialog opens
4. Type a prompt and press **Enter** or click **Send**
5. Watch the response stream in real-time
6. Click **Append** to add text to the field, or **Replace** to overwrite it
7. Drag the dialog header to reposition, or resize from the bottom-right corner
8. Press **Escape** to close the dialog

## Project Structure

```
chrome-ai-writer/
├── manifest.json     # MV3 manifest
├── background.js     # Service worker — streaming OpenAI API calls
├── content.js        # Content script — floating dialog with Shadow DOM
├── content.css       # Host element styles
├── options.html      # Settings page
├── options.js        # Settings logic
├── options.css       # Settings styles
└── icons/            # Extension icons (16, 48, 128px)
```

## Supported APIs

Any endpoint that implements the OpenAI Chat Completions API format with SSE streaming:

- OpenAI (`api.openai.com`)
- AliCloud DashScope compatible mode
- Azure OpenAI
- Local LLM servers (LM Studio, Ollama with OpenAI compat, vLLM, etc.)

## Security

- API key is stored in `chrome.storage.sync` and never exposed to page context
- API calls are made from the background service worker, not the content script
- Markdown links are restricted to `http://` and `https://` URLs only (no `javascript:`)
- Chat history sent to the API is sanitized to valid roles and string content
- API URL is validated on save and before each request
- Password, username, email, and login fields are excluded from triggering the dialog

## Notes

- After reloading the extension in `chrome://extensions`, **refresh open tabs** for changes to take effect
- Field content over 4000 characters is excluded from context (with a warning) to limit token costs
- Chat history is capped to the last 10 messages per conversation
