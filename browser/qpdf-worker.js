importScripts('./vendor/qpdf/qpdf.js', './qpdf-core.js');

self.onmessage = async ({ data }) => {
  try {
    const bytes = await self.pdfharvestDecrypt(Module, new Uint8Array(data.bytes), data.password, {
      locateFile: (name) => new URL(`./vendor/qpdf/${name}`, self.location.href).href,
    });
    self.postMessage({ bytes }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message, code: error.code });
  }
};
