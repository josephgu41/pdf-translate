import type { TranslateRequest, TranslateResponse } from "./types";

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({
    url: chrome.runtime.getURL("viewer.html")
  });
});

chrome.runtime.onMessage.addListener(
  (
    message: TranslateRequest,
    _sender,
    sendResponse: (response: TranslateResponse) => void
  ) => {
    if (message?.type !== "TRANSLATE_TEXT") {
      return false;
    }

    translateText(message)
      .then((translatedText) => sendResponse({ ok: true, translatedText }))
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Translation failed.";
        sendResponse({ ok: false, error: message });
      });

    return true;
  }
);

async function translateText(request: TranslateRequest): Promise<string> {
  const text = request.text.trim();

  if (!text) {
    throw new Error("No text selected.");
  }

  if (text.length > 5000) {
    throw new Error("Selected text is too long. Please select a shorter passage.");
  }

  const params = new URLSearchParams({
    client: "gtx",
    sl: request.source || "auto",
    tl: request.target || "zh-CN",
    dt: "t",
    q: text
  });

  const response = await fetch(
    `https://translate.googleapis.com/translate_a/single?${params.toString()}`
  );

  if (!response.ok) {
    throw new Error(`Google Translate returned HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as unknown;
  const translatedText = parseGoogleTranslatePayload(payload);

  if (!translatedText) {
    throw new Error("Google Translate returned an empty response.");
  }

  return translatedText;
}

function parseGoogleTranslatePayload(payload: unknown): string {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    return "";
  }

  return payload[0]
    .map((segment) => {
      if (Array.isArray(segment) && typeof segment[0] === "string") {
        return segment[0];
      }

      return "";
    })
    .join("");
}
