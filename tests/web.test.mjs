import assert from 'node:assert/strict';
import { test } from 'node:test';
import pdfLib from '../browser/vendor/pdf-lib.min.js';
import createQpdf from '../browser/vendor/qpdf/qpdf.js';
import '../browser/qpdf-core.js';
// UMD publishes exports in Node and PDFLib on globalThis in a browser.
globalThis.PDFLib = pdfLib;
const { mergePdfFiles } = await import('../browser/merge.js');
const { PDFDocument, degrees, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, StandardFonts } = pdfLib;

async function fixture(name, width, rotation = 0, form = false) {
  const doc = await PDFDocument.create();
  doc.addPage([width, 600]).setRotation(degrees(rotation));
  if (form) doc.getForm().createTextField('name').addToPage(doc.getPage(0));
  return new File([await doc.save()], name, { type: 'application/pdf' });
}

test('browser merges every page in the chosen order with size and rotation intact', async () => {
  const first = await fixture('first.pdf', 420);
  const second = await fixture('second.pdf', 700, 90);
  const events = [];
  const result = await mergePdfFiles([second, first], { progress: (...args) => events.push(args) });
  const merged = await PDFDocument.load(result.bytes);
  assert.equal(result.pages, 2);
  assert.deepEqual(merged.getPages().map((page) => page.getWidth()), [700, 420]);
  assert.deepEqual(merged.getPages().map((page) => page.getRotation().angle), [90, 0]);
  assert.deepEqual(events.map((event) => event[2]), ['second.pdf', 'first.pdf']);
});

test('browser rejects malformed PDFs without returning partial output', async () => {
  const normal = await fixture('normal.pdf', 420);
  await assert.rejects(mergePdfFiles([normal, new File(['bad PDF'], 'broken.pdf')]), /broken.pdf/);
  await assert.rejects(mergePdfFiles([normal]), /at least two/);
});

test('browser preserves filled form trees, independent duplicate names, fonts and widget page references', async () => {
  const inputs = [];
  for (const [index, fontName] of [StandardFonts.Helvetica, StandardFonts.TimesRoman].entries()) {
    const doc = await PDFDocument.create();
    const first = doc.addPage([420, 600]);
    const second = doc.addPage([420, 600]);
    const font = await doc.embedFont(fontName);
    const form = doc.getForm();
    const field = form.createTextField('profile.name');
    field.setText(index ? 'Different second value' : 'João ação');
    for (const page of [first, second]) field.addToPage(page, { x: 40, y: 400, width: 280, height: 40, font });
    const checked = form.createCheckBox('checked');
    checked.addToPage(first, { x: 40, y: 320, width: 20, height: 20 });
    checked.check();
    form.updateFieldAppearances(font);
    field.acroField.dict.set(PDFName.of('DA'), PDFString.of('/SharedFont 14 Tf 0 g'));
    form.acroForm.dict.set(PDFName.of('DR'), doc.context.obj({ Font: { SharedFont: font.ref } }));
    const link = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 260, 200, 290],
                                   Dest: [second.ref, 'Fit'] });
    first.node.addAnnot(doc.context.register(link));
    inputs.push(new File([await doc.save({ updateFieldAppearances: false })], `form-${index}.pdf`));
  }
  const result = await mergePdfFiles(inputs);
  const merged = await PDFDocument.load(result.bytes);
  const form = merged.getForm();
  assert.equal(form.getFields().length, 4);
  assert.equal(form.getTextField('profile.name').getText(), 'João ação');
  assert.equal(form.getTextField('profile_2.name').getText(), 'Different second value');
  assert.ok(form.getCheckBox('checked').isChecked());
  assert.ok(form.getCheckBox('checked_2').isChecked());
  for (const [index, page] of merged.getPages().entries()) {
    const annotations = page.node.lookup(PDFName.of('Annots'), PDFArray);
    for (let i = 0; i < annotations.size(); i++) {
      const annotation = annotations.lookup(i, PDFDict);
      if (annotation.get(PDFName.of('Subtype')) === PDFName.of('Widget')) {
        assert.equal(annotation.get(PDFName.of('P')).toString(), page.ref.toString());
      }
      const destination = annotation.lookupMaybe(PDFName.of('Dest'), PDFArray);
      if (destination) assert.equal(destination.get(0).toString(), merged.getPage(index + 1).ref.toString());
    }
  }
  const resources = form.acroForm.dict.lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
  assert.equal(resources.keys().length, 2, 'different source fonts must not replace one another');
  assert.notEqual(form.getTextField('profile.name').acroField.dict.get(PDFName.of('DA')).toString(),
                  form.getTextField('profile_2.name').acroField.dict.get(PDFName.of('DA')).toString());
  await assertPageContents(inputs, result.bytes);
});

