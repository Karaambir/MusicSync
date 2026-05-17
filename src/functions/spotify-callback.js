'use strict';

const { app }      = require('@azure/functions');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient }           = require('@azure/keyvault-secrets');
const { storeToken }             = require('./tokenManager');
const axios = require('axios');

const KEY_VAULT_URI = 'https://kv-musicsync.vault.azure.net';
const credential    = new DefaultAzureCredential();
const kvClient      = new SecretClient(KEY_VAULT_URI, credential);

app.http('spotify-callback', {
  methods:   ['GET'],
  authLevel: 'anonymous',
  route:     'spotify-callback',

  handler: async (request, context) => {
    const code  = request.query.get('code');
    const error = request.query.get('error');
    const state = request.query.get('state');  // optional CSRF check

    // ── OAuth error from Spotify ──────────────────────────────────────────
    if (error) {
      context.log.error(`[spotify-callback] Spotify denied access: ${error}`);
      return {
        status:  400,
        headers: { 'Content-Type': 'text/html' },
        body:    html('❌ Spotify authorisation denied', `<p>Reason: <code>${error}</code></p><p>Close this tab and try again.</p>`),
      };
    }

    if (!code) {
      return {
        status:  400,
        headers: { 'Content-Type': 'text/html' },
        body:    html('❌ Missing code', '<p>No authorisation code was returned by Spotify.</p>'),
      };
    }

    // ── Exchange code for tokens ──────────────────────────────────────────
    try {
      const clientId     = (await kvClient.getSecret('spotify-client-id')).value;
      const clientSecret = (await kvClient.getSecret('spotify-client-secret')).value;
      const redirectUri  = process.env.SPOTIFY_REDIRECT_URI;

      if (!redirectUri) throw new Error('SPOTIFY_REDIRECT_URI env var is not configured');

      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const body = new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: redirectUri,
      });

      const { data } = await axios.post(
        'https://accounts.spotify.com/api/token',
        body.toString(),
        {
          headers: {
            Authorization:  `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const { access_token, refresh_token, expires_in } = data;

      if (!refresh_token) {
        // This means the app wasn't granted offline_access — check Spotify app scopes
        throw new Error(
          'Spotify did not return a refresh_token. ' +
          'Make sure your spotify-auth function requests the scope "user-read-private playlist-read-private playlist-modify-public".'
        );
      }

      await storeToken('spotify', access_token, refresh_token, expires_in);
      context.log('[spotify-callback] Tokens stored successfully ✓');

      return {
        status:  200,
        headers: { 'Content-Type': 'text/html' },
        body:    html(
          '✅ Spotify connected!',
          '<p>MusicSync is now authorised to access your Spotify account.</p>' +
          '<p>You can close this tab — daily syncs will run automatically.</p>'
        ),
      };
    } catch (err) {
      context.log.error('[spotify-callback] Token exchange failed:', err.message);
      return {
        status:  500,
        headers: { 'Content-Type': 'text/html' },
        body:    html('❌ Token exchange failed', `<p><code>${err.message}</code></p>`),
      };
    }
  },
});

// ─── Simple HTML response helper ───────────────────────────────────────────
function html(title, bodyContent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — MusicSync</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 1rem; color: #1a1a1a; }
    h1   { font-size: 1.5rem; margin-bottom: 0.5rem; }
    code { background: #f3f3f3; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${bodyContent}
</body>
</html>`;
}
