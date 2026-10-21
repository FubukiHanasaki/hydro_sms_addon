/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
const { parentPort, workerData } = require('node:worker_threads');
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');
try {
  const bytes = Buffer.from(workerData.bytes), ext = workerData.ext;
  let sheets = ['CSV'], table, errors = {};
  if (ext === 'csv') {
    let value;
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { value = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
    const records = parse(value, { bom: true, skip_empty_lines: false, relax_column_count: true, max_record_size: 16000, to: 1002 });
    if (records.length > 1001) throw Error('每次最多导入 1000 行，请拆分文件');
    table = records;
  } else {
    // Bound decompression before passing ZIP contents to the workbook reader.
    if (ext === 'xlsx') {
      let end = -1;
      for (let n = bytes.length - 22; n >= Math.max(0, bytes.length - 65557); n--) if (bytes.readUInt32LE(n) === 0x06054b50) { end = n; break; }
      if (end < 0) throw Error('Excel 压缩包不完整');
      const count = bytes.readUInt16LE(end + 10); let pos = bytes.readUInt32LE(end + 16), total = 0;
      if (count > 2000 || count === 65535) throw Error('Excel 内部文件过多');
      for (let n = 0; n < count; n++) {
        if (pos + 46 > bytes.length || bytes.readUInt32LE(pos) !== 0x02014b50) throw Error('Excel 压缩目录无效');
        const flags = bytes.readUInt16LE(pos + 8), method = bytes.readUInt16LE(pos + 10), packed = bytes.readUInt32LE(pos + 20), size = bytes.readUInt32LE(pos + 24), local = bytes.readUInt32LE(pos + 42);
        total += size;
        if (flags & 1 || size > 8 * 1024 * 1024 || total > 16 * 1024 * 1024 || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw Error('Excel 内容过大、加密或格式无效');
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        if (start + packed > bytes.length || ![0,8].includes(method)) throw Error('Excel 压缩格式无效');
        const actual = method === 8 ? require('node:zlib').inflateRawSync(bytes.subarray(start,start+packed), { maxOutputLength: 8 * 1024 * 1024 }) : bytes.subarray(start,start+packed);
        if (actual.length !== size) throw Error('Excel 压缩数据无效');
        pos += 46 + bytes.readUInt16LE(pos + 28) + bytes.readUInt16LE(pos + 30) + bytes.readUInt16LE(pos + 32);
      }
    }
    const book = XLSX.read(bytes, { type: 'buffer', cellDates: false, cellNF: true, cellFormula: true, sheetRows: 1002, bookVBA: false });
    sheets = book.SheetNames;
    if (!sheets.length || sheets.length > 50) throw Error('工作表数量无效（最多 50 张）');
    const selected = workerData.sheet || sheets[0];
    if (!sheets.includes(selected)) throw Error('工作表不存在');
    const sheet = book.Sheets[selected];
    if (!sheet['!ref']) throw Error('工作表为空');
    const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref']);
    if (range.e.r > 1000 || range.e.c > 49) throw Error('每张表最多 1000 行资料、50 列，请清理多余行列');
    table = [];
    for (let r = 0; r <= range.e.r; r++) {
      const row = [];
      for (let col = 0; col <= range.e.c; col++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c: col })];
        let value = '';
        if (cell) {
          if (cell.f || cell.t === 'e') { (errors[r + 1] ||= []).push(`第 ${col + 1} 列含公式或错误，请改为值`); }
          else if (cell.t === 'n' && XLSX.SSF.is_date(cell.z || '')) {
            const date = XLSX.SSF.parse_date_code(cell.v, { date1904: !!book.Workbook?.WBProps?.date1904 });
            if(date && /[hs]/i.test(cell.z||'') && !/[yd]/i.test(cell.z||'')) value=`${String(date.H).padStart(2,'0')}:${String(date.M).padStart(2,'0')}`;
            else if (date) value = `${date.y}-${String(date.m).padStart(2,'0')}-${String(date.d).padStart(2,'0')}`;
          } else if (cell.v != null) value = cell.t === 'n' && (!cell.z || cell.z === 'General') ? String(cell.v) : XLSX.utils.format_cell(cell);
        }
        row.push(String(value).trim());
      }
      table.push(row);
    }
    workerData.sheet = selected;
  }
  if (!table?.length || table[0].length > 50 || table.some(r => r.length > 50)) throw Error('表格为空或超过 50 列');
  const headers = table[0].map(v => String(v).replace(/^\uFEFF/,'').trim());
  if (headers.some(h => h.length > 100) || errors[1]?.length) throw Error('表头格式无效，第一行必须为字段名称');
  const rows = table.slice(1).map((values, n) => ({ row: n + 2, values: values.map(v => String(v).trim()), errors: errors[n + 2] || [] })).filter(r => r.values.some(Boolean) || r.errors.length);
  if (!rows.length) throw Error('没有学生资料行');
  parentPort.postMessage({ sheets, sheet: workerData.sheet || 'CSV', headers, rows });
} catch (e) { parentPort.postMessage({ error: e.message || '无法读取文件' }); }
