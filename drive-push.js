/* ════════════════════════════════════════════════════════
   EduGlobalForge — Drive Push Module (drive-push.js)
   Standalone add-on. Does NOT modify the main extractor file.
   Include this with a single <script src="drive-push.js"></script>
   tag placed AFTER jspdf and AFTER your main file's <script> block.
   ════════════════════════════════════════════════════════ */

/* ── ERUDA mobile console (remove after debugging is done) ── */
(function () {
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/eruda';
  s.onload = function () { eruda.init(); };
  document.head.appendChild(s);
})();

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

    let settled = false;
    let capturedFilename = 'document.pdf';

    /* ── INTERCEPT: jsPDF output('datauristring') approach ──────────────
       downloadPDF now writes a data URI into a hidden iframe.
       We intercept at jsPDF.prototype.output so we can grab the blob
       before the iframe approach fires, and simultaneously block
       the iframe from actually downloading. Strategy:
       1. Patch jsPDF.prototype.output to capture raw PDF bytes when
          called with 'datauristring' or 'blob'.
       2. Patch iframe contentDocument.write to be a no-op (preventing
          the auto-download link from being written and clicked).
       ────────────────────────────────────────────────────────────── */
    // ── Build the patched output function once, used for both prototype AND instance-level patching ──
    function makePatchedOutput(originalFn){
      return function(type, options){
        const result = originalFn.apply(this, arguments);
        if (!settled) {
          if (type === 'blob' || type === 'arraybuffer') {
            const blob = (type === 'blob') ? result : new Blob([result], { type: 'application/pdf' });
            settled = true;
            restoreAll();
            clearTimeout(timeoutId);
            console.log('[drive-push] captured PDF via output(' + type + ')');
            resolve({ blob, filename: capturedFilename });
          } else if (type === 'datauristring' || type === 'datauri' || type === 'dataurl') {
            try {
              const base64 = String(result).split(',')[1];
              const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
              const blob = new Blob([bytes], { type: 'application/pdf' });
              settled = true;
              restoreAll();
              clearTimeout(timeoutId);
              console.log('[drive-push] captured PDF via output(' + type + ')');
              resolve({ blob, filename: capturedFilename });
            } catch(e) {
              console.log('[drive-push] output(' + type + ') capture failed to convert:', e.message);
            }
          }
        }
        return result;
      };
    }

    const jsPDFProto = window.jspdf.jsPDF.prototype;
    const originalProtoOutput = jsPDFProto.output;
    jsPDFProto.output = makePatchedOutput(originalProtoOutput);

    // ── ALSO patch jsPDF constructor so any instance created with its OWN
    //    instance-level `output` (some jsPDF builds assign `this.output = ...`
    //    inside the constructor, which shadows the prototype and would make
    //    the prototype patch above silently never fire) gets intercepted too. ──
    const OriginalJsPDF = window.jspdf.jsPDF;
    function PatchedJsPDF(...args){
      const instance = new OriginalJsPDF(...args);
      if (Object.prototype.hasOwnProperty.call(instance, 'output')) {
        const originalInstanceOutput = instance.output.bind(instance);
        instance.output = makePatchedOutput(originalInstanceOutput);
      }
      return instance;
    }
    PatchedJsPDF.prototype = OriginalJsPDF.prototype;
    Object.setPrototypeOf(PatchedJsPDF, OriginalJsPDF);
    window.jspdf.jsPDF = PatchedJsPDF;

    function restoreOutputPatches(){
      jsPDFProto.output = originalProtoOutput;
      window.jspdf.jsPDF = OriginalJsPDF;
    }

    /* ── INTERCEPT: block iframe write that triggers auto-download ──────
       The hidden iframe has its contentDocument.write() called with an
       HTML page containing an auto-clicking <a>. We intercept
       document.body.appendChild for the iframe element itself, and also
       patch iframe contentDocument.write to be a no-op once we've
       captured the PDF bytes. ────────────────────────────────────────── */
    const originalAppendChild = document.body.appendChild.bind(document.body);
    document.body.appendChild = function(el){
      // Block any hidden <a> used for download (legacy path)
      if (el && el.tagName === 'A' && el.download && (el.download.endsWith('.pdf') || el.download.endsWith('.json'))) {
        capturedFilename = el.download;
        return el; // don't append
      }
      // For iframes being inserted, patch their write method to suppress the download HTML
      if (el && el.tagName === 'IFRAME') {
        const result = originalAppendChild(el);
        // Patch contentDocument.write after the iframe is in the DOM
        try {
          const iDoc = el.contentDocument || (el.contentWindow && el.contentWindow.document);
          if (iDoc) {
            const originalWrite = iDoc.write.bind(iDoc);
            iDoc.write = function(html){
              // If this write contains a PDF data URI download, suppress it
              if (typeof html === 'string' && html.includes('data:application/pdf')) {
                // Extract filename from the download attribute if present
                const fnMatch = html.match(/download="([^"]+\.pdf)"/);
                if (fnMatch) capturedFilename = fnMatch[1].replace(/&quot;/g, '"');
                iDoc.write = originalWrite; // restore
                return; // block the write — PDF already captured via output() patch
              }
              return originalWrite(html);
            };
          }
        } catch(e) { /* cross-origin iframe — ignore */ }
        return result;
      }
      return originalAppendChild(el);
    };

    /* ── ALSO intercept URL.createObjectURL as a legacy fallback path ── */
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function(blob){
      if (!settled && blob instanceof Blob && blob.type === 'application/pdf') {
        settled = true;
        URL.createObjectURL = originalCreateObjectURL;
        restoreAll();
        clearTimeout(timeoutId);
        resolve({ blob, filename: capturedFilename });
        return 'about:blank';
      }
      return originalCreateObjectURL(blob);
    };

    function restoreAll(){
      window.toast = originalToast;
      restoreOutputPatches();
      URL.createObjectURL = originalCreateObjectURL;
      document.body.appendChild = originalAppendChild;
    }

    // Safety timeout — restore everything and reject if PDF never finishes.
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
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
            restoreAll();
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      );
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

