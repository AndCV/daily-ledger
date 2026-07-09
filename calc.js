/*
 * calc.js — pure calculation functions, no DOM access.
 * Money is normalized to colones (CRC) for summing/comparison, per Constraints
 * (each amount+currency pair is converted at capture time using that day's FX rate).
 */
(function (global) {
  'use strict';

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  // Normalizes one amount+currency pair to colones using the given FX rate
  // (colones per dollar). Rounds once, at conversion time — never re-rounded
  // in cascade when summed later (Constraints: "no se re-redondea en cascada").
  function normalizeToColones(amount, currency, fxRate) {
    const n = Number(amount) || 0;
    if (currency === 'USD') {
      return round2(n * fxRate);
    }
    return round2(n);
  }

  // Sums an array of {amount, currency} line items into total colones.
  // Ignores rows with amount <= 0 or missing amount (Constraints: zero/empty
  // rows are ignored in calculations, not blocking).
  function sumLineItems(items, fxRate) {
    let total = 0;
    for (const item of items || []) {
      const n = Number(item.amount);
      if (!n || n <= 0) continue;
      total += normalizeToColones(n, item.currency, fxRate);
    }
    return round2(total);
  }

  // Single source of truth for a day's totals and profit. Called identically
  // from the live-entry UI path and from xlsx-io.js's import re-derivation
  // path (T13/T16) — never two independent implementations.
  function computeDayTotals(day) {
    const fxRate = Number(day.fxRate) || 0;
    const totalGastos = sumLineItems(day.gastos, fxRate);
    const totalCompras = sumLineItems(day.compras, fxRate);
    const totalVentas = sumLineItems(day.ventas, fxRate);
    const profit = round2(totalVentas - (totalCompras + totalGastos));
    return { totalGastos, totalCompras, totalVentas, profit };
  }

  // Monthly profitability = (ganancia total / (compras + gastos totales)) * 100.
  // Guards division by zero (T1): returns null when the denominator is 0,
  // caller must render "—" / "N/A", never NaN/Infinity.
  function computeMonthlyProfitability(days) {
    let gananciaTotal = 0;
    let comprasGastosTotal = 0;
    for (const day of days || []) {
      const t = computeDayTotals(day);
      gananciaTotal += t.profit;
      comprasGastosTotal += t.totalCompras + t.totalGastos;
    }
    gananciaTotal = round2(gananciaTotal);
    comprasGastosTotal = round2(comprasGastosTotal);
    if (comprasGastosTotal === 0) {
      return { gananciaTotal, comprasGastosTotal, rentabilidad: null };
    }
    const rentabilidad = round2((gananciaTotal / comprasGastosTotal) * 100);
    return { gananciaTotal, comprasGastosTotal, rentabilidad };
  }

  function formatCRC(n) {
    return '₡' + Number(n).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  global.Calc = {
    round2,
    normalizeToColones,
    sumLineItems,
    computeDayTotals,
    computeMonthlyProfitability,
    formatCRC,
  };
})(window);
