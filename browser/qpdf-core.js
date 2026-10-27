// Shared between the browser worker and the encrypted-PDF regression checks.
globalThis.pdfharvestDecrypt = async function (createModule, bytes, password, options = {}) {
  const errors = [];
  const qpdf = await createModule({
    ...options, noInitialRun: true, noFSInit: true,
  });
  qpdf.FS.init(() => null, () => {}, (byte) => { if (byte !== null) errors.push(byte); });
  try {
    qpdf.FS.writeFile('/input.pdf', bytes);
    let exitCode;
    try {
      exitCode = qpdf.callMain([`--password=${password}`, '--decrypt', '/input.pdf', '/output.pdf']);
    } catch (error) {
      exitCode = error.status ?? 2;
    }
    if (/invalid password/i.test(new TextDecoder().decode(new Uint8Array(errors)))) {
      const error = new Error('This PDF needs its opening password.');
      error.code = 'PDF_PASSWORD_REQUIRED';
      throw error;
    }
    if (exitCode !== 0 && exitCode !== 3) {
      throw new Error('Could not unlock this PDF. It may be damaged or use unsupported encryption.');
    }
    return qpdf.FS.readFile('/output.pdf').slice();
  } finally {
    for (const path of ['/input.pdf', '/output.pdf']) {
      try { qpdf.FS.unlink(path); } catch { /* no partial file */ }
    }
  }
};
