/**
 * ELION-X · Extração de documentos (PDF, DOCX, PPTX, TXT)
 * PDF: pdf-parse (texto) — fallback p/ Claude nativo quando for digitalizado
 * DOCX/PPTX: leitura do ZIP interno (Office Open XML) + extração de texto
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let JSZip = null, pdfParse = null;

const decodeEntities = s => (s || '')
  .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** Word .docx → texto (parágrafos de word/document.xml) */
export async function extractDocx(buffer) {
  if (!JSZip) JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const f = zip.file('word/document.xml');
  if (!f) throw new Error('estrutura .docx inválida');
  const xml = await f.async('string');
  const paras = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  let out = '';
  for (const p of paras) {
    const texts = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m => decodeEntities(m[1]));
    out += texts.join('') + '\n';
  }
  // tabelas e cabeçalhos já entram como parágrafos; limpa excesso de linhas
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** PowerPoint .pptx → texto por slide (ppt/slides/slideN.xml) */
export async function extractPptx(buffer) {
  if (!JSZip) JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => (+a.match(/slide(\d+)/)[1]) - (+b.match(/slide(\d+)/)[1]));
  let out = '';
  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.file(slides[i]).async('string');
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => decodeEntities(m[1]).trim()).filter(Boolean);
    if (texts.length) out += `\n━━ Slide ${i + 1} ━━\n${texts.join('\n')}\n`;
  }
  if (!out.trim()) throw new Error('nenhum texto encontrado nos slides');
  return out.trim();
}

/** PDF → texto (pdf-parse). Retorna {text, pages}. */
export async function extractPdf(buffer) {
  if (!pdfParse) pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  return { text: (data.text || '').replace(/\n{3,}/g, '\n\n').trim(), pages: data.numpages || 0 };
}
