function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function pdfSafeText(value) {
  const clean = String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, ' ');
  const bytes = Buffer.from(clean, 'latin1');
  let result = '';
  for (const byte of bytes) {
    if (byte === 0x5c) result += '\\\\';
    else if (byte === 0x28) result += '\\(';
    else if (byte === 0x29) result += '\\)';
    else if (byte < 0x20 || byte > 0x7e) result += `\\${byte.toString(8).padStart(3, '0')}`;
    else result += String.fromCharCode(byte);
  }
  return result;
}

function valueForColumn(column, row) {
  return typeof column.value === 'function' ? column.value(row) : row?.[column.key];
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function displayValue(column, value) {
  if (value === null || value === undefined || value === '') return '';
  if (column.type === 'money') {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      maximumFractionDigits: 0
    }).format(asNumber(value));
  }
  if (column.type === 'decimal') {
    return new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(asNumber(value));
  }
  if (column.type === 'integer') {
    return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(asNumber(value));
  }
  return String(value);
}

/* -------------------------------------------------------------------------- */
/* Exportador genérico heredado                                               */
/* -------------------------------------------------------------------------- */

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
  const fontObj = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
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

/* -------------------------------------------------------------------------- */
/* Reporte administrativo estructurado                                        */
/* -------------------------------------------------------------------------- */