/* ── FUZZY FOLDER MATCHING HELPERS ──
   Used ONLY when findFolder() is called with an explicit matchMode of
   'institution' or 'fuzzy' (see resolveDestinationFolder below). Every
   existing call site that doesn't pass a matchMode keeps the original
   exact case-insensitive match — nothing changes for those. */

// Levenshtein edit distance between two strings.
function _levenshtein(a, b){
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

// Normalize a string for fuzzy comparison: lowercase, strip punctuation, collapse spaces.
function _normalizeForCompare(s){
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// True if two strings are "close enough" to be the same name — handles
// plurals, spacing, and small typos (NOT institution-type-aware).
function _namesAreSimilar(a, b){
  const na = _normalizeForCompare(a);
  const nb = _normalizeForCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const maxLen = Math.max(na.length, nb.length);
  const dist = _levenshtein(na, nb);
  const threshold = Math.max(1, Math.floor(maxLen * 0.2)); // allow ~20% drift
  return dist <= threshold;
}

// Institution type keywords, most-specific first.
const _INSTITUTION_TYPES = ['polytechnic', 'university', 'institute', 'college'];

// Find the institution type in a name, returning both the normalized
// category ('University'/'Polytechnic'/'Institute'/'College') and the
// actual word/phrase matched (so it can be stripped correctly even if
// it was typo'd, e.g. matchedWord "Univeristy" with category "University").
// Returns null if no type is found.
function _findInstitutionType(raw){
  const s = raw || '';
  const lower = ' ' + s.toLowerCase() + ' ';
  for (const t of _INSTITUTION_TYPES) {
    if (lower.includes(t)) {
      return { category: t.charAt(0).toUpperCase() + t.slice(1), matchedWord: t };
    }
  }
  if (/\buni\b/.test(lower)) return { category: 'University', matchedWord: 'uni' };
  // Fuzzy fallback: check each word against each type keyword for a close typo match.
  const words = lower.trim().split(/\s+/);
  for (const w of words) {
    if (w.length < 4) continue; // too short to safely fuzzy-match
    for (const t of _INSTITUTION_TYPES) {
      const dist = _levenshtein(w, t);
      if (dist <= 2 && Math.abs(w.length - t.length) <= 2) {
        return { category: t.charAt(0).toUpperCase() + t.slice(1), matchedWord: w };
      }
    }
  }
  return null;
}

// Extract a normalized institution type from a name, or null if none found.
function _extractInstitutionType(raw){
  const found = _findInstitutionType(raw);
  return found ? found.category : null;
}

// Split a raw institution name into { type, name }: `type` is the
// normalized institution type, `name` is the remaining words with the
// type keyword and filler word "of" stripped out.
function _splitInstitutionName(raw){
  const s = (raw || '').trim();
  const found = _findInstitutionType(s);
  if (!found) return { type: null, name: s };
  const typeRe = new RegExp('\\b' + found.matchedWord + '\\b', 'ig');
  let name = s.replace(typeRe, ' ').replace(/\bof\b/ig, ' ');
  name = name.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  return { type: found.category, name };
}

// True if two institution names refer to the same school. The type MUST
// match exactly (so "Delta State University" can never merge with
// "Delta State Polytechnic"); the name part tolerates minor spelling drift.
function _institutionNamesMatch(a, b){
  const sa = _splitInstitutionName(a);
  const sb = _splitInstitutionName(b);
  if (!sa.type || !sb.type) return _namesAreSimilar(a, b);
  if (sa.type !== sb.type) return false;
  return _namesAreSimilar(sa.name, sb.name);
}

// Find a child folder by name (case-insensitive) inside parentId. Returns folder id or null.
// We list ALL folders in the parent and compare lowercased names so that
// existing folders like "Faculty" are found even if we search for "faculty".
// matchMode:
//   (default)      — original exact case-insensitive match, UNCHANGED.
//   'institution'  — type-exact + name-fuzzy match (see _institutionNamesMatch).
//   'fuzzy'        — plain drift-tolerant match (see _namesAreSimilar).
async function findFolder(name, parentId, matchMode){
  const q = encodeURIComponent(
    `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const data = await driveFetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name)&pageSize=1000`);
  if (!data.files || !data.files.length) return null;

  if (matchMode === 'institution') {
    const match = data.files.find(f => _institutionNamesMatch(f.name, name));
    return match ? match.id : null;
  }
  if (matchMode === 'fuzzy') {
    const match = data.files.find(f => _namesAreSimilar(f.name, name));
    return match ? match.id : null;
  }

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
async function findOrCreateFolder(name, parentId, matchMode){
  const existing = await findFolder(name, parentId, matchMode);
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

  // 1. Direct acronym match (e.g. "EKSU", "eksu", "(EKSU)", "UNILAG")
  const acronymKey = u.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (typeof UNIVERSITY_ALIASES !== 'undefined' && UNIVERSITY_ALIASES[acronymKey]) {
    return UNIVERSITY_ALIASES[acronymKey];
  }

  // 2. Type-exact + name-fuzzy match against the alias list (handles typos/
  //    variants like "Ekiti State Uni" or "Ekiti State Univeristy"). Only
  //    attempted when the input itself looks like an institution name
  //    (has a detectable type), so short/unrelated strings can't misfire.
  if (typeof UNIVERSITY_ALIASES !== 'undefined' && _extractInstitutionType(u)) {
    for (const key in UNIVERSITY_ALIASES) {
      const canonical = UNIVERSITY_ALIASES[key];
      if (_institutionNamesMatch(u, canonical)) return canonical;
    }
  }

  return u; // any other university: use the extracted name as-is for the new folder
}

function resolveFacultyFolderName(facultyRaw){
  const f = (facultyRaw || '').trim();
  if (!f) return 'GST PAST QUESTIONS';
  // Normalize common GST course naming into the GST bucket
  if (/general\s*studies|^gst\b/i.test(f)) return 'GST PAST QUESTIONS';

  // Strip any existing "Faculty" / "Faculty of" prefix (in any casing) so
  // we can rebuild it consistently no matter how the AI phrased it.
  let core = f.replace(/^\s*faculty\s*(of)?\s*/i, '').trim();
  if (!core) core = f; // safety net: never end up with an empty name

  // Title-case the remaining words, keeping small joining words lowercase
  // (except when they're the very first word).
  const smallWords = new Set(['of', 'and', 'the']);
  const titled = core
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (smallWords.has(w) && i !== 0) ? w : (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');

  return `Faculty of ${titled}`;
}

function resolveSemesterFolderName(semesterRaw){
  const s = (semesterRaw || '').toLowerCase();
  if (s.includes('1') || s.includes('first') || s.includes('1st')) return 'First Semester';
  if (s.includes('2') || s.includes('second') || s.includes('2nd')) return 'Second Semester';
  // Default to First Semester if AI extraction didn't yield a clear semester
  return 'First Semester';
}

function resolveDepartmentFolderName(departmentRaw){
  const d = (departmentRaw || '').trim();
  if (!d) return '';
  // Convert to title case so it matches existing Drive folders
  // e.g. "DEPARTMENT OF PHYSICS" or "department of physics" → "Department of Physics"
  return d.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/* ── FULL PATH RESOLUTION: root → university → faculty → faculty-name → department → department-name → semester ── */
async function resolveDestinationFolder(universityRaw, facultyRaw, departmentRaw, semesterRaw){
  const universityName = resolveUniversityFolderName(universityRaw);
  const facultyName     = resolveFacultyFolderName(facultyRaw);
  const departmentName  = resolveDepartmentFolderName(departmentRaw);
  const semesterName    = resolveSemesterFolderName(semesterRaw);

  const universityFolderId = await findOrCreateFolder(universityName, DRIVE_ROOT_FOLDER_ID, 'institution');
  const facultyRootId       = await findOrCreateFolder('Faculty', universityFolderId);
  const facultyFolderId     = await findOrCreateFolder(facultyName, facultyRootId, 'fuzzy');

  let semesterParentId;
  if (departmentName) {
    const departmentRootId  = await findOrCreateFolder('Department', facultyFolderId);
    const departmentFolderId = await findOrCreateFolder(departmentName, departmentRootId, 'fuzzy');
    semesterParentId = departmentFolderId;
  } else {
    semesterParentId = facultyFolderId;
  }

  const semesterFolderId = await findOrCreateFolder(semesterName, semesterParentId);

  return { universityFolderId, facultyFolderId, semesterFolderId, universityName, facultyName, departmentName, semesterName };
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
    const department  = (extractedData && extractedData.courseDepartment) || '';
    const semester    = (extractedData && extractedData.courseSemester) || '';
    const docTitle    = (extractedData && (extractedData.docTitle || extractedData.courseTitle)) || 'Quiz';
    const year        = (extractedData && extractedData.courseYear) || '';
    const courseCode  = (extractedData && extractedData.courseCode) || '';

    const dest = await resolveDestinationFolder(university, faculty, department, semester);

    const fnameParts = [courseCode, year.replace(/[^0-9]/g,''), dest.semesterName.toUpperCase(), dest.facultyName.toUpperCase(), dest.departmentName.toUpperCase(), docTitle, dest.universityName.toUpperCase()];
    const fnameBase = fnameParts.filter(Boolean).join('_').replace(/[^a-zA-Z0-9\s_]/g,'').replace(/\s+/g,'_');

    setBusy('📄 Generating Questions PDF…');
    await tick();
    const qPdf = await capturePDF('questions');

    setBusy('📝 Generating Q+A PDF…');
    await tick();
    const aPdf = await capturePDF('answers');

    setBusy('☁️ Uploading Questions PDF…');
    await tick();
    const qResult = await uploadFileToFolder(qPdf.blob, `${fnameBase}_Questions.pdf`, dest.semesterFolderId);

    setBusy('☁️ Uploading Q+A PDF…');
    await tick();
    const aResult = await uploadFileToFolder(aPdf.blob, `${fnameBase}_QA.pdf`, dest.semesterFolderId);

    const courseInfo = [docTitle, year, dest.semesterName].filter(Boolean).join(' · ');
    const deptInfo = dest.departmentName ? ` → ${dest.departmentName}` : '';
    toast(`Pushed to Drive: ${courseInfo} → ${dest.facultyName}${deptInfo} → ${dest.universityName}`, 'success');

    // Inject WPDM button now that we have both Drive file results
    if (typeof initWpdmButton === 'function') {
      await initWpdmButton(qResult, aResult, qPdf.blob, aPdf.blob);
    } else {
      console.error('[drive-push] initWpdmButton not found — is wpdm-push.js loaded before drive-push.js in index.html?');
      toast('Drive push succeeded but WPDM button unavailable — check wpdm-push.js is loaded', 'error');
    }
  } catch (err) {
    console.error(err);
    toast(`Drive push failed: ${err.message}`, 'error');
  } finally {
    clearBusy();
  }
}
