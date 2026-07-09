/*
 * app.js — UI orchestration. Depends on Calc, Storage, XlsxIO (loaded first).
 */
(function () {
  'use strict';

  // ---------- State ----------

  // Colones only — the dollar option was removed per explicit request (the
  // team never actually bills in dollars in practice). `fxRate: 1` is kept
  // as an internal constant only so calc.js's normalizeToColones() signature
  // doesn't need to change; every row's currency is always 'CRC', so it's
  // never actually used in the conversion math.
  const FIXED_FX_RATE = 1;

  // Starter examples only — fully editable in the app (add/remove freely).
  // Swap these for your own real providers/buyers before deploying.
  const state = {
    providers: ['Proveedor Ejemplo 1', 'Proveedor Ejemplo 2', 'Proveedor Ejemplo 3'],
    buyers: ['Comprador Ejemplo 1', 'Comprador Ejemplo 2'],
    gastoNames: ['Desayuno', 'Almuerzo', 'Cena', 'Ayudante', 'Diésel'],
    days: [], // saved days this session
    unexportedDates: new Set(),
    lastImportSnapshot: null,
    editingDate: null, // set when D11 edit-in-place is active
  };

  let currentDay = makeEmptyDay(todayISO());

  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function makeEmptyDay(dateStr) {
    return {
      date: dateStr,
      fxRate: FIXED_FX_RATE,
      gastos: state.gastoNames.map((name) => ({ name, amount: '', currency: 'CRC' })),
      compras: [],
      ventas: [],
    };
  }

  // ---------- Accordion (T15: one explicit state function, used by D5 and D11) ----------

  let openSectionKey = null;

  function setOpenSection(key) {
    openSectionKey = key;
    document.querySelectorAll('.accordion-section').forEach((sec) => {
      const k = sec.dataset.section;
      const body = sec.querySelector('.accordion-body');
      const header = sec.querySelector('.accordion-header');
      const chevron = sec.querySelector('.accordion-chevron');
      const isOpen = k === key;
      body.hidden = !isOpen;
      chevron.textContent = isOpen ? '▴' : '▾';
      sec.classList.toggle('open', isOpen);
      header.setAttribute('aria-expanded', String(isOpen)); // screen readers: announce open/closed state
    });
  }

  function initAccordionHandlers() {
    document.querySelectorAll('.accordion-header').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.target;
        setOpenSection(openSectionKey === key ? null : key);
      });
    });
  }

  // ---------- Row rendering ----------

  function rowTemplate(kind, index, row) {
    const wrap = document.createElement('div');
    wrap.className = 'row';
    wrap.dataset.index = String(index);

    const nameLabel = kind === 'compras' ? 'Proveedor' : kind === 'ventas' ? 'Comprador' : 'Concepto';
    const rowName = kind === 'compras' ? (row.provider || '') : kind === 'ventas' ? (row.buyer || '') : (row.name || '');

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'row-name';
    nameInput.placeholder = nameLabel;
    nameInput.setAttribute('aria-label', nameLabel);
    nameInput.value = rowName;
    const listId = kind + '-suggestions';
    nameInput.setAttribute('list', listId);
    nameInput.addEventListener('input', () => {
      if (kind === 'compras') row.provider = nameInput.value;
      else if (kind === 'ventas') row.buyer = nameInput.value;
      else row.name = nameInput.value;
      saveDraftDebounced(); // bug fix: name-only edits were never persisted to the draft
    });
    nameInput.addEventListener('change', () => rememberName(kind, nameInput.value));

    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.step = '0.01';
    amountInput.min = '0';
    amountInput.className = 'row-amount';
    amountInput.placeholder = '0.00';
    amountInput.setAttribute('aria-label', 'Monto' + (rowName ? ' — ' + rowName : ''));
    amountInput.value = row.amount === '' || row.amount == null ? '' : row.amount;
    amountInput.addEventListener('input', () => {
      // Negative amounts not allowed (Constraints: "no permitidos, usar 0
      // como mínimo") — clamp immediately rather than letting a negative
      // value reach calc.js.
      if (amountInput.value !== '' && Number(amountInput.value) < 0) {
        amountInput.value = '0';
      }
      row.amount = amountInput.value;
      recomputeAndRender();
    });

    // Dollar option removed — everything is colones now (row.currency stays
    // 'CRC', set once in makeEmptyDay()/row creation, never shown or edited).

    wrap.appendChild(nameInput);
    wrap.appendChild(amountInput);

    if (kind === 'compras') {
      const materialSelect = document.createElement('select');
      materialSelect.className = 'row-material';
      materialSelect.innerHTML = '<option value="">Material (opcional)</option><option value="plástico">Plástico</option><option value="cartón">Cartón</option><option value="vidrio">Vidrio</option>';
      materialSelect.value = row.material || '';
      materialSelect.addEventListener('change', () => { row.material = materialSelect.value; saveDraftDebounced(); });
      wrap.appendChild(materialSelect);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'row-remove';
    removeBtn.setAttribute('aria-label', 'Quitar fila');
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      currentDay[kind].splice(index, 1);
      renderRows(kind);
      recomputeAndRender();
    });
    wrap.appendChild(removeBtn);

    return wrap;
  }

  function rememberName(kind, name) {
    if (!name) return;
    if (kind === 'compras') {
      if (!state.providers.includes(name)) state.providers.push(name);
    } else if (kind === 'ventas') {
      if (!state.buyers.includes(name)) state.buyers.push(name);
    } else {
      if (!state.gastoNames.includes(name)) state.gastoNames.push(name);
    }
    renderDatalists();
  }

  function renderDatalists() {
    setDatalist('gastos-suggestions', state.gastoNames);
    setDatalist('compras-suggestions', state.providers);
    setDatalist('ventas-suggestions', state.buyers);
  }

  function setDatalist(id, names) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('datalist');
      el.id = id;
      document.body.appendChild(el);
    }
    el.innerHTML = names.map((n) => '<option value="' + escapeHtml(n) + '">').join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderRows(kind) {
    const container = document.getElementById(kind + '-rows');
    container.innerHTML = '';
    currentDay[kind].forEach((row, i) => container.appendChild(rowTemplate(kind, i, row)));
  }

  function renderAllRows() {
    renderRows('gastos');
    renderRows('compras');
    renderRows('ventas');
  }

  // ---------- Totals / summary ----------

  function recomputeAndRender() {
    const totals = window.Calc.computeDayTotals(currentDay);
    document.querySelector('[data-total="gastos"]').textContent = window.Calc.formatCRC(totals.totalGastos);
    document.querySelector('[data-total="compras"]').textContent = window.Calc.formatCRC(totals.totalCompras);
    document.querySelector('[data-total="ventas"]').textContent = window.Calc.formatCRC(totals.totalVentas);
    document.querySelector('[data-total="profit"]').textContent = window.Calc.formatCRC(totals.profit);
    document.getElementById('summary-gastos').textContent = window.Calc.formatCRC(totals.totalGastos);
    document.getElementById('summary-compras').textContent = window.Calc.formatCRC(totals.totalCompras);
    document.getElementById('summary-ventas').textContent = window.Calc.formatCRC(totals.totalVentas);
    document.getElementById('summary-profit').textContent = window.Calc.formatCRC(totals.profit);
    saveDraftDebounced();
  }

  function renderMonthly() {
    const monthly = window.Calc.computeMonthlyProfitability(state.days);
    document.getElementById('monthly-profit').textContent = window.Calc.formatCRC(monthly.gananciaTotal);
    document.getElementById('monthly-rentabilidad').textContent = monthly.rentabilidad === null ? '—' : monthly.rentabilidad.toFixed(2) + '%';
  }

  function renderSavedDays() {
    const tbody = document.getElementById('saved-days-tbody');
    const empty = document.getElementById('saved-days-empty');
    const wrap = document.getElementById('saved-days-table-wrap');
    if (state.days.length === 0) {
      empty.hidden = false;
      wrap.hidden = true;
      renderMonthly();
      return;
    }
    empty.hidden = true;
    wrap.hidden = false;
    const today = todayISO();
    const sorted = [...state.days].sort((a, b) => {
      // D12: pin today at the top regardless of sort order.
      if (a.date === today) return -1;
      if (b.date === today) return 1;
      return b.date.localeCompare(a.date);
    });
    tbody.innerHTML = '';
    for (const day of sorted) {
      const totals = window.Calc.computeDayTotals(day);
      const tr = document.createElement('tr');
      if (day.date === today) tr.classList.add('today-row');
      const unexported = state.unexportedDates.has(day.date);
      tr.innerHTML =
        '<td><div class="date-cell">' + escapeHtml(day.date) + (day.date === today ? ' <span class="pill">Hoy</span>' : '') +
        (unexported ? ' <span class="pill pill-warning">Sin exportar</span>' : '') + '</div></td>' +
        '<td class="' + (totals.profit >= 0 ? 'profit-pos' : 'profit-neg') + '">' + window.Calc.formatCRC(totals.profit) + '</td>' +
        '<td><button type="button" class="btn btn-text edit-day-btn" data-date="' + escapeHtml(day.date) + '">Editar</button></td>';
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.edit-day-btn').forEach((btn) => {
      btn.addEventListener('click', () => editDay(btn.dataset.date));
    });
    renderMonthly();
  }

  // ---------- Draft autosave ----------

  let draftTimer = null;
  function saveDraftDebounced() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => window.Storage.saveDraft(currentDay), 300);
  }

  // ---------- Save day (T14: debounce double-tap; T8/D8: forced export flow) ----------

  let saveInFlight = false;

  function saveDay() {
    if (saveInFlight) return;
    saveInFlight = true;
    const saveBtn = document.getElementById('save-day-btn');
    saveBtn.disabled = true;

    try {
      const dateStr = document.getElementById('day-date').value;
      if (!dateStr) {
        showToast('Elegí una fecha antes de guardar.');
        return;
      }
      const hasAnyAmount = ['gastos', 'compras', 'ventas'].some((kind) =>
        currentDay[kind].some((r) => Number(r.amount) > 0));
      if (!hasAnyAmount) {
        showToast('Agregá al menos un monto en Gastos, Compras o Ventas antes de guardar.');
        return;
      }

      currentDay.date = dateStr;

      const existingIndex = state.days.findIndex((d) => d.date === dateStr);
      if (existingIndex >= 0 && state.editingDate !== dateStr) {
        // D12: warn instead of silently allowing a duplicate date save.
        showDialog({
          title: 'Ya existe un día con esta fecha',
          body: '¿Querés reemplazar los datos guardados de ' + dateStr + ' con los del formulario actual?',
          buttons: [
            { label: 'Cancelar', variant: 'secondary', onClick: closeDialog },
            { label: 'Reemplazar', variant: 'primary', onClick: () => { closeDialog(); commitSave(existingIndex); } },
          ],
        });
        return;
      }
      commitSave(existingIndex);
    } finally {
      saveInFlight = false;
      saveBtn.disabled = false;
    }
  }

  // Persists the full accumulated day list to localStorage so a refresh
  // never loses a day the user already confirmed with "Guardar día". This
  // is the app's real day-to-day working store now — Excel export is the
  // end-of-month deliverable, not the only thing standing between the user
  // and data loss (that changed from the original forced-export-per-day
  // design based on real usage: the owner's team wants to just hit Guardar
  // and keep going, exporting once at month's end).
  function persistDays() {
    window.Storage.saveDays(state.days);
  }

  // Switches the working form to a blank day for `dateStr`, discarding
  // whatever was in the rows before (caller is responsible for confirming
  // that's OK — see the day-date change handler).
  function resetFormForDate(dateStr) {
    currentDay = makeEmptyDay(dateStr);
    state.editingDate = null;
    window.Storage.clearDraft();
    renderAllRows();
    recomputeAndRender();
  }

  function commitSave(existingIndex) {
    const dayCopy = JSON.parse(JSON.stringify(currentDay));
    if (existingIndex >= 0) {
      state.days[existingIndex] = dayCopy;
    } else {
      state.days.push(dayCopy);
    }
    state.editingDate = null;
    state.unexportedDates.add(dayCopy.date);
    window.Storage.clearDraft();
    persistDays();
    renderSavedDays();
    updateUnexportedBadge();
    showToast('Día guardado: ' + dayCopy.date + '. Queda guardado en este dispositivo aunque recargués la página.');

    // Start a fresh blank day for tomorrow-or-whatever-next, unless we were
    // mid-edit of a past day (D11) in which case stay put.
    currentDay = makeEmptyDay(todayISO());
    document.getElementById('day-date').value = currentDay.date;
    renderAllRows();
    recomputeAndRender();
  }

  function updateUnexportedBadge() {
    const badge = document.getElementById('unexported-badge');
    const text = document.getElementById('unexported-badge-text');
    const n = state.unexportedDates.size;
    if (n === 0) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    text.textContent = n === 1
      ? 'Tenés 1 día registrado, listo para exportar cuando quieras.'
      : 'Tenés ' + n + ' días registrados, listos para exportar cuando quieras.';
  }

  // ---------- Edit existing day in place (D11) ----------

  function editDay(dateStr) {
    const day = state.days.find((d) => d.date === dateStr);
    if (!day) return;
    currentDay = JSON.parse(JSON.stringify(day));
    state.editingDate = dateStr;
    document.getElementById('day-date').value = currentDay.date;
    renderAllRows();
    recomputeAndRender();
    setOpenSection('gastos');
    document.getElementById('day-date').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Editando ' + dateStr + ' — los cambios se aplican al tocar "Guardar día".');
  }

  // ---------- Export ----------

  // Identifies "this month's" Drive file by the earliest saved day's date,
  // not today's date — so the running file matches the data being
  // exported even if the device's clock has already rolled into a new
  // month before the previous one is closed.
  function currentMonthKey() {
    if (state.days.length === 0) return todayISO().slice(0, 7);
    const dates = state.days.map((d) => d.date).sort();
    return dates[0].slice(0, 7);
  }

  // Best-effort: the local download already succeeded by the time this
  // runs, so a Drive failure is surfaced but never blocks or reverses the
  // local export. Only fires if the user has connected Google Drive.
  //
  // Keeps ONE Drive file per month: repeated exports update that same file
  // in place (via the remembered fileId) instead of piling up a new file
  // each time. `finalizeMonth` (set by closeMonth) does one last update and
  // then forgets the fileId, so the next export — next month — starts a
  // fresh file.
  function maybeUploadToDrive(result, options) {
    const opts = options || {};
    if (!window.DriveUpload || !window.DriveUpload.isConnected()) return;
    const monthKey = currentMonthKey();
    const ref = window.Storage.getDriveFileRef();
    const fileId = ref && ref.monthKey === monthKey ? ref.fileId : null;
    const driveFilename = window.XlsxIO.monthlyFilename(monthKey);
    window.DriveUpload.uploadFile(result.blob, driveFilename, fileId)
      .then((driveFile) => {
        if (opts.finalizeMonth) {
          window.Storage.clearDriveFileRef();
        } else {
          window.Storage.setDriveFileRef({ fileId: driveFile.id, monthKey, filename: driveFile.name });
        }
        showToast('Subido a Google Drive: ' + driveFile.name);
      })
      .catch((e) => showToast('No se pudo subir a Google Drive (el Excel local sí se guardó). ' + e.message));
  }

  function doExport() {
    const result = window.XlsxIO.exportToExcel({ days: state.days });
    if (result.ok) {
      state.unexportedDates.clear();
      updateUnexportedBadge();
      renderSavedDays(); // refresh the "Sin exportar" pill in the saved-days table
      showToast('Exportado: ' + result.filename);
      maybeUploadToDrive(result);
    } else {
      showDialog({
        title: 'No se pudo exportar',
        body: 'Ocurrió un problema generando el archivo Excel. Intentá de nuevo. (' + result.error + ')',
        buttons: [{ label: 'Cerrar', variant: 'primary', onClick: closeDialog }],
      });
    }
  }

  // "Cerrar mes" — deliberately separate from "Exportar Excel" (T12/D8's
  // export stays a safe, repeatable backup action). This exports AND then
  // clears every saved day from this device, for when the user is truly
  // done with the month — not triggered automatically on every export.
  function doCloseMonth() {
    if (state.days.length === 0) {
      showToast('No hay días guardados este mes todavía.');
      return;
    }
    showDialog({
      title: 'Cerrar mes',
      body: 'Esto exporta el Excel del mes y después borra los ' + state.days.length +
        ' día(s) guardados de este dispositivo (van a quedar solo en el Excel). ¿Continuar?',
      buttons: [
        { label: 'Cancelar', variant: 'secondary', onClick: closeDialog },
        { label: 'Exportar y cerrar mes', variant: 'primary', onClick: () => { closeDialog(); closeMonth(); } },
      ],
    });
  }

  function closeMonth() {
    const result = window.XlsxIO.exportToExcel({ days: state.days });
    if (!result.ok) {
      showDialog({
        title: 'No se pudo exportar',
        body: 'No se cerró el mes — no se borró nada. Intentá de nuevo. (' + result.error + ')',
        buttons: [{ label: 'Cerrar', variant: 'primary', onClick: closeDialog }],
      });
      return;
    }
    state.days = [];
    state.unexportedDates.clear();
    state.lastImportSnapshot = null;
    persistDays();
    window.Storage.clearDraft();
    document.getElementById('undo-import-btn').hidden = true;
    renderSavedDays();
    updateUnexportedBadge();
    showToast('Mes cerrado. Excel exportado: ' + result.filename + '. Empezás un mes nuevo.');
    maybeUploadToDrive(result, { finalizeMonth: true });
  }

  // ---------- Import (D10: preview + batch-apply + one-step undo) ----------

  function doImport(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const { days: importedDays, errors } = window.XlsxIO.parseWorkbook(reader.result);
      if (importedDays.length === 0 && errors.length) {
        showDialog({
          title: 'No se pudo importar',
          body: errors.map((e) => e.message).join(' '),
          buttons: [{ label: 'Cerrar', variant: 'primary', onClick: closeDialog }],
        });
        return;
      }

      const duplicateDates = importedDays
        .map((d) => d.date)
        .filter((date) => state.days.some((existing) => existing.date === date));

      const applyImport = (overwrite) => {
        state.lastImportSnapshot = JSON.parse(JSON.stringify(state.days)); // D10: one-step undo
        for (const importedDay of importedDays) {
          const idx = state.days.findIndex((d) => d.date === importedDay.date);
          if (idx >= 0) {
            if (overwrite) state.days[idx] = importedDay;
          } else {
            state.days.push(importedDay);
          }
          // Merge provider/buyer/gasto names seen in the import into the
          // editable master lists.
          importedDay.gastos.forEach((g) => rememberName('gastos', g.name));
          importedDay.compras.forEach((c) => rememberName('compras', c.provider));
          importedDay.ventas.forEach((v) => rememberName('ventas', v.buyer));
        }
        persistDays();
        renderSavedDays();
        document.getElementById('undo-import-btn').hidden = false;
        let msg = 'Importados ' + importedDays.length + ' día(s).';
        if (errors.length) msg += ' (' + errors.length + ' fila(s) con problemas se omitieron)';
        showToast(msg);
      };

      if (duplicateDates.length > 0) {
        const first = [...duplicateDates].sort()[0];
        const last = [...duplicateDates].sort().slice(-1)[0];
        showDialog({
          title: duplicateDates.length + ' fecha(s) ya existen',
          body: 'El archivo trae ' + duplicateDates.length + ' fecha(s) que ya tenés cargadas en esta sesión (' +
            (duplicateDates.length > 1 ? first + ' a ' + last : first) + '). ¿Qué querés hacer?',
          buttons: [
            { label: 'Mantener lo actual', variant: 'secondary', onClick: () => { closeDialog(); applyImport(false); } },
            { label: 'Sobrescribir todas', variant: 'primary', onClick: () => { closeDialog(); applyImport(true); } },
          ],
        });
      } else {
        applyImport(true);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function undoLastImport() {
    if (!state.lastImportSnapshot) return;
    state.days = state.lastImportSnapshot;
    state.lastImportSnapshot = null;
    document.getElementById('undo-import-btn').hidden = true;
    persistDays();
    renderSavedDays();
    showToast('Importación deshecha.');
  }

  // ---------- Dialog / toast (D1 interaction-state UI) ----------

  function showDialog({ title, body, buttons }) {
    const overlay = document.getElementById('dialog-overlay');
    const box = document.getElementById('dialog-box');
    box.innerHTML = '<h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(body) + '</p>';
    const btnRow = document.createElement('div');
    btnRow.className = 'dialog-buttons';
    buttons.forEach((b) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'btn btn-' + (b.variant === 'primary' ? 'primary' : b.variant === 'secondary' ? 'secondary' : 'text');
      el.textContent = b.label;
      el.addEventListener('click', b.onClick);
      btnRow.appendChild(el);
    });
    box.appendChild(btnRow);
    overlay.hidden = false;
  }

  function closeDialog() {
    document.getElementById('dialog-overlay').hidden = true;
  }

  let toastTimer = null;
  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
  }

  // ---------- Init ----------

  function init() {
    // T19/T4: SheetJS is vendored locally (vendor/xlsx.full.min.js), not
    // loaded from a CDN, so a network/CDN outage cannot break this app.
    // Still guard against the script itself failing to load (e.g. a broken
    // deploy) rather than silently breaking Export/Import with no message.
    if (!window.XLSX) {
      showDialog({
        title: 'No se pudo cargar el motor de Excel',
        body: 'La app no puede exportar ni importar en este momento. Recargá la página; si el problema sigue, contactá soporte.',
        buttons: [{ label: 'Recargar', variant: 'primary', onClick: () => location.reload() }],
      });
      return;
    }

    if (!window.Storage.available) {
      showToast('Aviso: este navegador no permite guardar borrador automático. Exportá seguido para no perder datos.');
    }

    const draft = window.Storage.loadDraft();
    if (draft && draft.date) {
      currentDay = draft;
    }

    // Load every previously saved day back in — a refresh must never lose
    // a day the user already confirmed with "Guardar día".
    const savedDays = window.Storage.loadDays();
    if (savedDays && savedDays.length) {
      state.days = savedDays;
      // We don't persist export status across reloads, so conservatively
      // mark every restored day as not-yet-exported — better to remind the
      // user once too often than to silently assume an export happened.
      savedDays.forEach((d) => {
        state.unexportedDates.add(d.date);
        (d.gastos || []).forEach((g) => rememberName('gastos', g.name));
        (d.compras || []).forEach((c) => rememberName('compras', c.provider));
        (d.ventas || []).forEach((v) => rememberName('ventas', v.buyer));
      });
    }

    document.getElementById('day-date').value = currentDay.date;
    document.getElementById('build-date').textContent = '2026-07-07';

    initAccordionHandlers();
    setOpenSection(null); // D5: accordion always closed on load

    document.querySelectorAll('[data-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.add;
        if (kind === 'compras') currentDay.compras.push({ provider: '', amount: '', currency: 'CRC', material: '' });
        else if (kind === 'ventas') currentDay.ventas.push({ buyer: '', amount: '', currency: 'CRC' });
        else currentDay.gastos.push({ name: '', amount: '', currency: 'CRC' });
        renderRows(kind);
        saveDraftDebounced(); // bug fix: adding a row was never persisted until an amount was typed
      });
    });

    document.getElementById('day-date').addEventListener('change', (e) => {
      const newDate = e.target.value;
      const oldDate = currentDay.date;
      if (newDate === oldDate) return;
      const hasUnsavedData = ['gastos', 'compras', 'ventas'].some((kind) =>
        currentDay[kind].some((r) => Number(r.amount) > 0));
      if (hasUnsavedData) {
        showDialog({
          title: 'Cambiar de fecha',
          body: 'Tenés datos sin guardar para ' + oldDate + '. Si cambiás a ' + newDate + ' se van a borrar (a menos que guardés primero). ¿Continuar?',
          buttons: [
            { label: 'Cancelar', variant: 'secondary', onClick: () => { closeDialog(); e.target.value = oldDate; } },
            { label: 'Borrar y continuar', variant: 'primary', onClick: () => { closeDialog(); resetFormForDate(newDate); } },
          ],
        });
      } else {
        resetFormForDate(newDate);
      }
    });

    renderDatalists();
    renderAllRows();
    recomputeAndRender();
    renderSavedDays();

    document.getElementById('save-day-btn').addEventListener('click', saveDay);
    document.getElementById('export-btn').addEventListener('click', doExport);
    document.getElementById('unexported-badge-export-btn').addEventListener('click', doExport);
    document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file-input').click());
    document.getElementById('import-file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) doImport(file);
      e.target.value = '';
    });
    document.getElementById('undo-import-btn').addEventListener('click', undoLastImport);
    document.getElementById('close-month-btn').addEventListener('click', doCloseMonth);

    initDriveUI();
    updateUnexportedBadge();
  }

  // ---------- Google Drive connect UI ----------

  function renderDriveStatus() {
    const connected = window.DriveUpload && window.DriveUpload.isConnected();
    document.getElementById('drive-connect-btn').hidden = !!connected;
    document.getElementById('drive-connected-row').hidden = !connected;
  }

  function initDriveUI() {
    if (!window.DriveUpload) return; // drive.js failed to load — feature just stays hidden/off
    if (!window.DriveUpload.isConfigured()) {
      // Not set up yet (see drive.js SETUP comment) — hide the whole section
      // instead of offering a button that can only ever fail.
      document.getElementById('drive-status').hidden = true;
      return;
    }
    renderDriveStatus();
    document.getElementById('drive-connect-btn').addEventListener('click', () => {
      window.DriveUpload.connect()
        .then(() => { renderDriveStatus(); showToast('Conectado a Google Drive.'); })
        .catch((e) => showToast('No se pudo conectar: ' + e.message));
    });
    document.getElementById('drive-disconnect-btn').addEventListener('click', () => {
      window.DriveUpload.disconnect();
      renderDriveStatus();
      showToast('Desconectado de Google Drive. Tus exportaciones ya no suben solas.');
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
