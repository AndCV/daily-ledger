/*
 * storage.js — localStorage persistence.
 *
 * Two layers:
 * - DRAFT: the in-progress (unsaved) day form, autosaved as you type.
 * - DAYS: every saved day for the current month, persisted immediately on
 *   save/edit/import so a page refresh never loses a day the user already
 *   confirmed with "Guardar día". Excel export is the end-of-month
 *   deliverable, not the only thing standing between the user and data loss.
 *
 * Detects localStorage unavailability (T6 — private/incognito mode, disabled
 * storage) and degrades gracefully to in-memory-only with a visible warning
 * instead of throwing.
 */
(function (global) {
  'use strict';

  const DRAFT_KEY = 'daily_ledger_draft_v1';
  const DAYS_KEY = 'daily_ledger_saved_days_v1';

  function detectAvailable() {
    try {
      const testKey = '__daily_ledger_test__';
      window.localStorage.setItem(testKey, '1');
      window.localStorage.removeItem(testKey);
      return true;
    } catch (e) {
      return false;
    }
  }

  const available = detectAvailable();

  function saveDraft(dayState) {
    if (!available) return false;
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(dayState));
      return true;
    } catch (e) {
      return false;
    }
  }

  function loadDraft() {
    if (!available) return null;
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clearDraft() {
    if (!available) return;
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function saveDays(daysArray) {
    if (!available) return false;
    try {
      window.localStorage.setItem(DAYS_KEY, JSON.stringify(daysArray));
      return true;
    } catch (e) {
      return false;
    }
  }

  function loadDays() {
    if (!available) return null;
    try {
      const raw = window.localStorage.getItem(DAYS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  global.Storage = {
    available,
    saveDraft,
    loadDraft,
    clearDraft,
    saveDays,
    loadDays,
  };
})(window);
