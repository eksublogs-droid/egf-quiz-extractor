/* ════════════════════════════════════════════════════════
   EduGlobalForge — WPDM Push Module (wpdm-push.js)
   Standalone add-on. Does NOT modify any existing files.
   Injected by drive-push.js after a successful Drive push.
   ════════════════════════════════════════════════════════ */

const WPDM_SITE       = 'https://eduglobalforge.com/pastquestions';
const WPDM_API_KEY    = '6a343066741d8';
const WPDM_CAT_ID     = 419; // "Past Questions"
const DRIVE_API_FILES = 'https://www.googleapis.com/drive/v3/files';

/* ── Set a Drive file to "Anyone with link can view" ── */
async function makePublic(fileId) {
  const token = await getDriveToken(); // reuses getDriveToken from drive-push.js
  const res = await fetch(`${DRIVE_API_FILES}/${fileId}/permissions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to set public permission (${res.status}): ${text.slice(0, 200)}`);
  }
}

/* ── Build direct download URL from Drive file ID ── */
function driveDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

/* ── Format bytes into human-readable size string e.g. "2.30 MB" ── */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/* ── Create a single WPDM package via REST API ── */
async function createWpdmPackage({ title, linkLabel, fileUrl, fileName, fileSize, basePrice }) {
  const body = {
    title,
    status:         'publish',
    categories:     [WPDM_CAT_ID],
    link_label:     linkLabel,
    download_count: 78,
    view_count:     102,
    package_size:   formatSize(fileSize),
    base_price:     basePrice,
    files:          { "1": fileUrl },
    fileinfo:       { "1": { title: fileName, url: fileUrl } }
  };

  const res = await fetch(`${WPDM_SITE}/wp-json/wpdm/v1/packages`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${WPDM_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WPDM package creation failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return res.json();
}

/* ── MAIN: called by drive-push.js after successful Drive upload ──
   qResult / aResult = { id, name } returned by uploadFileToFolder()
   qBlob   / aBlob   = the PDF blobs (for file size)
*/
async function initWpdmButton(qResult, aResult, qBlob, aBlob) {
  // Remove any previously injected button (safety guard for re-runs)
  const existing = document.getElementById('wpdmPushBtn');
  if (existing) existing.remove();

  const driveBtn = document.getElementById('pushDriveBtn');
  const jumpNav  = document.getElementById('jumpNav');

  // Hard-fail loudly if DOM anchors are missing — makes debugging instant
  if (!jumpNav && !driveBtn) {
    console.error('[wpdm-push] Cannot inject WPDM button: jumpNav and pushDriveBtn both missing from DOM');
    return;
  }

  const btn = document.createElement('button');
  btn.id        = 'wpdmPushBtn';
  btn.className = 'jump-btn';  // defined in index.html stylesheet
  btn.innerHTML = '<span class="jump-dot" style="background:#a78bfa"></span> Create WPDM Packages';

  btn.onclick = async () => {
    btn.disabled  = true;
    btn.innerHTML = '⏳ Working…';

    try {
      // Step 1 — make both Drive files publicly accessible
      btn.innerHTML = '🔓 Setting permissions…';
      await Promise.all([
        makePublic(qResult.id),
        makePublic(aResult.id)
      ]);

      // Step 2 — build direct download URLs
      const qUrl = driveDownloadUrl(qResult.id);
      const aUrl = driveDownloadUrl(aResult.id);

      // Step 3 — create both WPDM packages in parallel
      btn.innerHTML = '📦 Creating packages…';
      const [qPkg, aPkg] = await Promise.all([
        createWpdmPackage({
          title:     qResult.name,
          linkLabel: 'Download Past Questions (No Answers)',
          fileUrl:   qUrl,
          fileName:  qResult.name,
          fileSize:  qBlob.size,
          basePrice: 0
        }),
        createWpdmPackage({
          title:     aResult.name,
          linkLabel: 'Download Past Questions with Answers',
          fileUrl:   aUrl,
          fileName:  aResult.name,
          fileSize:  aBlob.size,
          basePrice: 200
        })
      ]);

      btn.innerHTML = '<span class="jump-dot" style="background:#34D399"></span> Packages Created!';
      btn.disabled  = false;

      toast(`WPDM packages created!\n• ${qPkg.title || qResult.name}\n• ${aPkg.title || aResult.name}`, 'success');

    } catch (err) {
      console.error('[wpdm-push] Package creation failed:', err);
      btn.innerHTML = '<span class="jump-dot" style="background:#a78bfa"></span> Create WPDM Packages';
      btn.disabled  = false;
      toast(`WPDM push failed: ${err.message}`, 'error');
    }
  };

  // Append into jumpNav (same nav bar as Push to Drive button).
  // Falls back to driveBtn.parentNode if jumpNav somehow isn't found.
  const container = jumpNav || driveBtn.parentNode;
  container.appendChild(btn);
  console.log('[wpdm-push] Button injected into', container.id || container.className);
}
/* ════════════════════════════════════════════════════════
   EduGlobalForge — WPDM Push Module (wpdm-push.js)
   Standalone add-on. Does NOT modify any existing files.
   Injected by drive-push.js after a successful Drive push.
   ════════════════════════════════════════════════════════ */
