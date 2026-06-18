/* ════════════════════════════════════════════════════════
   EduGlobalForge — Drive Push Module (drive-push.js)
   Standalone add-on. Does NOT modify the main extractor file.
   Include this with a single <script src="drive-push.js"></script>
   tag placed AFTER jspdf and AFTER your main file's <script> block.
   ════════════════════════════════════════════════════════ */

const DRIVE_ROOT_FOLDER_ID = '1XrTE9MJjUL64obYNXmP3OB-piuSVDL59'; // "Uni Past Questions Files"
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

/* ── AUTOMATIC TOKEN FETCHING ──
   No pasting, no popups. The browser asks YOUR OWN serverless endpoint
   for a fresh access token. That endpoint (api/get-drive-token.js)
   holds your Client Secret + Refresh Token privately on Vercel and
   does the exchange with Google server-side. The browser never sees
   the secret or the refresh token — only a short-lived access token,
   cached in memory until it's about to expire. */
let _driveTokenCache = { token: null, expiresAt: 0 };

async function getDriveToken(){
  const now = Date.now();
  if (_driveTokenCache.token && now < _driveTokenCache.expiresAt - 60000) {
    return _driveTokenCache.token; // still valid, reuse it
  }
  const res = await fetch('/api/get-drive-token');
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) {
    throw new Error(data.error || `Failed to get Drive token (${res.status})`);
  }
  _driveTokenCache = {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 3600) * 1000
  };
  return _driveTokenCache.token;
}

/* ── PDF CAPTURE — AIRTIGHT INTERCEPTION ──
   Strategy: instead of patching jsPDF.prototype.save and hoping the
   patch wins a timing race, we do two things:

   1. We patch proto.save BEFORE calling downloadPDF, and we make the
      patch synchronously replace itself back to a no-op sentinel so
      that if downloadPDF calls save() a second time (it shouldn't, but
      just in case) nothing bad happens.

   2. We make the patch function NEVER call originalSave under any
      circumstance. The original save() triggers the browser download.
      Our patch grabs the bytes via output('blob') then resolves the
      promise — full stop. originalSave is restored but never invoked.

   This means "Download PDF" buttons in the main UI are completely
   unaffected: they call downloadPDF() directly (not through capturePDF),
   so proto.save is the real one at that point and the download fires
   normally for those buttons.

   The only way a stray download could still appear is if downloadPDF()
   creates a *second* jsPDF instance and calls save() on it before our
   patch fires — that can't happen here because jsPDF is synchronous
   inside downloadPDF (no await between new jsPDF() and doc.save()).    */

