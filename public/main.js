const form = document.getElementById("preview-form");
const input = document.getElementById("url-input");
const frame = document.getElementById("preview-frame");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = input.value.trim();

  if (!value) {
    return;
  }

  const targetUrl = normalizeUrl(value);
  frame.src = `/render?url=${encodeURIComponent(targetUrl)}`;
});

/**
 * Ensure the URL has a protocol because the backend expects one.
 * @param {string} value
 * @returns {string}
 */
function normalizeUrl(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}
