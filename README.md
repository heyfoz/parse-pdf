# pdfharvest

**Merge PDFs, extract text and images, and OCR scans in your browser.**

[Open the app](https://heyfoz.github.io/parse-pdf/) · [Source](https://github.com/heyfoz/parse-pdf)

PDF contents and opening passwords are processed on your device. There is no
upload endpoint, account, API key, or backend service.

## What it does

- Combine multiple PDFs in the order you choose, then preview or download the result.
- Keep original page text, images, dimensions and rotation.
- Preserve standard AcroForm field values and widget appearances. Duplicate root
  field names are renamed so values from different files remain independent.
- Open encrypted PDFs locally with QPDF WebAssembly. Files that require an opening
  password prompt for it; the combined download is not password protected.
- Extract embedded text and images. OCR scanned pages and text inside images.
- Export transcripts as Word, Markdown, plain text, or a ZIP with extracted assets.

## Use it

1. [Open pdfharvest](https://heyfoz.github.io/parse-pdf/).
2. Add your PDFs and use the arrow buttons to arrange their order.
3. Choose **Merge into PDF**, or configure OCR and choose **Extract**.
4. Download the result. All source files remain unchanged.

For a local copy, no build or dependency installation is needed:

```bash
git clone https://github.com/heyfoz/parse-pdf.git
cd parse-pdf
python3 browser/serve.py
```

This starts a standard-library static file server on localhost and opens the app.
The server serves application assets; it does not receive your document contents.
ES modules and workers require HTTP, so opening `index.html` with `file://` is not supported.

## Privacy and network access

Merging uses the included pdf-lib and QPDF assets. It does not need a third-party
processing service. Extraction and OCR load PDF.js, Tesseract.js, OCR language data,
and JSZip when needed. Those providers receive normal asset requests, not the PDFs
or passwords. GitHub Pages also receives normal website requests. The app adds no
analytics or document telemetry.

Passwords are used in browser memory. The unlocking worker is terminated after
use, and the password input is cleared. Reloading the page clears the file queue
and generated result. Browser downloads remain on your computer.

## Known limits

- **Digital signatures:** signed pages keep their appearance, but the original
  signatures cannot validate a newly merged file. Keep the original signed PDFs
  for verification. The app displays a notice when it encounters a signature field.
- **XFA forms:** export a standard PDF first. Standard AcroForm fields are supported.
- **Document-level features:** bookmarks, attachments, and application-specific
  form scripts are not combined. This is a page-merging and extraction tool.
- **Large documents:** available memory and OCR speed depend on the device.
- **OCR quality:** language, scan quality and layout affect the result; review
  extracted text before relying on it.

## Development

Node.js 22 or newer is needed only for the test suite. No npm installation is required:

```bash
npm test
```

Tests cover page ordering, dimensions, rotation, field values, duplicate field names,
font resources, widget/page references, link destinations, signed-field appearances,
malformed files, cancellation, encrypted inputs and incorrect-password retries.
Test documents are generated in memory; no personal PDFs are included.

The browser code is in `browser/`. `merge.js` coordinates merging, `copy-pages.js`
preserves form structure, and `qpdf-worker.js` unlocks encrypted input in a dedicated
worker. `app.js` handles the interface and extraction pipeline.

## GitHub Pages deployment

The [Pages workflow](.github/workflows/pages.yml) runs tests before deploying the
contents of `browser/`. Enable GitHub Pages with **GitHub Actions** as its source.
All local assets use relative paths, including the WASM worker, so deployment works
under a repository subpath. No build server or application backend stays running.

## License

The application's own source is [MIT licensed](LICENSE). Bundled and downloaded
libraries retain their upstream licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

Built by [Forrest Moulin](https://forrestmoulin.com).
