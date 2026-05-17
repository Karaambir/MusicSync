'use strict';

const { TableClient, TableServiceClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const axios = require('axios');

// ─── Config ────────────────────────────────────────────────────────────────
const KEY_VAULT_URI   = 'https://kv-musicsync.vault.azure.net';
const TOKENS_TABLE    = 'musicsyncTokens';
const TOKEN_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before actual expiry

// ─── Clients ───────────────────────────────────────────────────────────────
const credential = new DefaultAzureCredential();
const kvClient   = new SecretClient(KEY_VAULT_URI, credential);

// Cache KV secrets in memory per cold-start to avoid repeated round-trips
const secretCache = {};
async function getSecret(name) {
  if (!secretCache[name]) {
    const { value } = await kvClient.getSecret(name);
    secretCache[name] = value;
  }
  return secretCache[name];
}

function getTableClient() {
  const connStr = process.env.AzureWebJobsStorage;
  if (!connStr) throw new Error('AzureWebJobsStorage env var is not set');
  return TableClient.fromConnectionString(connStr, TOKENS_TABLE);
}

// ─── Ensure table exists (idempotent) ─────────────────────────────────────
async function ensureTableExists() {
  const connStr = process.env.AzureWebJobsStorage;
  const serviceClient = TableServiceClient.fromConnectionString(connStr);
  try {
    await serviceClient.createTable(TOKENS_TABLE);
  } catch (e) {
    // TableAlreadyExists is fine; anything else is real
    if (e.statusCode !== 409) throw e;
  }
}

// ─── Storage helpers ───────────────────────────────────────────────────────
async function getStoredToken(service) {
  const tableClient = getTableClient();
  try {
    return await tableClient.getEntity('oauth', service);
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

/**
 * Persist tokens to Table Storage.
 * Always uses upsertEntity('Replace') so it works on first auth AND on refresh.
 */
async function storeToken(service, accessToken, refreshToken, expiresInSeconds) {
  await ensureTableExists();
  const tableClient = getTableClient();
  const expiresAt   = (Date.now() + expiresInSeconds * 1000).toString();

  const entity = {
    partitionKey: 'oauth',
    rowKey:       service,
    accessToken,
    refreshToken,
    expiresAt,
    updatedAt: new Date().toISOString(),
  };

  // 'Replace' = full overwrite — no stale field leftover from a previous shape
  await tableClient.upsertEntity(entity, 'Replace');
}

// ─── Platform-specific refresh logic ──────────────────────────────────────
async function refreshSpotifyToken(refreshToken, log) {
  log('[tokenManager] Refreshing Spotify access token...');
  const clientId     = await getSecret('spotify-client-id');
  const clientSecret = await getSecret('spotify-client-secret');
  const basic        = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  });

  const { data } = await axios.post(
    'https://accounts.spotify.com/api/token',
    body.toString(),
    { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  // Spotify only returns a new refresh_token occasionally (rolling refresh)
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || refreshToken, // keep old if not rotated
    expires_in:    data.expires_in,
  };
}

async function refreshYouTubeToken(refreshToken, log) {
  log('[tokenManager] Refreshing YouTube access token...');
  const clientId     = await getSecret('youtube-client-id');
  const clientSecret = await getSecret('youtube-client-secret');

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const { data } = await axios.post(
    'https://oauth2.googleapis.com/token',
    body.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  // Google rarely rotates refresh tokens — keep existing if not returned
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in:    data.expires_in,
  };
}

// ─── Main export ───────────────────────────────────────────────────────────
/**
 * Returns a guaranteed-valid access token for the given service.
 * Transparently refreshes when expired or near expiry.
 *
 * @param {'spotify' | 'youtube'} service
 * @param {Function} [log]  - pass context.log from the calling function
 * @returns {Promise<string>} valid access token
 */
async function getValidToken(service, log = console.log) {
  const stored = await getStoredToken(service);

  if (!stored) {
    throw new Error(
      `No stored token for "${service}". ` +
      `User must complete the OAuth flow first (hit /${service}-auth).`
    );
  }

  const expiresAt         = parseInt(stored.expiresAt, 10);
  const isExpiredOrNearBy = Date.now() >= expiresAt - TOKEN_BUFFER_MS;

  if (!isExpiredOrNearBy) {
    log(`[tokenManager] ${service} token is valid (expires in ${Math.round((expiresAt - Date.now()) / 60000)} min)`);
    return stored.accessToken;
  }

  // ── Refresh path ──
  let newTokenData;
  if (service === 'spotify') {
    newTokenData = await refreshSpotifyToken(stored.refreshToken, log);
  } else if (service === 'youtube') {
    newTokenData = await refreshYouTubeToken(stored.refreshToken, log);
  } else {
    throw new Error(`Unknown service: "${service}"`);
  }

  await storeToken(
    service,
    newTokenData.access_token,
    newTokenData.refresh_token,
    newTokenData.expires_in
  );

  log(`[tokenManager] ${service} token refreshed and stored ✓`);
  return newTokenData.access_token;
}

module.exports = { getValidToken, storeToken, getStoredToken, ensureTableExists };
