function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapePdf(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n]+/g, ' ');
}

function valueForColumn(column, row) {
  return typeof column.value === 'function' ? column.value(row) : row[column.key];
}

function buildExcelHtml({ title, columns, rows }) {
  return `
    <html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>
    <h1>${escapeHtml(title)}</h1>
    <table border="1" cellspacing="0" cellpadding="5">
      <thead><tr>${columns.map(c => `<th>${escapeHtml(c.header)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(row => `<tr>${columns.map(c => `<td>${escapeHtml(valueForColumn(c, row))}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
    </body></html>`;
}

function makeSimplePdf({ title, columns, rows }) {
  const pageWidth = 595;
  const pageHeight = 842;
  const marginX = 36;
  const marginTop = 48;
  const lineHeight = 13;
  const maxChars = 112;

  const lines = [];
  lines.push(title);
  lines.push('');
  lines.push(columns.map(c => c.header).join(' | '));
  lines.push('-'.repeat(120));
  for (const row of rows) {
    const raw = columns.map(c => String(valueForColumn(c, row) ?? '')).join(' | ');
    let text = raw;
    while (text.length > maxChars) {
      lines.push(text.slice(0, maxChars));
      text = text.slice(maxChars);
    }
    lines.push(text);
  }

  const pages = [];
  let current = [];
  const maxLinesPerPage = Math.floor((pageHeight - marginTop - 40) / lineHeight);
  for (const line of lines) {
    if (current.length >= maxLinesPerPage) {
      pages.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) pages.push(current);

  const objects = [];
  function addObject(body) {
    objects.push(body);
    return objects.length;
  }

  const fontObj = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageRefs = [];
  const contentRefs = [];

  for (const pageLines of pages) {
    let y = pageHeight - marginTop;
    const content = [
      'BT',
      '/F1 9 Tf',
      '12 TL'
    ];
    for (const [idx, line] of pageLines.entries()) {
      const fontSize = idx === 0 && pageRefs.length === 0 ? 14 : 9;
      if (idx === 0 && pageRefs.length === 0) content.push(`/F1 ${fontSize} Tf`);
      content.push(`${marginX} ${y} Td (${escapePdf(line)}) Tj`);
      content.push(`${-marginX} ${-lineHeight} Td`);
      if (idx === 0 && pageRefs.length === 0) content.push('/F1 9 Tf');
      y -= lineHeight;
    }
    content.push('ET');
    const stream = content.join('\n');
    const contentRef = addObject(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`);
    contentRefs.push(contentRef);
    const pageRef = addObject(`<< /Type /Page /Parent PAGES_PLACEHOLDER /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentRef} 0 R >>`);
    pageRefs.push(pageRef);
  }

  const pagesObj = addObject(`<< /Type /Pages /Kids [${pageRefs.map(n => `${n} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`);
  for (const ref of pageRefs) {
    objects[ref - 1] = objects[ref - 1].replace('PAGES_PLACEHOLDER', `${pagesObj} 0 R`);
  }
  const catalogObj = addObject(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

export function sendHtmlTableExport(res, { filename, format, title, columns, rows }) {
  const safeFormat = format === 'pdf' ? 'pdf' : 'excel';

  if (safeFormat === 'pdf') {
    const buffer = makeSimplePdf({ title, columns, rows });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    res.send(buffer);
    return;
  }

  const table = buildExcelHtml({ title, columns, rows });
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xls"`);
  res.send(table);
}
