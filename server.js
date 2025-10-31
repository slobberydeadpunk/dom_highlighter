const express = require("express");
const path = require("path");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/render", async (req, res) => {
  const target = (req.query.url || "").trim();

  if (!target) {
    return res.status(400).send("Missing url query parameter.");
  }

  let normalized;
  try {
    normalized = normalizeUrl(target);
  } catch (error) {
    return res.status(400).send("Invalid URL.");
  }

  try {
    const assetOrigin = buildAssetOrigin(req);
    const response = await fetch(normalized.href, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .send(`Failed to fetch target page (${response.status}).`);
    }

    const rawHtml = await response.text();
    const enhancedHtml = injectHighlighter(rawHtml, normalized, assetOrigin);

    res.send(enhancedHtml);
  } catch (error) {
    // Avoid leaking internal errors to the client.
    res.status(500).send("Unable to fetch or render the requested page.");
  }
});

app.listen(PORT, () => {
  console.log(`DOM Highlighter server listening on http://localhost:${PORT}`);
});

/**
 * Injects helper markup into the fetched HTML so we can highlight DOM nodes.
 * @param {string} html
 * @param {URL} url
 * @param {string} assetOrigin
 * @returns {string}
 */
function injectHighlighter(html, url, assetOrigin) {
  const assetHost = assetOrigin.replace(/\/+$/, "");
  const baseTag = `<base href="${url.origin}/">`;
  const styleTag = `<link rel="stylesheet" href="${assetHost}/injected.css" id="__dh-style-link" data-dh-ignore="true">`;
  const configScript = `<script data-dh-ignore="true">window.__DOM_HIGHLIGHTER_CONFIG__=${serializeForScript(
    { assetOrigin: assetHost }
  )};</script>`;
  const scriptTag = `<script src="${assetHost}/injected.js" data-dh-ignore="true"></script>`;

  let transformed = stripContentSecurityPolicy(html);
  const hasHead = /<head[^>]*>/i.test(transformed);
  const hasBase = /<base\s[^>]*href=/i.test(transformed);

  const headInjection = [
    hasBase ? "" : baseTag,
    styleTag,
    configScript,
  ]
    .filter(Boolean)
    .join("\n");

  if (hasHead) {
    transformed = transformed.replace(
      /<head[^>]*>/i,
      (match) => `${match}\n${headInjection}`
    );
  } else {
    transformed = `<head>${headInjection}</head>${transformed}`;
  }

  if (/<\/body>/i.test(transformed)) {
    transformed = transformed.replace(/<\/body>/i, `${scriptTag}\n</body>`);
  } else {
    transformed = `${transformed}\n${scriptTag}`;
  }

  return transformed;
}

/**
 * Basic normalisation helper to ensure URLs have a protocol.
 * @param {string} value
 * @returns {URL}
 */
function normalizeUrl(value) {
  const prefixed = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return new URL(prefixed);
}

/**
 * Removes meta CSP tags to ensure our injected scripts can run.
 * @param {string} html
 * @returns {string}
 */
function stripContentSecurityPolicy(html) {
  return html.replace(
    /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi,
    ""
  );
}

/**
 * Builds the origin for static assets based on the incoming request.
 * @param {import("express").Request} req
 * @returns {string}
 */
function buildAssetOrigin(req) {
  const protocol =
    (req.headers["x-forwarded-proto"] &&
      String(req.headers["x-forwarded-proto"]).split(",")[0]) ||
    req.protocol ||
    "http";
  const host = req.get("host");
  return `${protocol}://${host}`;
}

/**
 * Serialises a JS value for safe inline injection.
 * @param {unknown} value
 * @returns {string}
 */
function serializeForScript(value) {
  return JSON.stringify(value).replace(/<\/(script)/gi, "<\\/$1");
}
