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

/* ── CAPTURE A PDF FROM YOUR EXISTING downloadPDF() WITHOUT EDITING IT ──
   Your downloadPDF(mode) builds a jsPDF doc and calls doc.save(fname),
   which triggers a browser download. We temporarily intercept
   jsPDF.prototype.save so we can grab the bytes instead of (or in
   addition to) downloading, then restore the original immediately. */
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
    const proto = window.jspdf.jsPDF.prototype;
    const originalSave = proto.save;
    let captured = false;

    proto.save = function(filename){
      try {
        const blob = this.output('blob');
        captured = true;
        proto.save = originalSave; // restore immediately
        resolve({ blob, filename: filename || 'document.pdf' });
      } catch (err) {
        proto.save = originalSave;
        reject(err);
      }
      // Do not call originalSave — we don't want a duplicate browser
      // download triggered every time the Drive push runs. Your normal
      // "Download PDF" buttons are untouched and still download as before
      // (they call downloadPDF() directly, not through this function).
    };

    try {
      const ret = downloadPDF(mode);
      // downloadPDF may be async; if it returns a promise, await failures
      if (ret && typeof ret.then === 'function') {
        ret.catch(err => { if (!captured) { proto.save = originalSave; reject(err); } });
      }
    } catch (err) {
      proto.save = originalSave;
      reject(err);
    }

    // Safety timeout in case save() is never called
    setTimeout(() => {
      if (!captured) {
        proto.save = originalSave;
        reject(new Error('PDF generation did not complete (timeout)'));
      }
    }, 15000);
  });
}

/* ── DRIVE HELPERS ── */
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

// Find a child folder by exact name inside parentId. Returns folder id or null.
async function findFolder(name, parentId){
  const safeName = name.replace(/'/g, "\\'");
  const q = encodeURIComponent(
    `'${parentId}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const data = await driveFetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name)`);
  return (data.files && data.files[0]) ? data.files[0].id : null;
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
  return f;
}

function resolveSemesterFolderName(semesterRaw){
  const s = (semesterRaw || '').toLowerCase();
  if (s.includes('1') || s.includes('first') || s.includes('1st')) return '1st Semester';
  if (s.includes('2') || s.includes('second') || s.includes('2nd')) return '2nd Semester';
  // Default to 1st Semester if AI extraction didn't yield a clear semester
  return '1st Semester';
}

/* ── FULL PATH RESOLUTION: root → university → faculty → faculty-name → semester ── */
async function resolveDestinationFolder(universityRaw, facultyRaw, semesterRaw){
  const universityName = resolveUniversityFolderName(universityRaw);
  const facultyName     = resolveFacultyFolderName(facultyRaw);
  const semesterName    = resolveSemesterFolderName(semesterRaw);

  const universityFolderId = await findOrCreateFolder(universityName, DRIVE_ROOT_FOLDER_ID);
  const facultyRootId       = await findOrCreateFolder('faculty', universityFolderId);
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

  try {
    setBusy('Resolving folders…');
    const university = (extractedData && extractedData.courseUniversity) || '';
    const faculty     = (extractedData && extractedData.courseFaculty) || '';
    const semester    = (extractedData && extractedData.courseSemester) || '';
    const docTitle    = (extractedData && (extractedData.docTitle || extractedData.courseTitle)) || 'Quiz';

    const dest = await resolveDestinationFolder(university, faculty, semester);

    const fnameBase = docTitle.replace(/[^a-zA-Z0-9\s]/g,'').replace(/\s+/g,'_');

    setBusy('Generating Questions PDF…');
    const qPdf = await capturePDF('questions');

    setBusy('Generating Q+A PDF…');
    const aPdf = await capturePDF('answers');

    setBusy('Uploading Questions PDF…');
    await uploadFileToFolder(qPdf.blob, `${fnameBase}_Questions.pdf`, dest.semesterFolderId);

    setBusy('Uploading Q+A PDF…');
    await uploadFileToFolder(aPdf.blob, `${fnameBase}_QA.pdf`, dest.semesterFolderId);

    toast(`Pushed to Drive: ${dest.universityName} / faculty / ${dest.facultyName} / ${dest.semesterName}`, 'success');
  } catch (err) {
    console.error(err);
    toast(`Drive push failed: ${err.message}`, 'error');
  } finally {
    clearBusy();
  }
}
