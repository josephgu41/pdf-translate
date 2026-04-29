# PDF Select Translator

Chrome MV3 extension for translating selected text in a dedicated PDF reader without using the clipboard.

## Development

```bash
pnpm install
pnpm build
```

Load the generated `dist` directory in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project's `dist` directory.

Click the extension button to open the reader, choose a local PDF, then select text in the left PDF pane. The original text appears on the right, followed by the translated text.

## Notes

- Translation defaults to `auto -> zh-CN`.
- Translation uses the free, unofficial `translate.googleapis.com` endpoint.
- The extension does not request clipboard permissions and does not call clipboard APIs.
- The first version focuses on local PDF files opened inside the extension reader.