function capturePDF(mode){
  return new Promise((resolve, reject) => {
    if (typeof downloadPDF !== 'function') {
      reject(new Error('downloadPDF() not found — is the main script loaded?'));
      return;
    }
    if (!window.jspdf || !window.jspdf.jsPDF) {
      reject(new Error('jsPDF not loaded'));
      return;
    }

    // Suppress the "PDF downloaded" toast that downloadPDF fires after doc.save()
    // so it doesn't pop up confusingly during a Drive push.
    const originalToast = window.toast;
    window.toast = function(msg, type){
      if (type === 'success' && typeof msg === 'string' && msg.startsWith('PDF downloaded')) return;
      if (originalToast) originalToast.apply(this, arguments);
    };

    const proto = window.jspdf.jsPDF.prototype;
    const originalSave = proto.save;
    let settled = false;

    /* ── INTERCEPT 1: jsPDF proto.save ──────────────────────────────
       Grabs bytes via output('blob') and resolves WITHOUT calling
       the real save(), so no browser download fires.
       ────────────────────────────────────────────────────────────── */
    proto.save = function(filename){
      if (settled) { proto.save = originalSave; return; }
      settled = true;
      proto.save = originalSave;
      restoreAll();
      try {
        const blob = this.output('blob');
        resolve({ blob, filename: filename || 'document.pdf' });
      } catch (err) {
        reject(err);
      }
      // Intentionally do NOT call originalSave — this is what blocks the download.
    };

    /* ── INTERCEPT 2: URL.createObjectURL ───────────────────────────
       Some builds of jsPDF (and wrapper code) create a blob URL then
       do anchor.click() rather than going through proto.save.
       We intercept the blob creation so we have the bytes, and we
       return a dummy URL so the rest of the code doesn't crash.
       The anchor.click() will fire on 'blob:intercepted' which the
       browser silently ignores — no download popup.
       ────────────────────────────────────────────────────────────── */
    const origCreateObjectURL = URL.createObjectURL.bind(URL);
    let _interceptedBlob = null;
    URL.createObjectURL = function(blobOrFile){
      const t = blobOrFile instanceof Blob ? blobOrFile.type : '';
      const looksLikePDF = t === 'application/pdf' || t === '' || t === 'application/octet-stream';
      if (!settled && looksLikePDF) {
        _interceptedBlob = blobOrFile;
        // Resolve now if proto.save never fires (the anchor path)
        setTimeout(() => {
          if (!settled) {
            settled = true;
            proto.save = originalSave;
            restoreAll();
            resolve({ blob: _interceptedBlob, filename: 'document.pdf' });
          }
        }, 0);
        // Return a real (empty) blob URL so downstream code can't crash on it
        return origCreateObjectURL(new Blob([], { type: 'application/pdf' }));
      }
      return origCreateObjectURL(blobOrFile);
    };

    function restoreAll(){
      URL.createObjectURL = origCreateObjectURL;
      window.toast = originalToast;
    }

    // Safety timeout — restore everything and reject if PDF never finishes.
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        proto.save = originalSave;
        restoreAll();
        reject(new Error('PDF generation did not complete within 120s (timeout)'));
      }
    }, 120000);

    // Call downloadPDF. If it returns a promise, attach a failure handler.
    let ret;
    try {
      ret = downloadPDF(mode);
    } catch (err) {
      if (!settled) {
        settled = true;
        proto.save = originalSave;
        restoreAll();
        clearTimeout(timeoutId);
        reject(err);
      }
      return;
    }

    if (ret && typeof ret.then === 'function') {
      ret.then(
        () => { clearTimeout(timeoutId); },
        (err) => {
          if (!settled) {
            settled = true;
            proto.save = originalSave;
            restoreAll();
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      );
    } else {
      // downloadPDF is synchronous — if we're here and settled, we're done.
      // If not settled by now, something went wrong.
      if (!settled) {
        // Give async rendering a single tick to finish (e.g. any internal
        // setTimeout(0) jsPDF might use), then timeout naturally.
      }
    }
  });
}




async function driveFetch(url, options = {}){
  const token = await getDriveToken();
  const headers = Object.assign({ 'Authorization': `Bearer ${token}` }, options.headers || {});
  const res = await fetch(url, Object.assign({}, options, { headers }));
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    if (res.status === 401) throw new Error('Drive authorization failed — check refresh token / client secret in Vercel env vars.');
    throw new Error(`Drive API error ${res.status}: ${text.slice(0,200)}`);
  }
  return res.json();
}

// Find a child folder by name (case-insensitive) inside parentId. Returns folder id or null.
// We list ALL folders in the parent and compare lowercased names so that
// existing folders like "Faculty" are found even if we search for "faculty".
async function findFolder(name, parentId){
  const q = encodeURIComponent(
    `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const data = await driveFetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name)&pageSize=1000`);
  if (!data.files || !data.files.length) return null;
  const nameLower = name.toLowerCase();
  const match = data.files.find(f => f.name.toLowerCase() === nameLower);
  return match ? match.id : null;
}

// Create a folder inside parentId, return its id.
async function createFolder(name, parentId){
  const data = await driveFetch(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    })
  });
  return data.id;
}

// Find folder by name, or create it if missing. Returns folder id.
async function findOrCreateFolder(name, parentId){
  const existing = await findFolder(name, parentId);
  if (existing) return existing;
  return createFolder(name, parentId);
}

// Upload a Blob as a file into a given folder.
async function uploadFileToFolder(blob, filename, folderId){
  const metadata = { name: filename, parents: [folderId], mimeType: 'application/pdf' };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const token = await getDriveToken();
  const res = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form
  });
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    if (res.status === 401) throw new Error('Drive authorization failed — check refresh token / client secret in Vercel env vars.');
    throw new Error(`Drive upload error ${res.status}: ${text.slice(0,200)}`);
  }
  return res.json();
}

/* ── FOLDER NAME RESOLUTION ──
   Maps your extracted course fields to the exact folder naming
   convention already used in your Drive structure. */
