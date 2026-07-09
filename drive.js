/*
 * drive.js — optional Google Drive auto-upload. 100% client-side: uses
 * Google Identity Services (GIS) for OAuth in the browser and calls the
 * Drive REST API directly with fetch — no backend server involved, matching
 * the app's "no servidor" constraint. The OAuth Client ID is meant to be
 * public (browser apps can't keep it secret); the security boundary is the
 * Authorized JavaScript origins configured in Google Cloud, plus each
 * user's own explicit consent.
 *
 * Scope used: drive.file (narrowest scope Google offers for "upload files"
 * apps — the app can create/access files it uploads, without seeing the
 * user's entire Drive).
 *
 * SETUP (required before this feature works):
 * 1. Create a Google Cloud project, enable the Google Drive API.
 * 2. Configure the OAuth consent screen (External, add yourself/your team
 *    as test users — no Google verification needed for a small known group).
 * 3. Create an OAuth 2.0 Client ID (Web application), add your app's URL
 *    (and http://localhost:PORT for local dev) as an Authorized JavaScript origin.
 * 4. Create/choose a shared Drive folder, copy its ID from the folder's URL
 *    (.../folders/<FOLDER_ID>), and share it with Editor access to whoever
 *    will use this app.
 * 5. Paste both values below.
 */
(function (global) {
  'use strict';

  // Public by design (see header comment) — not secrets, but they ARE
  // specific to one Google Cloud project + one Drive folder. Replace both
  // with your own before deploying (see SETUP above).
  const CLIENT_ID = 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com';
  const FOLDER_ID = 'YOUR_SHARED_DRIVE_FOLDER_ID';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const TOKEN_STORAGE_KEY = 'daily_ledger_drive_token_v1';

  let tokenClient = null;
  let gisLoaded = false;
  let gisLoadPromise = null;

  // { accessToken, expiresAt } — expiresAt is a Date.now()-style ms timestamp.
  let currentToken = loadStoredToken();

  function loadStoredToken() {
    try {
      const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.accessToken && parsed.expiresAt > Date.now()) return parsed;
      return null;
    } catch (e) {
      return null;
    }
  }

  function storeToken(tok) {
    currentToken = tok;
    try {
      if (tok) window.localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tok));
      else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch (e) {
      /* ignore — token just won't survive a refresh, connect() will re-prompt */
    }
  }

  function loadGisScript() {
    if (gisLoadPromise) return gisLoadPromise;
    gisLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => { gisLoaded = true; resolve(); };
      script.onerror = () => reject(new Error('No se pudo cargar el sistema de acceso de Google (revisá tu conexión a internet).'));
      document.head.appendChild(script);
    });
    return gisLoadPromise;
  }

  function isConnected() {
    return !!(currentToken && currentToken.expiresAt > Date.now());
  }

  function disconnect() {
    if (currentToken && global.google && global.google.accounts) {
      try { global.google.accounts.oauth2.revoke(currentToken.accessToken, () => {}); } catch (e) { /* best effort */ }
    }
    storeToken(null);
  }

  function isConfigured() {
    return !CLIENT_ID.startsWith('YOUR_') && !FOLDER_ID.startsWith('YOUR_');
  }

  // Resolves with an access token, prompting the Google consent popup only
  // if we don't already have a valid one cached.
  function connect() {
    if (!isConfigured()) {
      return Promise.reject(new Error('Google Drive no está configurado todavía — completá CLIENT_ID y FOLDER_ID en drive.js (ver el comentario SETUP al inicio del archivo).'));
    }
    return loadGisScript().then(() => new Promise((resolve, reject) => {
      if (isConnected()) { resolve(currentToken.accessToken); return; }

      if (!tokenClient) {
        tokenClient = global.google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: SCOPE,
          callback: () => {}, // overridden per-call below
        });
      }

      tokenClient.callback = (resp) => {
        if (resp.error) {
          reject(new Error('No se pudo conectar con Google Drive: ' + resp.error));
          return;
        }
        // expires_in is seconds; keep a 2-minute safety margin.
        const expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 120000;
        storeToken({ accessToken: resp.access_token, expiresAt });
        resolve(resp.access_token);
      };
      tokenClient.error_callback = (err) => {
        reject(new Error('No se pudo conectar con Google Drive: ' + (err && err.type || 'error desconocido')));
      };

      tokenClient.requestAccessToken({ prompt: isConnected() ? '' : 'consent' });
    }));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function handleUploadResponse(res) {
    if (res.status === 401) {
      // Token expired/revoked server-side despite our local expiry check
      // — drop it and let the caller retry (will re-prompt if needed).
      storeToken(null);
      throw new Error('La sesión de Google Drive expiró. Intentá exportar de nuevo.');
    }
    if (!res.ok) {
      return res.text().then((body) => {
        const err = new Error('Google Drive rechazó la subida (HTTP ' + res.status + '). ' + body.slice(0, 200));
        err.status = res.status;
        throw err;
      });
    }
    return res.json();
  }

  function doCreateRequest(blob, filename, accessToken) {
    const metadata = { name: filename, parents: [FOLDER_ID] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken },
      body: form,
    }).then(handleUploadResponse);
  }

  // Updates an existing file's content in place (used to keep one Excel
  // file per month in Drive instead of a new file per export — see
  // app.js's maybeUploadToDrive/currentMonthKey).
  function doUpdateRequest(fileId, blob, filename, accessToken) {
    const metadata = { name: filename };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    return fetch('https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(fileId) + '?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + accessToken },
      body: form,
    }).then(handleUploadResponse);
  }

  // Mobile Safari quirk: right after the OAuth popup closes and focus
  // returns to the page, the very next fetch() sometimes fails with a bare
  // "Load failed" — a generic network-layer error (not an HTTP response;
  // browsers deliberately don't expose more detail for these), most likely
  // because the tab hasn't fully "resumed" networking yet. Retrying once
  // after a short delay reliably clears it without bothering the user.
  function withNetworkRetry(fn) {
    return fn().catch((err) => {
      const isNetworkLevelFailure = err instanceof TypeError; // fetch() itself rejects with TypeError for network failures, unlike HTTP-status errors thrown above
      if (!isNetworkLevelFailure) throw err;
      return sleep(1200).then(fn);
    });
  }

  // Uploads a Blob to the configured shared folder. Auto-connects (may show
  // the consent popup) if not already connected.
  //
  // If `fileId` is given, updates that existing file's content in place
  // instead of creating a new one (so repeated exports within the same
  // month land in one running file). Falls back to creating a new file if
  // the referenced one is gone (e.g. someone deleted it from Drive).
  function uploadFile(blob, filename, fileId) {
    return connect().then((accessToken) => {
      if (!fileId) {
        return withNetworkRetry(() => doCreateRequest(blob, filename, accessToken));
      }
      return withNetworkRetry(() => doUpdateRequest(fileId, blob, filename, accessToken)).catch((err) => {
        if (err && err.status === 404) {
          return withNetworkRetry(() => doCreateRequest(blob, filename, accessToken));
        }
        throw err;
      });
    });
  }

  global.DriveUpload = {
    isConfigured,
    isConnected,
    connect,
    disconnect,
    uploadFile,
  };
})(window);
