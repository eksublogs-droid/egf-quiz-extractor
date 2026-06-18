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

function capturePDF(mode){\n  return new Promise((resolve, reject) => {\n    if (typeof downloadPDF !== 'function') {\n      reject(new Error('downloadPDF() not found — is the main script loaded?'));\n      return;\n    }\n    if (!window.jspdf || !window.jspdf.jsPDF) {\n      reject(new Error('jsPDF not loaded'));\n      return;\n    }\n\n    // Suppress the \"PDF downloaded\" toast that downloadPDF fires after doc.save()\n    // so it doesn't pop up confusingly during a Drive push.\n    const originalToast = window.toast;\n    window.toast = function(msg, type){\n      if (type === 'success' && typeof msg === 'string' && msg.startsWith('PDF downloaded')) return;\n      if (originalToast) originalToast.apply(this, arguments);\n    };\n\n    let settled = false;\n    let capturedFilename = 'document.pdf';\n\n    /* ── INTERCEPT: jsPDF output('datauristring') approach ──────────────\n       downloadPDF now writes a data URI into a hidden iframe.\n       We intercept at jsPDF.prototype.output so we can grab the blob\n       before the iframe approach fires, and simultaneously block\n       the iframe from actually downloading. Strategy:\n       1. Patch jsPDF.prototype.output to capture raw PDF bytes when\n          called with 'datauristring' or 'blob'.\n       2. Patch iframe contentDocument.write to be a no-op (preventing\n          the auto-download link from being written and clicked).\n       ────────────────────────────────────────────────────────────── */\n    const jsPDFProto = window.jspdf.jsPDF.prototype;\n    const originalOutput = jsPDFProto.output;\n\n    jsPDFProto.output = function(type, options){\n      const result = originalOutput.apply(this, arguments);\n      if (!settled) {\n        if (type === 'blob' || type === 'arraybuffer') {\n          // Already a blob or buffer\n          const blob = (type === 'blob') ? result : new Blob([result], { type: 'application/pdf' });\n          settled = true;\n          jsPDFProto.output = originalOutput;\n          restoreAll();\n          clearTimeout(timeoutId);\n          resolve({ blob, filename: capturedFilename });\n        } else if (type === 'datauristring' || type === 'datauri' || type === 'dataurl') {\n          // Convert data URI string to blob\n          try {\n            const base64 = String(result).split(',')[1];\n            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));\n            const blob = new Blob([bytes], { type: 'application/pdf' });\n            settled = true;\n            jsPDFProto.output = originalOutput;\n            restoreAll();\n            clearTimeout(timeoutId);\n            resolve({ blob, filename: capturedFilename });\n          } catch(e) {\n            // Conversion failed; fall through\n          }\n        }\n      }\n      return result;\n    };\n\n    /* ── INTERCEPT: block iframe write that triggers auto-download ──────\n       The hidden iframe has its contentDocument.write() called with an\n       HTML page containing an auto-clicking <a>. We intercept\n       document.body.appendChild for the iframe element itself, and also\n       patch iframe contentDocument.write to be a no-op once we've\n       captured the PDF bytes. ────────────────────────────────────────── */\n    const originalAppendChild = document.body.appendChild.bind(document.body);\n    document.body.appendChild = function(el){\n      // Block any hidden <a> used for download (legacy path)\n      if (el && el.tagName === 'A' && el.download && (el.download.endsWith('.pdf') || el.download.endsWith('.json'))) {\n        capturedFilename = el.download;\n        return el; // don't append\n      }\n      // For iframes being inserted, patch their write method to suppress the download HTML\n      if (el && el.tagName === 'IFRAME') {\n        const result = originalAppendChild(el);\n        // Patch contentDocument.write after the iframe is in the DOM\n        try {\n          const iDoc = el.contentDocument || (el.contentWindow && el.contentWindow.document);\n          if (iDoc) {\n            const originalWrite = iDoc.write.bind(iDoc);\n            iDoc.write = function(html){\n              // If this write contains a PDF data URI download, suppress it\n              if (typeof html === 'string' && html.includes('data:application/pdf')) {\n                // Extract filename from the download attribute if present\n                const fnMatch = html.match(/download=\"([^\"]+\.pdf)\"/);\n                if (fnMatch) capturedFilename = fnMatch[1].replace(/&quot;/g, '"');\n                iDoc.write = originalWrite; // restore\n                return; // block the write — PDF already captured via output() patch\n              }\n              return originalWrite(html);\n            };\n          }\n        } catch(e) { /* cross-origin iframe — ignore */ }\n        return result;\n      }\n      return originalAppendChild(el);\n    };\n\n    /* ── ALSO intercept URL.createObjectURL as a legacy fallback path ── */\n    const originalCreateObjectURL = URL.createObjectURL.bind(URL);\n    URL.createObjectURL = function(blob){\n      if (!settled && blob instanceof Blob && blob.type === 'application/pdf') {\n        settled = true;\n        URL.createObjectURL = originalCreateObjectURL;\n        restoreAll();\n        clearTimeout(timeoutId);\n        resolve({ blob, filename: capturedFilename });\n        return 'about:blank';\n      }\n      return originalCreateObjectURL(blob);\n    };\n\n    function restoreAll(){\n      window.toast = originalToast;\n      jsPDFProto.output = originalOutput;\n      URL.createObjectURL = originalCreateObjectURL;\n      document.body.appendChild = originalAppendChild;\n    }\n\n    // Safety timeout — restore everything and reject if PDF never finishes.\n    const timeoutId = setTimeout(() => {\n      if (!settled) {\n        settled = true;\n        restoreAll();\n        reject(new Error('PDF generation did not complete within 120s (timeout)'));\n      }\n    }, 120000);\n\n    // Call downloadPDF. If it returns a promise, attach a failure handler.\n    let ret;\n    try {\n      ret = downloadPDF(mode);\n    } catch (err) {\n      if (!settled) {\n        settled = true;\n        restoreAll();\n        clearTimeout(timeoutId);\n        reject(err);\n      }\n      return;\n    }\n\n    if (ret && typeof ret.then === 'function') {\n      ret.then(\n        () => { clearTimeout(timeoutId); },\n        (err) => {\n          if (!settled) {\n            settled = true;\n            restoreAll();\n            clearTimeout(timeoutId);\n            reject(err);\n          }\n        }\n      );\n    }\n  });\n}




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
    const year        = (extractedData && extractedData.courseYear) || '';
    const courseCode  = (extractedData && extractedData.courseCode) || '';

    const dest = await resolveDestinationFolder(university, faculty, semester);

    const fnameParts = [courseCode, year.replace(/[^0-9]/g,''), dest.semesterName.toUpperCase(), dest.facultyName.toUpperCase(), docTitle, dest.universityName.toUpperCase()];
    const fnameBase = fnameParts.filter(Boolean).join('_').replace(/[^a-zA-Z0-9\s_]/g,'').replace(/\s+/g,'_');

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

    const courseInfo = [docTitle, year, dest.semesterName].filter(Boolean).join(' · ');
    toast(`Pushed to Drive: ${courseInfo} → ${dest.facultyName} → ${dest.universityName}`, 'success');
  } catch (err) {
    console.error(err);
    toast(`Drive push failed: ${err.message}`, 'error');
  } finally {
    clearBusy();
  }
}
