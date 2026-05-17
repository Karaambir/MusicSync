'use strict';

/**
 * daily-sync.js — MusicSync
 *
 * Timer-triggered function that runs once per day.
 * Fetches the user's Spotify + YouTube playlists and upserts them
 * into Azure Table Storage (table: musicsyncPlaylists).
 *
 * BUG THAT WAS FIXED:
 *   Previously used tableClient.updateEntity() which throws 404
 *   if the entity doesn't already exist. Changed to upsertEntity('Merge')
 *   so the function works on both first-run and subsequent runs.
 */

const { app }        = require('@azure/functions');
const { TableClient, TableServiceClient } = require('@azure/data-tables');
const { getValidToken }                   = require('./tokenManager');
const axios = require('axios');

const PLAYLISTS_TABLE = 'musicsyncPlaylists';
const SYNC_LOG_TABLE  = 'musicsyncSyncLog';

// ─── Timer trigger: runs daily at 02:00 UTC ────────────────────────────────
app.timer('daily-sync', {
  schedule: '0 0 2 * * *',   // cron: sec min hr day month weekday
  runOnStartup: false,

  handler: async (myTimer, context) => {
    const log       = (...args) => context.log(...args);
    const startedAt = new Date().toISOString();

    log('[daily-sync] Starting sync run:', startedAt);

    if (myTimer.isPastDue) {
      log('[daily-sync] WARNING: Timer is running late — previous run may have failed');
    }

    const results = { spotify: null, youtube: null, errors: [] };

    // ── Ensure tables exist ────────────────────────────────────────────────
    await ensureTablesExist();

    // ── Spotify ────────────────────────────────────────────────────────────
    try {
      const spotifyToken  = await getValidToken('spotify', log);
      const spotifyCount  = await syncSpotifyPlaylists(spotifyToken, log);
      results.spotify     = { synced: spotifyCount, status: 'ok' };
      log(`[daily-sync] Spotify: ${spotifyCount} playlists synced ✓`);
    } catch (err) {
      context.log.error('[daily-sync] Spotify sync failed:', err.message);
      results.spotify = { status: 'error', message: err.message };
      results.errors.push(`spotify: ${err.message}`);
    }

    // ── YouTube ────────────────────────────────────────────────────────────
    try {
      const youtubeToken = await getValidToken('youtube', log);
      const youtubeCount = await syncYouTubePlaylists(youtubeToken, log);
      results.youtube    = { synced: youtubeCount, status: 'ok' };
      log(`[daily-sync] YouTube: ${youtubeCount} playlists synced ✓`);
    } catch (err) {
      context.log.error('[daily-sync] YouTube sync failed:', err.message);
      results.youtube = { status: 'error', message: err.message };
      results.errors.push(`youtube: ${err.message}`);
    }

    // ── Write sync log ─────────────────────────────────────────────────────
    await writeSyncLog({ startedAt, results });

    if (results.errors.length > 0) {
      context.log.warn('[daily-sync] Completed with errors:', results.errors.join(' | '));
    } else {
      log('[daily-sync] All platforms synced successfully ✓');
    }
  },
});

// ─── Spotify sync ──────────────────────────────────────────────────────────
async function syncSpotifyPlaylists(accessToken, log) {
  const tableClient = getPlaylistsTable();
  let   url         = 'https://api.spotify.com/v1/me/playlists?limit=50';
  let   totalSynced = 0;

  while (url) {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    for (const playlist of data.items) {
      const entity = {
        partitionKey: 'spotify',
        rowKey:       playlist.id,
        name:         playlist.name,
        description:  playlist.description || '',
        trackCount:   playlist.tracks.total,
        isPublic:     playlist.public,
        externalUrl:  playlist.external_urls?.spotify || '',
        imageUrl:     playlist.images?.[0]?.url || '',
        lastSyncedAt: new Date().toISOString(),
      };

      // KEY FIX: upsertEntity('Merge') creates-or-updates without throwing
      // on missing entities. 'Merge' preserves any extra fields you added manually.
      await tableClient.upsertEntity(entity, 'Merge');
      totalSynced++;
    }

    url = data.next || null; // Spotify pagination
  }

  return totalSynced;
}

// ─── YouTube sync ──────────────────────────────────────────────────────────
async function syncYouTubePlaylists(accessToken, log) {
  const tableClient = getPlaylistsTable();
  let   pageToken   = '';
  let   totalSynced = 0;

  do {
    const params = {
      part:       'snippet,contentDetails,status',
      mine:       true,
      maxResults: 50,
    };
    if (pageToken) params.pageToken = pageToken;

    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/playlists', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params,
    });

    for (const playlist of data.items) {
      const snippet = playlist.snippet;
      const entity  = {
        partitionKey: 'youtube',
        rowKey:       playlist.id,
        name:         snippet.title,
        description:  snippet.description || '',
        trackCount:   playlist.contentDetails?.itemCount ?? 0,
        isPublic:     playlist.status?.privacyStatus === 'public',
        externalUrl:  `https://www.youtube.com/playlist?list=${playlist.id}`,
        imageUrl:     snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || '',
        channelTitle: snippet.channelTitle || '',
        lastSyncedAt: new Date().toISOString(),
      };

      // KEY FIX: same as Spotify — upsertEntity, not updateEntity
      await tableClient.upsertEntity(entity, 'Merge');
      totalSynced++;
    }

    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return totalSynced;
}

// ─── Sync log writer ───────────────────────────────────────────────────────
async function writeSyncLog({ startedAt, results }) {
  try {
    const connStr    = process.env.AzureWebJobsStorage;
    const logClient  = TableClient.fromConnectionString(connStr, SYNC_LOG_TABLE);
    const runId      = startedAt.replace(/[:.]/g, '-');

    await logClient.upsertEntity({
      partitionKey:       'syncLog',
      rowKey:             runId,
      spotifyStatus:      results.spotify?.status || 'skipped',
      spotifySynced:      results.spotify?.synced ?? 0,
      youtubeStatus:      results.youtube?.status || 'skipped',
      youtubeSynced:      results.youtube?.synced ?? 0,
      errors:             results.errors.join(' | '),
      completedAt:        new Date().toISOString(),
    }, 'Replace');
  } catch (err) {
    // Non-fatal — don't let logging failures break the main sync
    console.warn('[daily-sync] Could not write sync log:', err.message);
  }
}

// ─── Table helpers ─────────────────────────────────────────────────────────
function getPlaylistsTable() {
  const connStr = process.env.AzureWebJobsStorage;
  return TableClient.fromConnectionString(connStr, PLAYLISTS_TABLE);
}

async function ensureTablesExist() {
  const connStr       = process.env.AzureWebJobsStorage;
  const serviceClient = TableServiceClient.fromConnectionString(connStr);
  const tables        = [PLAYLISTS_TABLE, SYNC_LOG_TABLE];

  for (const tableName of tables) {
    try {
      await serviceClient.createTable(tableName);
    } catch (e) {
      if (e.statusCode !== 409) throw e; // 409 = already exists, ignore
    }
  }
}
