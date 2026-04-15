const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');
const { TableClient } = require('@azure/data-tables');
const axios = require('axios');

app.http('transfer-playlist', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            // Get secrets from Key Vault
            const credential = new DefaultAzureCredential();
            const kvClient = new SecretClient(
                process.env.KEY_VAULT_URL, credential
            );

            const spotifyClientId = await kvClient.getSecret('spotify-client-id');
            const spotifyClientSecret = await kvClient.getSecret('spotify-client-secret');

            // Get request body
            const body = await request.json();
            const { spotifyAccessToken, playlistId } = body;

            // Step 1 — Fetch playlist tracks from Spotify
            context.log('Fetching Spotify playlist...');
            const tracksResponse = await axios.get(
                `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
                { headers: { 'Authorization': `Bearer ${spotifyAccessToken}` } }
            );

            const tracks = tracksResponse.data.items.map(item => ({
                name: item.track.name,
                artist: item.track.artists[0].name,
                album: item.track.album.name
            }));

            context.log(`Found ${tracks.length} tracks`);

            // Step 2 — Save snapshot to Table Storage
            const tableClient = TableClient.fromConnectionString(
                process.env.AzureWebJobsStorage,
                'playlists'
            );

            await tableClient.upsertEntity({
                partitionKey: 'user1',
                rowKey: playlistId,
                tracks: JSON.stringify(tracks),
                lastSync: new Date().toISOString(),
                trackCount: tracks.length
            });

            // Step 3 — Return tracks (YouTube transfer in Phase 2)
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    message: `Successfully fetched ${tracks.length} tracks!`,
                    tracks: tracks,
                    nextStep: 'YouTube transfer coming in Phase 2!'
                })
            };

        } catch (error) {
            context.log('Error:', error.message);
            return {
                status: 500,
                body: JSON.stringify({ error: error.message })
            };
        }
    }
});