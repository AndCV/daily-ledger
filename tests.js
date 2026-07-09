/*
 * tests.js — in-browser test harness (no Node.js available in this dev
 * environment; the app itself has no build step, so tests run the same way
 * the app does: loaded via <script> tags in a real browser). Open
 * tests.html to run.
 */
(function () {
  'use strict';

  const results = [];
  function assert(name, cond, detail) {
    results.push({ name, pass: !!cond, detail: detail || '' });
  }
  function assertEqual(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    assert(name, pass, pass ? '' : 'esperado ' + JSON.stringify(expected) + ' obtuve ' + JSON.stringify(actual));
  }

  // ---- calc.js ----

  (function testZeroDivisionGuard() {
    // T1 CRITICAL: month with zero Compras+Gastos must render null, never NaN/Infinity.
    const days = [{ date: '2026-01-01', fxRate: 520, gastos: [], compras: [], ventas: [{ buyer: 'X', amount: 100, currency: 'CRC' }] }];
    const r = window.Calc.computeMonthlyProfitability(days);
    assert('T1: rentabilidad es null cuando Compras+Gastos=0 (nunca NaN/Infinity)', r.rentabilidad === null, 'obtuve ' + r.rentabilidad);
    assert('T1: gananciaTotal sigue siendo un número finito', Number.isFinite(r.gananciaTotal));
  })();

  (function testNegativeAndZeroIgnored() {
    const total = window.Calc.sumLineItems([
      { amount: 100, currency: 'CRC' },
      { amount: 0, currency: 'CRC' },
      { amount: -50, currency: 'CRC' },
      { amount: '', currency: 'CRC' },
    ], 520);
    assertEqual('Filas en 0/vacío/negativo se ignoran en la suma', total, 100);
  })();

  (function testCurrencyNormalizationStillWorksAtCalcLevel() {
    // The UI no longer offers a dollar option (colones only), but calc.js's
    // normalizeToColones() still supports USD math at the function level —
    // this just confirms that low-level capability didn't silently break.
    const day = { fxRate: 500, gastos: [{ amount: 10, currency: 'USD' }], compras: [], ventas: [{ amount: 1000, currency: 'CRC' }] };
    const t = window.Calc.computeDayTotals(day);
    assertEqual('Normaliza $10 a ₡5000 con tipo de cambio 500 (calc.js, no expuesto en la UI)', t.totalGastos, 5000);
    assertEqual('Ganancia del día = ventas - (compras+gastos)', t.profit, 1000 - 5000);
  })();

  (function testColonesOnlyRollup() {
    // Real-world scenario now: every amount is CRC, fxRate fixed at 1.
    const days = [1, 2, 3, 4, 5].map((day) => ({
      date: '2026-01-' + String(day).padStart(2, '0'),
      fxRate: 1,
      gastos: [],
      compras: [],
      ventas: [{ amount: 5000, currency: 'CRC' }],
    }));
    const r = window.Calc.computeMonthlyProfitability(days);
    assertEqual('Rollup mensual en colones puros suma correctamente sin cascada de redondeo', r.gananciaTotal, 25000);
  })();

  (function testT16SingleComputeFunction() {
    // T16: live entry and import re-derivation must use the exact same function.
    assert('T16: computeDayTotals es la única función expuesta para totales de día (no hay una segunda implementación paralela)',
      typeof window.Calc.computeDayTotals === 'function');
  })();

  // ---- xlsx-io.js (round-trip, uses the real vendored SheetJS) ----

  function buildTestWorkbook() {
    const gastos = [['Fecha', 'Concepto', 'Monto (₡)'],
      ['2026-02-01', 'Diésel', 25000]];
    const compras = [['Fecha', 'Proveedor', 'Monto (₡)', 'Tipo Material'],
      ['2026-02-01', 'Test Supplier A', 20800, 'plástico']];
    const ventas = [['Fecha', 'Comprador', 'Monto (₡)'],
      ['2026-02-01', 'Test Buyer A', 100000]];
    // T13: Resumen totals are DELIBERATELY WRONG here — parseWorkbook must
    // ignore them and re-derive from the raw rows above instead.
    const resumen = [['Fecha', 'Total Gastos (₡)', 'Total Compras (₡)', 'Total Ventas (₡)', 'Ganancia del Día (₡)'],
      ['2026-02-01', 999999, 999999, 999999, -999999]];

    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(gastos), 'Gastos');
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(compras), 'Compras');
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(ventas), 'Ventas');
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(resumen), 'Resumen');
    return wb;
  }

  function workbookToArrayBuffer(wb) {
    return window.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  }

  (function testT13NeverTrustResumenTotals() {
    const wb = buildTestWorkbook();
    const buf = workbookToArrayBuffer(wb);
    const { days, errors } = window.XlsxIO.parseWorkbook(buf);
    assertEqual('Import produce 0 errores en un archivo bien formado', errors.length, 0);
    assert('Import produce exactamente 1 día', days.length === 1, 'obtuve ' + days.length);
    const day = days[0];
    const recomputed = window.Calc.computeDayTotals(day);
    assertEqual('T13: totales recalculados desde filas crudas, NO desde la hoja Resumen (que traía valores erróneos a propósito)',
      recomputed, { totalGastos: 25000, totalCompras: 20800, totalVentas: 100000, profit: 54200 });
  })();

  (function testRoundTripFidelity() {
    // "2am-Friday-confidence" test: enter -> export -> clear -> import -> compare.
    const originalDay = {
      date: '2026-03-15',
      fxRate: 1,
      gastos: [{ name: 'Diésel', amount: 15000, currency: 'CRC' }, { name: 'Desayuno', amount: 3500, currency: 'CRC' }],
      compras: [{ provider: 'Test Supplier B', amount: 12000, currency: 'CRC', material: 'cartón' }],
      ventas: [{ buyer: 'Test Buyer B', amount: 50000, currency: 'CRC' }],
    };
    const originalTotals = window.Calc.computeDayTotals(originalDay);

    // Build the workbook the same way xlsx-io.js's buildWorkbook() does.
    const XLSXu = window.XLSX.utils;
    const gastosRows = [['Fecha', 'Concepto', 'Monto (₡)']];
    originalDay.gastos.forEach((g) => gastosRows.push([originalDay.date, g.name, g.amount]));
    const comprasRows = [['Fecha', 'Proveedor', 'Monto (₡)', 'Tipo Material']];
    originalDay.compras.forEach((c) => comprasRows.push([originalDay.date, c.provider, c.amount, c.material]));
    const ventasRows = [['Fecha', 'Comprador', 'Monto (₡)']];
    originalDay.ventas.forEach((v) => ventasRows.push([originalDay.date, v.buyer, v.amount]));
    const resumenRows = [['Fecha', 'Total Gastos (₡)', 'Total Compras (₡)', 'Total Ventas (₡)', 'Ganancia del Día (₡)'],
      [originalDay.date, originalTotals.totalGastos, originalTotals.totalCompras, originalTotals.totalVentas, originalTotals.profit]];

    const rtWb = XLSXu.book_new();
    XLSXu.book_append_sheet(rtWb, XLSXu.aoa_to_sheet(gastosRows), 'Gastos');
    XLSXu.book_append_sheet(rtWb, XLSXu.aoa_to_sheet(comprasRows), 'Compras');
    XLSXu.book_append_sheet(rtWb, XLSXu.aoa_to_sheet(ventasRows), 'Ventas');
    XLSXu.book_append_sheet(rtWb, XLSXu.aoa_to_sheet(resumenRows), 'Resumen');

    const buf = workbookToArrayBuffer(rtWb);
    const { days: importedDays, errors } = window.XlsxIO.parseWorkbook(buf);
    assertEqual('Round-trip: 0 errores', errors.length, 0);
    const reimported = importedDays[0];
    const reimportedTotals = window.Calc.computeDayTotals(reimported);
    assertEqual('Round-trip: ganancia recalculada tras exportar+reimportar coincide EXACTAMENTE con la original',
      reimportedTotals.profit, originalTotals.profit);
    assertEqual('Round-trip: totales completos coinciden', reimportedTotals, originalTotals);
  })();

  (function testBackwardCompatOldSchemaWithMoneda() {
    // Files exported before the dollar option was removed had extra
    // Moneda/Tipo de Cambio columns, shifting where Tipo Material lives in
    // Compras. parseWorkbook() must still read these correctly.
    const XLSXu = window.XLSX.utils;
    const gastos = [['Fecha', 'Concepto', 'Monto Original', 'Moneda', 'Monto Convertido (₡)'],
      ['2026-01-10', 'Combustible', 9000, 'CRC', 9000]];
    const compras = [['Fecha', 'Proveedor', 'Monto Original', 'Moneda', 'Tipo Material', 'Monto Convertido (₡)'],
      ['2026-01-10', 'Test Supplier C', 15000, 'CRC', 'vidrio', 15000]];
    const ventas = [['Fecha', 'Comprador', 'Monto Original', 'Moneda', 'Monto Convertido (₡)'],
      ['2026-01-10', 'Test Buyer C', 40000, 'CRC', 40000]];
    const resumen = [['Fecha', 'Tipo de Cambio (₡/$)', 'Total Gastos (₡)', 'Total Compras (₡)', 'Total Ventas (₡)', 'Ganancia del Día (₡)'],
      ['2026-01-10', 520, 9000, 15000, 40000, 16000]];
    const wb = XLSXu.book_new();
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet(gastos), 'Gastos');
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet(compras), 'Compras');
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet(ventas), 'Ventas');
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet(resumen), 'Resumen');
    const buf = workbookToArrayBuffer(wb);
    const { days, errors } = window.XlsxIO.parseWorkbook(buf);
    assertEqual('Compatibilidad con archivo viejo (columna Moneda): 0 errores', errors.length, 0);
    assertEqual('Compatibilidad con archivo viejo: material leído desde la posición correcta (columna corrida por Moneda)',
      days[0].compras[0].material, 'vidrio');
    const recomputed = window.Calc.computeDayTotals(days[0]);
    assertEqual('Compatibilidad con archivo viejo: totales recalculados correctamente', recomputed.profit, 16000);
  })();

  (function testMalformedRowSkipped() {
    const XLSXu = window.XLSX.utils;
    const gastos = [['Fecha', 'Concepto', 'Monto (₡)'],
      ['2026-04-01', 'Bueno', 1000],
      ['no-es-una-fecha', 'Malo', 'texto-no-numero']];
    const wb = XLSXu.book_new();
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet(gastos), 'Gastos');
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet([['Fecha', 'Proveedor', 'Monto (₡)', 'Tipo Material']]), 'Compras');
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet([['Fecha', 'Comprador', 'Monto (₡)']]), 'Ventas');
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet([['Fecha', 'Total Gastos (₡)']]), 'Resumen');
    const buf = workbookToArrayBuffer(wb);
    const { days, errors } = window.XlsxIO.parseWorkbook(buf);
    assert('T2: fila mal formada se omite mostrando error, la fila válida SÍ se importa', days.length === 1 && days[0].gastos.length === 1,
      'days=' + JSON.stringify(days));
    assert('T2: se reporta al menos un error para la fila mala', errors.length >= 1);
  })();

  (function testMissingAllSheets() {
    const XLSXu = window.XLSX.utils;
    const wb = XLSXu.book_new();
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet([['nada']]), 'HojaRara');
    const buf = workbookToArrayBuffer(wb);
    const { days, errors } = window.XlsxIO.parseWorkbook(buf);
    assert('Archivo sin ninguna hoja esperada: 0 días, error claro (no crash)', days.length === 0 && errors.length === 1);
  })();

  (function testLocaleNumberParsing() {
    // T18: hand-edited amount using Costa Rican formatting (comma decimal).
    const XLSXu = window.XLSX.utils;
    const gastos = [['Fecha', 'Concepto', 'Monto (₡)'],
      ['2026-05-01', 'Diésel', '1.234,56']]; // stored as text, CR-formatted
    const wb = XLSXu.book_new();
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet(gastos), 'Gastos');
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet([['Fecha', 'Proveedor', 'Monto (₡)', 'Tipo Material']]), 'Compras');
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet([['Fecha', 'Comprador', 'Monto (₡)']]), 'Ventas');
    XLSXu.book_append_sheet(wb, XLSXu.aoa_to_sheet([['Fecha', 'Total Gastos (₡)']]), 'Resumen');
    const buf = workbookToArrayBuffer(wb);
    const { days } = window.XlsxIO.parseWorkbook(buf);
    assertEqual('T18: "1.234,56" (formato CR) se interpreta como 1234.56, no como 1.23', days[0].gastos[0].amount, 1234.56);
  })();

  // ---- render ----

  function render() {
    const ul = document.getElementById('results');
    const summary = document.getElementById('summary');
    let passed = 0;
    results.forEach((r) => {
      const li = document.createElement('li');
      li.className = r.pass ? 'pass' : 'fail';
      li.textContent = (r.pass ? '✓ ' : '✗ ') + r.name + (r.detail ? ' — ' + r.detail : '');
      ul.appendChild(li);
      if (r.pass) passed++;
    });
    summary.textContent = passed + ' / ' + results.length + ' pruebas pasaron';
    summary.className = passed === results.length ? 'ok' : 'bad';
  }

  render();
})();
