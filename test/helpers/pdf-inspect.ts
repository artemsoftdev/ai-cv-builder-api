import { extractLinks, extractText, getDocumentProxy, getMeta } from 'unpdf';

export interface InspectedPdf {
  pageSizes: { width: number; height: number }[];
  /** Whitespace runs, line wraps included, collapsed. */
  pageTexts: string[];
  text: string;
  links: string[];
  title: string | undefined;
}

export async function inspectPdf(bytes: Buffer): Promise<InspectedPdf> {
  const doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const pageSizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const [x0, y0, x1, y1] = (await doc.getPage(i)).view as [number, number, number, number];
    pageSizes.push({ width: x1 - x0, height: y1 - y0 });
  }
  const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();
  const { text } = await extractText(doc, { mergePages: false });
  const pageTexts = text.map(collapse);
  const { links } = await extractLinks(doc);
  const { info } = await getMeta(doc);
  return {
    pageSizes,
    pageTexts,
    text: pageTexts.join(' '),
    links,
    title: typeof info.Title === 'string' ? info.Title : undefined,
  };
}
