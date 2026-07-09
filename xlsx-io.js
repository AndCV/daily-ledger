/*
 * xlsx-io.js — Excel export/import via the vendored SheetJS build (T19: no
 * runtime CDN dependency — the app loads vendor/xlsx.full.min.js locally,
 * which eliminates the CDN-outage risk (T4/T8) by construction).
 *
 * Sheets: Gastos, Compras, Ventas, Resumen (fecha, concepto/empresa, monto
 * en colones — per Success Criteria). Colones only — the dollar option and
 * exchange-rate column were removed; import still reads OLDER exported
 * files that had Moneda/Tipo de Cambio columns (detected by header), for
 * anyone with files from before that change.
 *
 * Import NEVER trusts the Resumen sheet's stated totals (T13) — totals are
 * always re-derived from the raw Gastos/Compras/Ventas rows via calc.js,
 * using the exact same computeDayTotals() function the live UI path uses
 * (T16), so live-entry and re-imported totals can never silently diverge.
 */
(function (global) {
  'use strict';

  function pad2(n) { return String(n).padStart(2, '0'); }

  function todayStamp() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function exportFilename() {
    // T12: dated filename, never a fixed name that silently overwrites.
    const d = new Date();
    const stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    return 'daily-ledger-' + stamp + '.xlsx';
  }

  function buildWorkbook(state) {
    const wb = global.XLSX.utils.book_new();

    const gastosRows = [['Fecha', 'Concepto', 'Monto (₡)']];
    const comprasRows = [['Fecha', 'Proveedor', 'Monto (₡)', 'Tipo Material']];
    const ventasRows = [['Fecha', 'Comprador', 'Monto (₡)']];
    const resumenRows = [['Fecha', 'Total Gastos (₡)', 'Total Compras (₡)', 'Total Ventas (₡)', 'Ganancia del Día (₡)']];

    const sortedDays = [...state.days].sort((a, b) => a.date.localeCompare(b.date));

    for (const day of sortedDays) {
      const totals = global.Calc.computeDayTotals(day);
      for (const g of day.gastos || []) {
        if (!g.amount || Number(g.amount) <= 0) continue;
        gastosRows.push([day.date, g.name, global.Calc.round2(Number(g.amount))]);
      }
      for (const c of day.compras || []) {
        if (!c.amount || Number(c.amount) <= 0) continue;
        comprasRows.push([day.date, c.provider, global.Calc.round2(Number(c.amount)), c.material || '']);
      }
      for (const v of day.ventas || []) {
        if (!v.amount || Number(v.amount) <= 0) continue;
        ventasRows.push([day.date, v.buyer, global.Calc.round2(Number(v.amount))]);
      }
      resumenRows.push([day.date, totals.totalGastos, totals.totalCompras, totals.totalVentas, totals.profit]);
    }

    // Monthly summary block appended at the bottom of Resumen, per Success
    // Criteria ("una hoja de Resumen con la ganancia por día y, al final del
    // mes, los totales y la rentabilidad mensual").
    const monthly = global.Calc.computeMonthlyProfitability(sortedDays);
    resumenRows.push([]);
    resumenRows.push(['TOTALES DEL MES']);
    resumenRows.push(['Ganancia total (₡)', monthly.gananciaTotal]);
    resumenRows.push(['Compras + Gastos totales (₡)', monthly.comprasGastosTotal]);
    resumenRows.push(['Rentabilidad del mes (%)', monthly.rentabilidad === null ? 'N/A (sin compras/gastos)' : monthly.rentabilidad]);

    global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.aoa_to_sheet(gastosRows), 'Gastos');
    global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.aoa_to_sheet(comprasRows), 'Compras');
    global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.aoa_to_sheet(ventasRows), 'Ventas');
    global.XLSX.utils.book_append_sheet(wb, global.XLSX.utils.aoa_to_sheet(resumenRows), 'Resumen');

    return wb;
  }

  function buildXlsxBlob(state) {
    const wb = buildWorkbook(state);
    const arrayBuffer = global.XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true });
    return new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // T17: iOS Safari does not reliably support programmatic <a download> to a
  // filesystem location the way desktop browsers do — it routes through the
  // Share Sheet. Building the Blob ourselves (instead of XLSX.writeFile)
  // lets us trigger the same download AND reuse the exact bytes for the
  // optional Google Drive upload (drive.js), so both destinations are
  // guaranteed byte-identical.
  function exportToExcel(state) {
    try {
      const filename = exportFilename();
      const blob = buildXlsxBlob(state);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return { ok: true, filename, blob };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  // --- Import ---

  const REQUIRED_SHEETS = ['Gastos', 'Compras', 'Ventas', 'Resumen'];

  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (v == null || v === '') return 0;
    // T18: tolerate Costa Rican formatting (comma decimal, period thousands)
    // if a cell was hand-edited as text instead of a native Excel number.
    let s = String(v).trim();
    if (/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(s)) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  // Parses an ArrayBuffer into { days, errors }. Never throws — malformed
  // rows are skipped and reported in `errors`, valid rows still import (T2).
  function parseWorkbook(arrayBuffer) {
    const errors = [];
    let wb;
    try {
      wb = global.XLSX.read(arrayBuffer, { type: 'array' });
    } catch (e) {
      return { days: [], errors: [{ type: 'InvalidFileFormatError', message: 'El archivo no es un Excel válido.' }] };
    }

    const missing = REQUIRED_SHEETS.filter((s) => !wb.SheetNames.includes(s));
    if (missing.length === REQUIRED_SHEETS.length) {
      return { days: [], errors: [{ type: 'MissingSheetError', message: 'El archivo no tiene el formato esperado (faltan todas las hojas).' }] };
    }
    for (const s of missing) {
      errors.push({ type: 'MissingSheetError', message: 'Falta la hoja "' + s + '" — se continúa sin esos datos.' });
    }

    // Colones only now — fxRate is a fixed internal constant (see app.js),
    // never read from the file. Kept on the day object only because
    // calc.js's normalizeToColones() signature still accepts it (unused
    // whenever currency is 'CRC', which it always is).
    const daysByDate = {};
    function ensureDay(dateStr) {
      if (!daysByDate[dateStr]) {
        daysByDate[dateStr] = {
          date: dateStr,
          fxRate: 1,
          gastos: [], compras: [], ventas: [],
        };
      }
      return daysByDate[dateStr];
    }

    // Older exported files had a "Moneda" column (before the dollar option
    // was removed) which shifts where "Tipo Material" lives in Compras.
    // Detect it from the header row so both old and new files import.
    function readSheet(name, handler) {
      if (!wb.SheetNames.includes(name)) return;
      const rows = global.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 });
      if (rows.length === 0) return;
      const header = (rows[0] || []).map((h) => String(h || '').toLowerCase());
      const hasMoneda = header.some((h) => h.includes('moneda'));
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length === 0) continue;
        try {
          handler(r, hasMoneda);
        } catch (e) {
          errors.push({ type: 'MalformedRowError', message: 'Fila ' + (i + 1) + ' de "' + name + '" no se pudo leer, se omitió.' });
        }
      }
    }

    readSheet('Gastos', (r) => {
      const dateStr = normalizeDateCell(r[0]);
      if (!dateStr) throw new Error('bad date');
      const day = ensureDay(dateStr);
      const amount = toNumber(r[2]);
      if (amount <= 0) return;
      day.gastos.push({ name: String(r[1] || 'Gasto'), amount, currency: 'CRC' });
    });

    readSheet('Compras', (r, hasMoneda) => {
      const dateStr = normalizeDateCell(r[0]);
      if (!dateStr) throw new Error('bad date');
      const day = ensureDay(dateStr);
      const amount = toNumber(r[2]);
      if (amount <= 0) return;
      const material = hasMoneda ? (r[4] || '') : (r[3] || ''); // old format had Moneda at 3, Tipo Material at 4
      day.compras.push({ provider: String(r[1] || 'Proveedor'), amount, currency: 'CRC', material });
    });

    readSheet('Ventas', (r) => {
      const dateStr = normalizeDateCell(r[0]);
      if (!dateStr) throw new Error('bad date');
      const day = ensureDay(dateStr);
      const amount = toNumber(r[2]);
      if (amount <= 0) return;
      day.ventas.push({ buyer: String(r[1] || 'Comprador'), amount, currency: 'CRC' });
    });

    const days = Object.values(daysByDate);
    // T13: never trust the Resumen sheet's stated totals — re-derive every
    // day's totals from the raw rows via the SAME computeDayTotals() the
    // live UI uses (T16), so live-entry and re-import can never silently
    // diverge. We don't even read the Resumen totals columns above.
    for (const day of days) {
      day._recomputedTotals = global.Calc.computeDayTotals(day);
    }

    return { days, errors };
  }

  function normalizeDateCell(v) {
    if (v instanceof Date) {
      return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
    }
    if (typeof v === 'number') {
      // Excel serial date.
      const d = global.XLSX.SSF ? global.XLSX.SSF.parse_date_code(v) : null;
      if (d) return d.y + '-' + pad2(d.m) + '-' + pad2(d.d);
      return null;
    }
    const s = String(v || '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? m[0].slice(0, 10) : null;
  }

  global.XlsxIO = {
    exportToExcel,
    parseWorkbook,
    exportFilename,
  };
})(window);