test('browser preserves signature appearance and reports that the merged copy cannot validate original signatures', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 600]);
  const field = doc.getForm().createTextField('Signature1');
  field.setText('Signed sample appearance');
  field.addToPage(page, { x: 40, y: 400, width: 280, height: 40 });
  doc.getForm().updateFieldAppearances();
  field.acroField.dict.set(PDFName.of('FT'), PDFName.of('Sig'));
  field.acroField.dict.set(PDFName.of('V'), doc.context.obj({
    Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 0, 0, 0], Contents: PDFHexString.of('00'),
  }));
  const signed = new File([await doc.save({ updateFieldAppearances: false })], 'signed.pdf');
  const plain = await fixture('plain.pdf', 420);
  const result = await mergePdfFiles([plain, signed]);
  assert.equal(result.hasSignatures, true);
  const merged = await PDFDocument.load(result.bytes);
  assert.equal(merged.getForm().getFields()[0].acroField.dict.get(PDFName.of('FT')), PDFName.of('Sig'));
  await assertPageContents([plain, signed], result.bytes);
});

async function assertPageContents(inputs, output) {
  const merged = await PDFDocument.load(output);
  let index = 0;
  const streams = (doc, page) => {
    const contents = page.node.Contents();
    if (!contents) return [];
    if (contents instanceof PDFArray) {
      return contents.asArray().map(ref => Buffer.from(doc.context.lookup(ref).getContents()));
    }
    return [Buffer.from(contents.getContents())];
  };
  for (const file of inputs) {
    const source = await PDFDocument.load(await file.arrayBuffer());
    for (const page of source.getPages()) {
      assert.deepEqual(streams(merged, merged.getPage(index++)), streams(source, page));
    }
  }
  assert.equal(index, merged.getPageCount());
}

test('browser cancellation stops before output is returned', async () => {
  const files = [await fixture('first.pdf', 420), await fixture('second.pdf', 500)];
  let stopped = false;
  await assert.rejects(mergePdfFiles(files, {
    cancelled: () => stopped,
    progress: () => { stopped = true; },
  }), /cancelled/);
});

async function qpdfFixture(bytes, password) {
  const module = await createQpdf({noInitialRun: true, noFSInit: true});
  module.FS.init(() => null, () => {}, () => {});
  module.FS.writeFile('/input.pdf', bytes);
  try {
    const status = module.callMain(['/input.pdf', '--encrypt', password, 'test-owner', '256', '--', '/output.pdf']);
    assert.equal(status, 0);
    return module.FS.readFile('/output.pdf').slice();
  } finally {
    for (const name of ['/input.pdf', '/output.pdf']) {
      try { module.FS.unlink(name); } catch { /* no output on failure */ }
    }
    process.exitCode = 0;
  }
}

const decrypt = async (bytes, {password}) => {
  try {
    return await globalThis.pdfharvestDecrypt(createQpdf, bytes, password);
  } finally {
    process.exitCode = 0;
  }
};

test('real QPDF decrypts permission-only and password-protected PDFs before merging', async () => {
  const plain = await fixture('plain.pdf', 420);
  const source = new Uint8Array(await plain.arrayBuffer());
  const restricted = new File([await qpdfFixture(source, '')], 'restricted.pdf');
  const locked = new File([await qpdfFixture(source, 'test-pass-123')], 'locked.pdf');
  let prompts = 0;
  const opened = await mergePdfFiles([restricted, plain], {
    decrypt, requestPassword: () => { throw new Error('A permission-only PDF should not prompt'); },
  });
  assert.equal((await PDFDocument.load(opened.bytes)).getPageCount(), 2);
  const withPassword = await mergePdfFiles([locked, plain], {
    decrypt, requestPassword: () => ++prompts === 1 ? 'wrong-password' : 'test-pass-123',
  });
  assert.equal(withPassword.pages, 2);
  assert.equal(prompts, 2);
  await assert.rejects(mergePdfFiles([locked, plain], {decrypt, requestPassword: () => null}),
                       error => error.name === 'AbortError');
});
