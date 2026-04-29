export type TranslateRequest = {
  type: "TRANSLATE_TEXT";
  text: string;
  source: "auto" | string;
  target: "zh-CN" | string;
};

export type TranslateResponse =
  | {
      ok: true;
      translatedText: string;
    }
  | {
      ok: false;
      error: string;
    };
