// Vendored MIT-licensed pdf-lib: merging does not need a CDN or a backend.
import './vendor/pdf-lib.min.js';
import { decryptPdf } from './decrypt.js';
import { copyPdfPages } from './copy-pages.js';

function hasEncryptionKey(bytes) {
  // Encrypted object streams can fail strict parsing before pdf-lib reports
  // encryption. The trailer's /Encrypt name is itself always unencrypted.
  const key = [47, 69, 110, 99, 114, 121, 112, 116];
  for (let i = 0; i <= bytes.length - key.length; i++) {
    if (bytes[i] !== 47) continue;
    if (!key.every((byte, offset) => bytes[i + offset] === byte)) continue;
    const end = bytes[i + key.length];
    if (end === undefined || end <= 32 || [40, 41, 60, 62, 91, 93, 123, 125, 47, 37].includes(end)) return true;
  }
  return false;
}

export async function mergePdfFiles(files, {
  progress = () => {}, cancelled = () => false, signal,
  requestPassword, decrypt = decryptPdf,
} = {}) {
  if (files.length < 2) throw new Error('Add at least two PDFs to merge.');
  const { PDFDocument } = globalThis.PDFLib;
  const merged = await PDFDocument.create();
  let pages = 0;
  let hasSignatures = false;
  for (const [index, file] of files.entries()) {
    if (cancelled()) throw new Error('Merge cancelled.');
    let source;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      source = await PDFDocument.load(bytes, {
        updateMetadata: false, throwOnInvalidObject: true,
      });
    } catch (error) {
      if (/encrypted/i.test(error.message) || hasEncryptionKey(bytes)) {
        progress(index, files.length, `Unlocking ${file.name} locally…`);
        let password = '', attempt = 0;
        while (!source) {
          try {
            const unlocked = await decrypt(bytes, { password, signal });
            source = await PDFDocument.load(unlocked, { updateMetadata: false, throwOnInvalidObject: true });
          } catch (unlockError) {
            if (unlockError.code !== 'PDF_PASSWORD_REQUIRED') throw unlockError;
            if (!requestPassword) throw new Error(`${file.name}: an opening password is required.`);
            password = await requestPassword(file.name, attempt++, signal);
            if (password === null) throw new DOMException('Merge cancelled.', 'AbortError');
          }
        }
      } else {
        throw new Error(`${file.name}: could not read this PDF. It may be damaged or incomplete.`);
      }
    }
    if (!source.getPageCount()) throw new Error(`${file.name}: this PDF has no pages.`);
    try {
      const copied = copyPdfPages(source, merged, index);
      hasSignatures ||= copied.hasSignatures;
    } catch (error) {
      throw new Error(`${file.name}: ${error.message}`);
    }
    pages += source.getPageCount();
    progress(index + 1, files.length, file.name);
    // Let the page repaint and the Cancel button respond between documents.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (cancelled()) throw new Error('Merge cancelled.');
  // Preserve original widget appearances instead of redrawing signed/filled fields.
  const bytes = await merged.save({ updateFieldAppearances: false });
  if (cancelled()) throw new Error('Merge cancelled.');
  return { bytes, pages, hasSignatures };
}