function resolveUniversityFolderName(universityRaw){
  const u = (universityRaw || '').trim();
  if (!u) return 'Unknown University';
  const lower = u.toLowerCase();
  if (lower.includes('ekiti state') || lower === 'eksu' || lower.includes('(eksu)')) {
    return 'Ekiti State University (EKSU)';
  }
  return u; // any other university: use the extracted name as-is for the new folder
}

function resolveFacultyFolderName(facultyRaw){
  const f = (facultyRaw || '').trim();
  if (!f) return 'GST PAST QUESTIONS';
  // Normalize common GST course naming into the GST bucket
  if (/general\s*studies|^gst\b/i.test(f)) return 'GST PAST QUESTIONS';
  // Convert to title case so it matches existing Drive folders
  // e.g. "FACULTY OF SCIENCE" or "faculty of science" → "Faculty of Science"
  return f.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function resolveSemesterFolderName(semesterRaw){
  const s = (semesterRaw || '').toLowerCase();
  if (s.includes('1') || s.includes('first') || s.includes('1st')) return 'First Semester';
  if (s.includes('2') || s.includes('second') || s.includes('2nd')) return 'Second Semester';
  // Default to First Semester if AI extraction didn't yield a clear semester
  return 'First Semester';
}

/* ── FULL PATH RESOLUTION: root → university → faculty → faculty-name → semester ── */
async function resolveDestinationFolder(universityRaw, facultyRaw, semesterRaw){
  const universityName = resolveUniversityFolderName(universityRaw);
  const facultyName     = resolveFacultyFolderName(facultyRaw);
  const semesterName    = resolveSemesterFolderName(semesterRaw);

  const universityFolderId = await findOrCreateFolder(universityName, DRIVE_ROOT_FOLDER_ID);
  const facultyRootId       = await findOrCreateFolder('Faculty', universityFolderId);
  const facultyFolderId     = await findOrCreateFolder(facultyName, facultyRootId);
  const semesterFolderId    = await findOrCreateFolder(semesterName, facultyFolderId);

  return { universityFolderId, facultyFolderId, semesterFolderId, universityName, facultyName, semesterName };
}

/* ── MAIN ENTRY POINT: "Push to Drive" ──
   Generates both PDFs (questions-only and Q+A+explanations) from the
   already-verified data in your main file, then uploads both into the
   correct nested folder. */
async function pushToDrive(){
  if (typeof verifiedData === 'undefined' || !verifiedData) {
    toast('No verified data yet — run extraction first', 'error');
    return;
  }
  const btn = document.getElementById('pushDriveBtn');
  const setBusy = (label) => { if (btn) { btn.disabled = true; btn.dataset.origLabel = btn.dataset.origLabel || btn.innerHTML; btn.innerHTML = label; } };
  const clearBusy = () => { if (btn) { btn.disabled = false; if (btn.dataset.origLabel) btn.innerHTML = btn.dataset.origLabel; } };

  // Give the browser a tick to repaint the button label before heavy work starts
  const tick = () => new Promise(r => setTimeout(r, 60));

  try {
    setBusy('🔍 Resolving folders…');
    await tick();
    const university = (extractedData && extractedData.courseUniversity) || '';
    const faculty     = (extractedData && extractedData.courseFaculty) || '';
    const semester    = (extractedData && extractedData.courseSemester) || '';
    const docTitle    = (extractedData && (extractedData.docTitle || extractedData.courseTitle)) || 'Quiz';

    const dest = await resolveDestinationFolder(university, faculty, semester);

    const fnameBase = docTitle.replace(/[^a-zA-Z0-9\s]/g,'').replace(/\s+/g,'_');

    setBusy('📄 Generating Questions PDF…');
    await tick();
    const qPdf = await capturePDF('questions');

    setBusy('📝 Generating Q+A PDF…');
    await tick();
    const aPdf = await capturePDF('answers');

    setBusy('☁️ Uploading Questions PDF…');
    await tick();
    await uploadFileToFolder(qPdf.blob, `${fnameBase}_Questions.pdf`, dest.semesterFolderId);

    setBusy('☁️ Uploading Q+A PDF…');
    await tick();
    await uploadFileToFolder(aPdf.blob, `${fnameBase}_QA.pdf`, dest.semesterFolderId);

    toast(`Pushed to Drive: ${dest.universityName} / faculty / ${dest.facultyName} / ${dest.semesterName}`, 'success');
  } catch (err) {
    console.error(err);
    toast(`Drive push failed: ${err.message}`, 'error');
  } finally {
    clearBusy();
  }
}
