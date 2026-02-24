const apiUrlInput = document.getElementById("apiUrl");
const apiKeyInput = document.getElementById("apiKey");
const modelSelect = document.getElementById("model");
const saveBtn = document.getElementById("save");
const status = document.getElementById("status");

// Load saved settings
chrome.storage.sync.get(["apiUrl", "apiKey", "model"], ({ apiUrl, apiKey, model }) => {
  if (apiUrl) apiUrlInput.value = apiUrl;
  if (apiKey) apiKeyInput.value = apiKey;
  if (model) modelSelect.value = model;
});

saveBtn.addEventListener("click", () => {
  const apiUrl = apiUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  const model = modelSelect.value;

  if (apiUrl && !apiUrl.match(/^https?:\/\//)) {
    showStatus("API URL must start with http:// or https://", true);
    return;
  }

  if (!apiKey) {
    showStatus("Please enter an API key.", true);
    return;
  }

  chrome.storage.sync.set({ apiUrl, apiKey, model }, () => {
    showStatus("Settings saved.");
  });
});

function showStatus(msg, isError = false) {
  status.textContent = msg;
  status.className = "status " + (isError ? "error" : "success");
  setTimeout(() => { status.textContent = ""; status.className = "status"; }, 3000);
}