function cleanSheetName(value, fallback = 'Reporte') {
  const clean = String(value || fallback).replace(/[\\/:*?\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || fallback).slice(0, 31);
}

function excelStyleFor(column, alternate = false, value = '') {
  if (column.type === 'money') return alternate ? 'MoneyAlt' : 'Money';
  if (column.type === 'integer' || column.type === 'decimal') return alternate ? 'NumberAlt' : 'Number';
  if (column.type === 'status') {
    const normalized = String(value || '').toUpperCase();
    if (/CORRECTO|CERRADA|CERRADO|PAGADO|EMBARCADO|ACTIVO/.test(normalized)) return 'StatusOk';
    if (/REVISAR|ERROR|ANULADO|RETIRADO/.test(normalized)) return 'StatusBad';
  }
  return alternate ? 'CellAlt' : 'Cell';
}

function excelCell(column, value, alternate = false) {
  const style = excelStyleFor(column, alternate, value);
  const numeric = ['money', 'integer', 'decimal'].includes(column.type);
  if (numeric) {
    return `<Cell ss:StyleID="${style}"><Data ss:Type="Number">${asNumber(value)}</Data></Cell>`;
  }
  return `<Cell ss:StyleID="${style}"><Data ss:Type="String">${escapeXml(value ?? '')}</Data></Cell>`;
}

function excelTableXml(table) {
  const columns = table.columns || [];
  const rows = table.rows || [];
  const maxColumns = Math.max(1, columns.length);
  const columnXml = columns.map(column => {
    const width = Number(column.excelWidth || Math.max(55, Number(column.width || 1) * 11));
    return `<Column ss:AutoFitWidth="0" ss:Width="${Math.min(260, width)}"/>`;
  }).join('');
  const title = `<Row ss:Height="24"><Cell ss:MergeAcross="${maxColumns - 1}" ss:StyleID="SectionTitle"><Data ss:Type="String">${escapeXml(table.title || 'Detalle')}</Data></Cell></Row>`;
  const note = table.note
    ? `<Row ss:Height="22"><Cell ss:MergeAcross="${maxColumns - 1}" ss:StyleID="Note"><Data ss:Type="String">${escapeXml(table.note)}</Data></Cell></Row>`
    : '';
  const header = `<Row ss:Height="28">${columns.map(column => `<Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(column.header)}</Data></Cell>`).join('')}</Row>`;
  const body = rows.length
    ? rows.map((row, index) => `<Row>${columns.map(column => excelCell(column, valueForColumn(column, row), index % 2 === 1)).join('')}</Row>`).join('')
    : `<Row><Cell ss:MergeAcross="${maxColumns - 1}" ss:StyleID="Empty"><Data ss:Type="String">Sin información para los filtros seleccionados.</Data></Cell></Row>`;
  const totals = table.totals
    ? `<Row ss:Height="24">${columns.map(column => {
        const value = typeof table.totals[column.key] === 'undefined' ? '' : table.totals[column.key];
        const numeric = ['money', 'integer', 'decimal'].includes(column.type);
        return numeric
          ? `<Cell ss:StyleID="${column.type === 'money' ? 'TotalMoney' : 'TotalNumber'}"><Data ss:Type="Number">${asNumber(value)}</Data></Cell>`
          : `<Cell ss:StyleID="TotalText"><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
      }).join('')}</Row>`
    : '';
  return `${columnXml}${title}${note}${header}${body}${totals}<Row ss:Height="12"/>`;
}

export function buildStructuredExcelXml({ title, subtitle = '', metadata = [], summary = [], sheets = [] }) {
  const usedNames = new Set();
  const normalizedSheets = (sheets.length ? sheets : [{ name: 'Reporte', tables: [] }]).map((sheet, index) => {
    let base = cleanSheetName(sheet.name || sheet.title || `Hoja ${index + 1}`);
    let name = base;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${base.slice(0, 27)} ${suffix}`.slice(0, 31);
      suffix += 1;
    }
    usedNames.add(name);
    return { ...sheet, name };
  });

  const styles = `
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Borders/><Font ss:FontName="Calibri" ss:Size="10"/><Interior/><NumberFormat/><Protection/></Style>
    <Style ss:ID="Title"><Alignment ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="18" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#123B67" ss:Pattern="Solid"/></Style>
    <Style ss:ID="Subtitle"><Font ss:FontName="Calibri" ss:Size="10" ss:Color="#475467"/><Interior ss:Color="#EAF1F8" ss:Pattern="Solid"/></Style>
    <Style ss:ID="MetaLabel"><Font ss:Bold="1" ss:Color="#344054"/><Interior ss:Color="#F2F4F7" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/></Borders></Style>
    <Style ss:ID="MetaValue"><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/></Borders></Style>
    <Style ss:ID="KpiLabel"><Alignment ss:Horizontal="Center"/><Font ss:Bold="1" ss:Color="#475467"/><Interior ss:Color="#F2F4F7" ss:Pattern="Solid"/><Borders><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/></Borders></Style>
    <Style ss:ID="KpiValue"><Alignment ss:Horizontal="Center"/><Font ss:Size="13" ss:Bold="1" ss:Color="#123B67"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/></Borders></Style>
    <Style ss:ID="KpiMoney"><Alignment ss:Horizontal="Center"/><Font ss:Size="13" ss:Bold="1" ss:Color="#123B67"/><NumberFormat ss:Format="&quot;$&quot;#,##0"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/></Borders></Style>
    <Style ss:ID="SectionTitle"><Alignment ss:Vertical="Center"/><Font ss:Size="12" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1D5A91" ss:Pattern="Solid"/></Style>
    <Style ss:ID="Note"><Alignment ss:WrapText="1"/><Font ss:Size="9" ss:Italic="1" ss:Color="#475467"/><Interior ss:Color="#EAF1F8" ss:Pattern="Solid"/></Style>
    <Style ss:ID="Header"><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#123B67" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FFFFFF"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FFFFFF"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FFFFFF"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FFFFFF"/></Borders></Style>
    <Style ss:ID="Cell"><Alignment ss:Vertical="Top" ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D8DEE8"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D8DEE8"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D8DEE8"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D8DEE8"/></Borders></Style>
    <Style ss:ID="CellAlt" ss:Parent="Cell"><Interior ss:Color="#F7F9FC" ss:Pattern="Solid"/></Style>
    <Style ss:ID="Number" ss:Parent="Cell"><Alignment ss:Horizontal="Right" ss:Vertical="Top"/></Style>
    <Style ss:ID="NumberAlt" ss:Parent="Number"><Interior ss:Color="#F7F9FC" ss:Pattern="Solid"/></Style>
    <Style ss:ID="Money" ss:Parent="Number"><NumberFormat ss:Format="&quot;$&quot;#,##0"/></Style>
    <Style ss:ID="MoneyAlt" ss:Parent="Money"><Interior ss:Color="#F7F9FC" ss:Pattern="Solid"/></Style>
    <Style ss:ID="StatusOk" ss:Parent="Cell"><Alignment ss:Horizontal="Center"/><Font ss:Bold="1" ss:Color="#067647"/><Interior ss:Color="#ECFDF3" ss:Pattern="Solid"/></Style>
    <Style ss:ID="StatusBad" ss:Parent="Cell"><Alignment ss:Horizontal="Center"/><Font ss:Bold="1" ss:Color="#B42318"/><Interior ss:Color="#FEF3F2" ss:Pattern="Solid"/></Style>
    <Style ss:ID="TotalText"><Font ss:Bold="1" ss:Color="#123B67"/><Interior ss:Color="#EAF1F8" ss:Pattern="Solid"/><Borders><Border ss:Position="Top" ss:LineStyle="Double" ss:Weight="3" ss:Color="#123B67"/></Borders></Style>
    <Style ss:ID="TotalNumber" ss:Parent="TotalText"><Alignment ss:Horizontal="Right"/><NumberFormat ss:Format="#,##0"/></Style>
    <Style ss:ID="TotalMoney" ss:Parent="TotalNumber"><NumberFormat ss:Format="&quot;$&quot;#,##0"/></Style>
    <Style ss:ID="Empty"><Alignment ss:Horizontal="Center"/><Font ss:Italic="1" ss:Color="#667085"/><Interior ss:Color="#F9FAFB" ss:Pattern="Solid"/></Style>
  </Styles>`;

  const workbookSheets = normalizedSheets.map((sheet, sheetIndex) => {
    const tables = sheet.tables || [];
    const maxColumns = Math.max(2, ...tables.map(table => table.columns?.length || 1), summary.length ? Math.min(4, summary.length) : 1);
    const intro = sheetIndex === 0
      ? `<Row ss:Height="32"><Cell ss:MergeAcross="${maxColumns - 1}" ss:StyleID="Title"><Data ss:Type="String">${escapeXml(title)}</Data></Cell></Row>
         <Row ss:Height="22"><Cell ss:MergeAcross="${maxColumns - 1}" ss:StyleID="Subtitle"><Data ss:Type="String">${escapeXml(subtitle)}</Data></Cell></Row>
         ${metadata.map(item => `<Row><Cell ss:StyleID="MetaLabel"><Data ss:Type="String">${escapeXml(item.label)}</Data></Cell><Cell ss:MergeAcross="${maxColumns - 2}" ss:StyleID="MetaValue"><Data ss:Type="String">${escapeXml(item.value)}</Data></Cell></Row>`).join('')}
         <Row ss:Height="12"/>
         ${summary.length ? (() => {
           const perRow = 4;
           let xml = '';
           for (let i = 0; i < summary.length; i += perRow) {
             const group = summary.slice(i, i + perRow);
             xml += `<Row ss:Height="20">${group.map(item => `<Cell ss:StyleID="KpiLabel"><Data ss:Type="String">${escapeXml(item.label)}</Data></Cell>`).join('')}</Row>`;
             xml += `<Row ss:Height="28">${group.map(item => `<Cell ss:StyleID="${item.type === 'money' ? 'KpiMoney' : 'KpiValue'}"><Data ss:Type="${item.type === 'money' || item.type === 'integer' ? 'Number' : 'String'}">${item.type === 'money' || item.type === 'integer' ? asNumber(item.value) : escapeXml(item.value)}</Data></Cell>`).join('')}</Row><Row ss:Height="8"/>`;
           }
           return xml;
         })() : ''}`
      : `<Row ss:Height="30"><Cell ss:MergeAcross="${maxColumns - 1}" ss:StyleID="Title"><Data ss:Type="String">${escapeXml(sheet.title || sheet.name)}</Data></Cell></Row><Row ss:Height="10"/>`;

    return `<Worksheet ss:Name="${escapeXml(sheet.name)}"><Table>${intro}${tables.map(excelTableXml).join('')}</Table>
      <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><Selected/><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions>
    </Worksheet>`;
  }).join('');

  return `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
  <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
    xmlns:o="urn:schemas-microsoft-com:office:office"
    xmlns:x="urn:schemas-microsoft-com:office:excel"
    xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
    xmlns:html="http://www.w3.org/TR/REC-html40">
    <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Author>Transdier V2</Author><Created>${new Date().toISOString()}</Created></DocumentProperties>
    ${styles}${workbookSheets}
  </Workbook>`;
}

