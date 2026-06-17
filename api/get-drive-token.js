// /api/get-drive-token.js
// Vercel Serverless Function.
// Exchanges your permanent refresh token for a short-lived access token,
// using credentials that live ONLY in Vercel's environment variables
// (never shipped to the browser, never visible in page source).
//
// Set these in Vercel: Project Settings → Environment Variables
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN

export default async function handler(req, res) {
  // Lock this down to GET only; simple and sufficient for this use case.
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    res.status(500).json({ error: 'Server is missing Google OAuth environment variables.' });
    return;
  }

  try {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const data = await tokenRes.json();

    if (!tokenRes.ok) {
      res.status(tokenRes.status).json({ error: data.error_description || data.error || 'Token refresh failed' });
      return;
    }

    // Only ever return the short-lived access token + its expiry to the browser.
    // The refresh token and client secret never leave this function.
    res.status(200).json({
      access_token: data.access_token,
      expires_in: data.expires_in
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected error refreshing token' });
  }
}
