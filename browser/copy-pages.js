/** Copy pages and their AcroForm tree with the same reference map.
 *
 * pdf-lib's public copyPages copies widgets but omits the document's /Fields
 * tree. Using one copier for page references and fields preserves both the
 * canonical form values and each widget's appearance and page association.
 */
export function copyPdfPages(source, target, documentIndex) {
  const { PDFObjectCopier, PDFPage, PDFPageLeaf, PDFName, PDFDict, PDFArray,
          PDFString, PDFHexString, PDFBool } = globalThis.PDFLib;
  const name = (value) => PDFName.of(value);
  const form = source.catalog.lookupMaybe(name('AcroForm'), PDFDict);
  if (form?.has(name('XFA'))) {
    throw new Error('This PDF uses an XFA form. Export a standard PDF copy before merging it.');
  }
  const copier = PDFObjectCopier.for(source.context, target.context);
  for (const page of source.getPages()) {
    // Copy the reference, rather than re-registering the copied page node.
    // Widget /P and link destinations must point to this exact page reference.
    const ref = copier.copy(page.ref);
    target.addPage(PDFPage.of(target.context.lookup(ref, PDFPageLeaf), ref, target));
  }
  const fields = form?.lookupMaybe(name('Fields'), PDFArray);
  if (!fields?.size()) return { hasSignatures: false };

  let targetForm = target.catalog.lookupMaybe(name('AcroForm'), PDFDict);
  if (!targetForm) {
    targetForm = target.context.obj({ Fields: [] });
    target.catalog.set(name('AcroForm'), target.context.register(targetForm));
  }
  const targetFields = targetForm.lookup(name('Fields'), PDFArray);
  const copiedFields = copier.copy(fields);
  const sourceResources = form.lookupMaybe(name('DR'), PDFDict);
  const fontAliases = new Map();
  if (sourceResources) {
    let resources = targetForm.lookupMaybe(name('DR'), PDFDict);
    if (!resources) {
      resources = target.context.obj({});
      targetForm.set(name('DR'), resources);
    }
    for (const [category, value] of sourceResources.entries()) {
      const sourceGroup = source.context.lookup(value, PDFDict);
      let group = resources.lookupMaybe(category, PDFDict);
      if (!group) {
        group = target.context.obj({});
        resources.set(category, group);
      }
      for (const [key, resource] of sourceGroup.entries()) {
        if (category === name('Font')) {
          // Different PDFs routinely reuse /Helv or /F1 for different fonts.
          const alias = name(`Merge${documentIndex + 1}Font${fontAliases.size}`);
          fontAliases.set(key.decodeText(), alias.toString());
          group.set(alias, copier.copy(resource));
        } else if (!group.has(key)) {
          group.set(key, copier.copy(resource));
        }
      }
    }
  }

  const renameFonts = (appearance) => appearance.replace(
    /(\/[^\s()[\]<>\/%]+)(\s+[-+\d.]+\s+Tf\b)/g,
    (match, font, operator) => {
      const decoded = font.slice(1).replace(/#([\da-f]{2})/gi,
        (_token, hex) => String.fromCharCode(parseInt(hex, 16)));
      return (fontAliases.get(decoded) || font) + operator;
    },
  );
  const rewriteAppearance = (field) => {
    const appearance = field.lookupMaybe(name('DA'), PDFString, PDFHexString);
    if (appearance) field.set(name('DA'), PDFString.of(renameFonts(appearance.decodeText())));
  };
  let hasSignatures = false;
  const visited = new Set();
  const visit = (field) => {
    if (visited.has(field)) return;
    visited.add(field);
    if (field.get(name('FT')) === name('Sig')) hasSignatures = true;
    rewriteAppearance(field);
    const kids = field.lookupMaybe(name('Kids'), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) visit(kids.lookup(i, PDFDict));
  };
  const usedNames = new Set();
  for (let i = 0; i < targetFields.size(); i++) {
    const field = targetFields.lookup(i, PDFDict);
    const title = field.lookupMaybe(name('T'), PDFString, PDFHexString);
    if (title) usedNames.add(title.decodeText());
  }
  for (let i = 0; i < copiedFields.size(); i++) {
    const field = copiedFields.lookup(i, PDFDict);
    field.delete(name('Parent'));
    // The source AcroForm's defaults become inheritable field defaults.
    for (const key of ['DA', 'Q']) {
      if (!field.has(name(key)) && form.has(name(key))) {
        field.set(name(key), copier.copy(form.get(name(key))));
      }
    }
    const title = field.lookupMaybe(name('T'), PDFString, PDFHexString);
    if (title) {
      const original = title.decodeText();
      let unique = original;
      let suffix = 2;
      while (usedNames.has(unique)) unique = `${original}_${suffix++}`;
      if (unique !== original) field.set(name('T'), PDFString.of(unique));
      usedNames.add(unique);
    }
    visit(field);
    targetFields.push(copiedFields.get(i));
  }
  if (form.get(name('NeedAppearances')) === PDFBool.True) {
    targetForm.set(name('NeedAppearances'), PDFBool.True);
  }
  const calculationOrder = form.lookupMaybe(name('CO'), PDFArray);
  if (calculationOrder) {
    let order = targetForm.lookupMaybe(name('CO'), PDFArray);
    if (!order) {
      order = target.context.obj([]);
      targetForm.set(name('CO'), order);
    }
    for (let i = 0; i < calculationOrder.size(); i++) order.push(copier.copy(calculationOrder.get(i)));
  }
  return { hasSignatures };
}
