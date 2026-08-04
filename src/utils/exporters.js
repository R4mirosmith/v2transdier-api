function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pdfSafeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x00-\x7F]/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function valueForColumn(column, row) {
  return typeof column.value === 'function' ? column.value(row) : row[column.key];
}

function buildExcelHtml({ title, columns, rows }) {
  const generatedAt = new Date().toISOString();
  const body = rows.map(row => {
    const isBlank = columns.every(column => String(valueForColumn(column, row) ?? '').trim() === '');
    const section = String(row.section || '').trim();
    const sectionClass = section && !['DETALLE DE TICKETS', 'DETALLE DE GASTOS'].includes(section) ? 'section-row' : '';
    return `<tr class="${sectionClass}${isBlank ? ' blank-row' : ''}">${columns.map(column => `<td>${escapeHtml(valueForColumn(column, row))}</td>`).join('')}</tr>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
  body{font-family:Arial,sans-serif;color:#172033;margin:24px}h1{font-size:22px;margin:0 0 6px;color:#143a66}.meta{font-size:11px;color:#667085;margin-bottom:18px}
  table{border-collapse:collapse;width:100%;font-size:11px}th{background:#143a66;color:#fff;padding:8px;border:1px solid #c8d2df;text-align:left;white-space:nowrap}
  td{padding:6px;border:1px solid #d8dee8;vertical-align:top}tr:nth-child(even):not(.section-row):not(.blank-row){background:#f7f9fc}
  .section-row td{background:#e8f0f8;font-weight:700;color:#143a66;border-top:2px solid #8aa4bf}.blank-row td{height:8px;background:#fff;border-left:0;border-right:0}
  </style></head><body><h1>${escapeHtml(title)}</h1><div class="meta">Generado: ${escapeHtml(generatedAt)} · Filas: ${rows.length}</div>
  <table><thead><tr>${columns.map(column => `<th>${escapeHtml(column.header)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

function wrapText(text, maxChars) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const lines = [];
  let remaining = clean;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf(' ', maxChars);
    if (cut < Math.floor(maxChars * 0.55)) cut = maxChars;
    lines.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  lines.push(remaining);
  return lines;
}

function makeSimplePdf({ title, columns, rows }) {
  const pageWidth = 842, pageHeight = 595, marginX = 24, marginTop = 32, marginBottom = 24, lineHeight = 9, fontSize = 7, maxChars = 165;
  const headerLine = columns.map(column => column.header).join(' | ');
  const separator = '-'.repeat(maxChars);
  const rowLines = [];
  for (const row of rows) {
    rowLines.push(...wrapText(columns.map(column => String(valueForColumn(column, row) ?? '')).join(' | '), maxChars));
  }
  const maxLinesPerPage = Math.floor((pageHeight - marginTop - marginBottom - 34) / lineHeight);
  const pages = [];
  let cursor = 0;
  while (cursor < rowLines.length || pages.length === 0) {
    const room = Math.max(1, maxLinesPerPage - 4);
    const pageRows = rowLines.slice(cursor, cursor + room);
    cursor += pageRows.length;
    pages.push([title, `Pagina ${pages.length + 1}`, headerLine, separator, ...pageRows]);
  }

  const objects = [];
  const addObject = body => { objects.push(body); return objects.length; };
  const fontObj = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageRefs = [];
  for (const pageLines of pages) {
    let y = pageHeight - marginTop;
    const content = ['BT'];
    pageLines.forEach((line, index) => {
      const currentSize = index === 0 ? 12 : index <= 3 ? 7.5 : fontSize;
      content.push(`/F1 ${currentSize} Tf`);
      content.push(`1 0 0 1 ${marginX} ${y} Tm (${pdfSafeText(line)}) Tj`);
      y -= index === 0 ? 15 : lineHeight;
    });
    content.push('ET');
    const stream = content.join('\n');
    const contentRef = addObject(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`);
    pageRefs.push(addObject(`<< /Type /Page /Parent PAGES_PLACEHOLDER /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentRef} 0 R >>`));
  }
  const pagesObj = addObject(`<< /Type /Pages /Kids [${pageRefs.map(ref => `${ref} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`);
  pageRefs.forEach(ref => { objects[ref - 1] = objects[ref - 1].replace('PAGES_PLACEHOLDER', `${pagesObj} 0 R`); });
  const catalogObj = addObject(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf, 'utf8')); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

export function sendHtmlTableExport(res, { filename, format, title, columns, rows }) {
  if (format === 'pdf') {
    const buffer = makeSimplePdf({ title, columns, rows });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    res.send(buffer);
    return;
  }
  const table = buildExcelHtml({ title, columns, rows });
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xls"`);
  res.send(`\uFEFF${table}`);
}