function colorCommand(hex, stroke = false) {
  const clean = String(hex).replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} ${stroke ? 'RG' : 'rg'}`;
}

function wrapTextLimited(text, maxChars, maxLines = 4) {
  const lines = wrapText(String(text ?? ''), Math.max(3, maxChars));
  if (lines.length <= maxLines) return lines;
  const limited = lines.slice(0, maxLines);
  const last = limited[maxLines - 1];
  limited[maxLines - 1] = `${last.slice(0, Math.max(0, last.length - 3))}...`;
  return limited;
}

export function buildStructuredPdf({ title, subtitle = '', metadata = [], summary = [], sheets = [] }) {
  const pageWidth = 842;
  const pageHeight = 595;
  const marginX = 24;
  const marginTop = 22;
  const marginBottom = 24;
  const usableWidth = pageWidth - marginX * 2;
  const pages = [];
  let current = null;
  let y = 0;

  const add = command => current.push(command);
  const drawRect = (x, top, width, height, fill, stroke = '#D0D5DD') => {
    if (fill) add(`${colorCommand(fill)} ${x.toFixed(2)} ${(top - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`);
    if (stroke) add(`${colorCommand(stroke, true)} 0.45 w ${x.toFixed(2)} ${(top - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re S`);
  };
  const drawLine = (x1, y1, x2, y2, color = '#D0D5DD', width = 0.45) => add(`${colorCommand(color, true)} ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  const drawText = (text, x, baselineY, size = 7, bold = false, color = '#101828') => {
    if (text === null || text === undefined || text === '') return;
    add(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${colorCommand(color)} 1 0 0 1 ${x.toFixed(2)} ${baselineY.toFixed(2)} Tm (${pdfSafeText(text)}) Tj ET`);
  };
  const newPage = (continued = false) => {
    current = [];
    pages.push(current);
    if (continued) {
      drawText(title, marginX, pageHeight - 18, 8, true, '#123B67');
      drawLine(marginX, pageHeight - 23, pageWidth - marginX, pageHeight - 23, '#B8C8D8', 0.6);
      y = pageHeight - 31;
    } else {
      y = pageHeight - marginTop;
    }
  };
  const needPage = height => {
    if (!current) newPage(false);
    if (y - height < marginBottom + 10) newPage(true);
  };

  newPage(false);
  drawRect(marginX, y, usableWidth, 34, '#123B67', '#123B67');
  drawText(title, marginX + 12, y - 21, 16, true, '#FFFFFF');
  y -= 40;
  if (subtitle) {
    drawText(subtitle, marginX, y - 8, 9, false, '#475467');
    y -= 18;
  }

  for (const item of metadata) {
    drawText(`${item.label}:`, marginX, y - 7, 7.5, true, '#344054');
    drawText(item.value, marginX + 82, y - 7, 7.5, false, '#344054');
    y -= 12;
  }
  y -= 4;

  if (summary.length) {
    const perRow = 4;
    const gap = 6;
    const cardWidth = (usableWidth - gap * (perRow - 1)) / perRow;
    for (let index = 0; index < summary.length; index += perRow) {
      needPage(42);
      const group = summary.slice(index, index + perRow);
      group.forEach((item, offset) => {
        const x = marginX + offset * (cardWidth + gap);
        drawRect(x, y, cardWidth, 36, '#F2F4F7', '#CBD5E1');
        drawText(item.label, x + 6, y - 11, 6.5, true, '#475467');
        drawText(displayValue({ type: item.type }, item.value), x + 6, y - 27, 10, true, '#123B67');
      });
      y -= 42;
    }
  }

  const drawTableHeader = (table, widths, sectionTitle = true) => {
    const columns = table.columns || [];
    if (sectionTitle) {
      drawRect(marginX, y, usableWidth, 20, '#1D5A91', '#1D5A91');
      drawText(table.title || 'Detalle', marginX + 7, y - 13, 9, true, '#FFFFFF');
      y -= 20;
      if (table.note) {
        const noteLines = wrapTextLimited(table.note, 150, 2);
        const noteHeight = 8 + noteLines.length * 8;
        drawRect(marginX, y, usableWidth, noteHeight, '#EAF1F8', '#B8C8D8');
        noteLines.forEach((line, lineIndex) => drawText(line, marginX + 6, y - 11 - lineIndex * 8, 6.7, false, '#475467'));
        y -= noteHeight;
      }
    }
    const fontSize = table.headerFontSize || (columns.length >= 13 ? 5.2 : columns.length >= 10 ? 5.8 : 6.4);
    const headerLines = columns.map((column, index) => wrapTextLimited(column.pdfHeader || column.header, Math.floor(widths[index] / (fontSize * 0.52)), 3));
    const headerHeight = Math.max(19, ...headerLines.map(lines => lines.length * (fontSize + 1.4) + 6));
    let x = marginX;
    columns.forEach((column, index) => {
      drawRect(x, y, widths[index], headerHeight, '#123B67', '#FFFFFF');
      const lines = headerLines[index];
      lines.forEach((line, lineIndex) => drawText(line, x + 3, y - 7 - lineIndex * (fontSize + 1.4), fontSize, true, '#FFFFFF'));
      x += widths[index];
    });
    y -= headerHeight;
  };

  const drawTable = table => {
    const columns = table.columns || [];
    const rows = table.rows || [];
    if (!columns.length) return;
    const totalWeight = columns.reduce((sum, column) => sum + Number(column.pdfWidth || column.width || 1), 0) || columns.length;
    const widths = columns.map(column => usableWidth * Number(column.pdfWidth || column.width || 1) / totalWeight);
    const bodyFontSize = table.fontSize || (columns.length >= 14 ? 5.1 : columns.length >= 11 ? 5.6 : columns.length >= 8 ? 6.1 : 6.6);
    const lineHeight = bodyFontSize + 1.4;
    const maxLines = table.maxLines || (columns.length >= 12 ? 3 : 4);

    if (table.pageBreakBefore && y < pageHeight - 70) newPage(true);
    needPage(70);
    drawTableHeader(table, widths, true);

    if (!rows.length) {
      needPage(22);
      drawRect(marginX, y, usableWidth, 20, '#F9FAFB', '#D0D5DD');
      drawText('Sin informacion para los filtros seleccionados.', marginX + 6, y - 13, 7, false, '#667085');
      y -= 26;
      return;
    }

    rows.forEach((row, rowIndex) => {
      const cellLines = columns.map((column, index) => {
        const text = displayValue(column, valueForColumn(column, row));
        const chars = Math.max(3, Math.floor((widths[index] - 6) / (bodyFontSize * 0.52)));
        return wrapTextLimited(text, chars, column.maxLines || maxLines);
      });
      const rowHeight = Math.max(16, ...cellLines.map(lines => lines.length * lineHeight + 6));
      if (y - rowHeight < marginBottom + 10) {
        newPage(true);
        drawTableHeader(table, widths, true);
      }
      let x = marginX;
      columns.forEach((column, index) => {
        const fill = rowIndex % 2 === 1 ? '#F7F9FC' : '#FFFFFF';
        drawRect(x, y, widths[index], rowHeight, fill, '#D8DEE8');
        const lines = cellLines[index];
        lines.forEach((line, lineIndex) => {
          const isMoney = column.type === 'money';
          const isNumber = ['money', 'integer', 'decimal'].includes(column.type);
          const textWidthEstimate = line.length * bodyFontSize * 0.49;
          const textX = isNumber ? Math.max(x + 3, x + widths[index] - 3 - textWidthEstimate) : x + 3;
          drawText(line, textX, y - 7 - lineIndex * lineHeight, bodyFontSize, isMoney, isMoney ? '#123B67' : '#101828');
        });
        x += widths[index];
      });
      y -= rowHeight;
    });

    if (table.totals) {
      const totalHeight = 18;
      if (y - totalHeight < marginBottom + 10) {
        newPage(true);
        drawTableHeader(table, widths, true);
      }
      let x = marginX;
      columns.forEach((column, index) => {
        const value = typeof table.totals[column.key] === 'undefined' ? '' : table.totals[column.key];
        drawRect(x, y, widths[index], totalHeight, '#EAF1F8', '#8AA4BF');
        const text = displayValue(column, value);
        drawText(text, x + 3, y - 12, bodyFontSize + 0.2, true, '#123B67');
        x += widths[index];
      });
      y -= totalHeight;
    }
    y -= 10;
  };

  for (const sheet of sheets) {
    const tables = sheet.tables || [];
    if (sheet.pageBreakBefore && y < pageHeight - 70) newPage(true);
    if (sheet.title && tables.length > 1) {
      needPage(28);
      drawText(sheet.title, marginX, y - 12, 12, true, '#123B67');
      drawLine(marginX, y - 18, pageWidth - marginX, y - 18, '#8AA4BF', 1);
      y -= 26;
    }
    tables.forEach(drawTable);
  }

  pages.forEach((commands, index) => {
    commands.push(`${colorCommand('#98A2B3', true)} 0.4 w ${marginX} 17 m ${pageWidth - marginX} 17 l S`);
    commands.push(`BT /F1 6.5 Tf ${colorCommand('#667085')} 1 0 0 1 ${marginX} 8 Tm (${pdfSafeText(`Transdier V2 - Pagina ${index + 1} de ${pages.length}`)}) Tj ET`);
  });

  const objects = [];
  const addObject = body => { objects.push(body); return objects.length; };
  const fontRegular = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageRefs = [];
  pages.forEach(commands => {
    const stream = commands.join('\n');
    const contentRef = addObject(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`);
    pageRefs.push(addObject(`<< /Type /Page /Parent PAGES_PLACEHOLDER /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentRef} 0 R >>`));
  });
  const pagesObj = addObject(`<< /Type /Pages /Kids [${pageRefs.map(ref => `${ref} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`);
  pageRefs.forEach(ref => { objects[ref - 1] = objects[ref - 1].replace('PAGES_PLACEHOLDER', `${pagesObj} 0 R`); });
  const catalogObj = addObject(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

export function sendStructuredReportExport(res, options) {
  const { filename, format } = options;
  if (format === 'pdf') {
    const buffer = buildStructuredPdf(options);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    res.send(buffer);
    return;
  }
  const xml = buildStructuredExcelXml(options);
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xls"`);
  res.send(`\uFEFF${xml}`);
}
