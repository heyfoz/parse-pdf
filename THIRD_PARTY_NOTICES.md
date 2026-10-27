# Third-party components

The application's own source is MIT licensed. Upstream components retain
their respective licenses and copyright notices.

## Included with the site

| Component | Version | License | Notice |
| --- | --- | --- | --- |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | [Included notice](browser/vendor/pdf-lib.LICENSE.md) |
| [QPDF WebAssembly wrapper](https://github.com/neslinesli93/qpdf-wasm) | 0.3.0 | ISC, as declared in upstream package metadata | [Provenance](browser/vendor/qpdf/NOTICE.md) |
| [QPDF](https://github.com/qpdf/qpdf) | 12.2.0, embedded in the WASM build | Apache-2.0 | [Copyright](browser/vendor/qpdf/COPYRIGHT.txt), [license](browser/vendor/qpdf/LICENSE-2.0.txt) |

The QPDF JavaScript and WebAssembly runtime files are distributed unmodified.
The wrapper's npm archive does not include a separate license file; its
declared license and source are recorded in the provenance notice.

## Downloaded when the related feature is used

| Component | Version | License | Source |
| --- | --- | --- | --- |
| PDF.js | 4.10.38 | Apache-2.0 | [Mozilla PDF.js](https://github.com/mozilla/pdf.js) |
| Tesseract.js | 6.0.1 | Apache-2.0 | [Tesseract.js](https://github.com/naptha/tesseract.js) |
| JSZip | 3.10.1 | MIT or GPL-3.0; used here under MIT | [JSZip](https://github.com/Stuk/jszip) |

Tesseract.js also downloads its OCR worker, WebAssembly core, and requested
language data. See the upstream project's notices for those components.
