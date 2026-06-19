// /api/wp-proxy.js
// Vercel Serverless Function.
// Proxies all WordPress REST API calls (media uploads, post/package
// creation, etc). The WordPress username + Application Password live
// ONLY in Vercel's environment variables — never shipped to the
// browser, never visible in page source, never committed to the repo.
//
// Set these in Vercel: Project Settings → Environment Variables
//   WP_BASE_URL       e.g. https://eduglobalforge.com/pastquestions
//   WP_USERNAME        your WordPress username
//   WP_APP_PASSWORD    a WordPress Application Password (Users → Profile →
//                       Application Passwords). NOT your login password.
//
// The browser sends a description of the WP REST call it wants made;
// this function attaches Basic Auth and forwards it. It never sees or
// returns the credentials.
//
// Request body shapes the browser can send:
//
//  1) JSON request (e.g. create/update a post, WPDM package, etc.)
//     {
//       path: '/wp/v2/posts',      // relative to {WP_BASE_URL}/wp-json
//       method: 'POST',            // GET | POST | PUT | DELETE
//       json: { title: '...', status: 'publish', ... }
//     }
//
//  2) Binary file upload (e.g. PDF to /wp/v2/media)
//     {
//       path: '/wp/v2/media',
//       method: 'POST',
//       fileBase64: '<base64 string, no data: prefix>',
//       filename: 'past-questions.pdf',
//       mimeType: 'application/pdf'
//     }

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '25mb' // allow reasonably large PDF uploads as base64
    }
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { WP_BASE_URL, WP_USERNAME, WP_APP_PASSWORD } = process.env;
  if (!WP_BASE_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
    res.status(500).json({ error: 'Server is missing WP_BASE_URL, WP_USERNAME, or WP_APP_PASSWORD environment variables.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const { path, method, json, fileBase64, filename, mimeType } = body || {};

  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    res.status(400).json({ error: 'Missing or invalid "path" — must start with /, e.g. /wp/v2/media' });
    return;
  }

  const httpMethod = (method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(httpMethod)) {
    res.status(400).json({ error: `Unsupported method: ${httpMethod}` });
    return;
  }

  const base = WP_BASE_URL.replace(/\/+$/, '');
  const url = `${base}/wp-json${path}`;
  const authHeader = 'Basic ' + Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString('base64');

  try {
    let fetchRes;

    if (fileBase64) {
      // Binary upload (e.g. PDF -> /wp/v2/media)
      if (!filename || !mimeType) {
        res.status(400).json({ error: 'fileBase64 uploads require both "filename" and "mimeType"' });
        return;
      }
      const fileBuffer = Buffer.from(fileBase64, 'base64');
      fetchRes = await fetch(url, {
        method: httpMethod,
        headers: {
          'Authorization': authHeader,
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`
        },
        body: fileBuffer
      });
    } else {
      // JSON request
      fetchRes = await fetch(url, {
        method: httpMethod,
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: (httpMethod === 'GET' || httpMethod === 'DELETE') ? undefined : JSON.stringify(json || {})
      });
    }

    const contentType = fetchRes.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await fetchRes.json().catch(() => ({}))
      : await fetchRes.text();

    if (!fetchRes.ok) {
      res.status(fetchRes.status).json({
        error: (data && data.message) ? data.message : `WordPress error (${fetchRes.status})`,
        details: data
      });
      return;
    }

    res.status(200).json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected error during WordPress request' });
  }
}
  
