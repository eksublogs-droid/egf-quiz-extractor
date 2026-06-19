// /api/gist-sync.js
// Vercel Serverless Function.
// Proxies all GitHub Gist read/write calls for cross-device sync.
// The GitHub token lives ONLY in Vercel's environment variables —
// never shipped to the browser, never visible in page source, never
// committed to the repo.
//
// Set this in Vercel: Project Settings → Environment Variables
//   GIST_SYNC_TOKEN   (a GitHub personal access token, gist scope ONLY,
//                       ideally on a throwaway account with no other access)
//
// The browser talks only to this endpoint, sending an `action` and the
// already-encrypted blob. It never sees the GitHub token.

const GIST_FILENAME = 'eduglobalforge-sync.json';
const GIST_DESC = 'EduGlobalForge — Encrypted Sync Blob (do not edit manually)';
const GITHUB_API = 'https://api.github.com';

function ghHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'eduglobalforge-sync'
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { GIST_SYNC_TOKEN } = process.env;
  if (!GIST_SYNC_TOKEN) {
    res.status(500).json({ error: 'Server is missing GIST_SYNC_TOKEN environment variable.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const { action, gistId, blob } = body || {};

  try {
    if (action === 'find-or-create') {
      if (gistId) {
        const check = await fetch(`${GITHUB_API}/gists/${gistId}`, { headers: ghHeaders(GIST_SYNC_TOKEN) });
        if (check.ok) {
          res.status(200).json({ gistId });
          return;
        }
        // fall through to search/create if the saved id is no longer valid
      }

      const listRes = await fetch(`${GITHUB_API}/gists`, { headers: ghHeaders(GIST_SYNC_TOKEN) });
      if (!listRes.ok) {
        res.status(listRes.status).json({ error: `GitHub error listing gists (${listRes.status})` });
        return;
      }
      const gists = await listRes.json();
      const match = gists.find(g => g.description === GIST_DESC && g.files && g.files[GIST_FILENAME]);
      if (match) {
        res.status(200).json({ gistId: match.id });
        return;
      }

      const createRes = await fetch(`${GITHUB_API}/gists`, {
        method: 'POST',
        headers: ghHeaders(GIST_SYNC_TOKEN),
        body: JSON.stringify({
          description: GIST_DESC,
          public: false,
          files: { [GIST_FILENAME]: { content: JSON.stringify({ salt: '', iv: '', data: '' }, null, 2) } }
        })
      });
      if (!createRes.ok) {
        res.status(createRes.status).json({ error: `GitHub error creating gist (${createRes.status})` });
        return;
      }
      const created = await createRes.json();
      res.status(200).json({ gistId: created.id });
      return;
    }

    if (action === 'fetch') {
      if (!gistId) { res.status(400).json({ error: 'Missing gistId' }); return; }
      const r = await fetch(`${GITHUB_API}/gists/${gistId}`, { headers: ghHeaders(GIST_SYNC_TOKEN) });
      if (!r.ok) {
        res.status(r.status).json({ error: `GitHub error reading gist (${r.status})` });
        return;
      }
      const gist = await r.json();
      const file = gist.files[GIST_FILENAME];
      if (!file) { res.status(200).json({ blob: null }); return; }
      try {
        const parsed = JSON.parse(file.content);
        res.status(200).json({ blob: (parsed && parsed.data) ? parsed : null });
      } catch (_) {
        res.status(200).json({ blob: null });
      }
      return;
    }

    if (action === 'push') {
      if (!gistId || !blob) { res.status(400).json({ error: 'Missing gistId or blob' }); return; }
      const r = await fetch(`${GITHUB_API}/gists/${gistId}`, {
        method: 'PATCH',
        headers: ghHeaders(GIST_SYNC_TOKEN),
        body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(blob, null, 2) } } })
      });
      if (!r.ok) {
        res.status(r.status).json({ error: `GitHub error saving to gist (${r.status})` });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected error during gist sync' });
  }
          }
        
