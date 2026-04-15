const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');
const { TableClient } = require('@azure/data-tables');
const axios = require('axios');

app.timer('daily-sync', {
    schedule: '0 0 2 * * *', // Runs every day at 2:00 AM
    handler: async (myTimer, context) => {
        context.log('🔄 Daily sync started:', new Date().toISOString());

        try {
            // Get secrets from Key Vault
            const credential = new DefaultAzureCredential();
            const kvClient = new SecretClient(
                process.env.KEY_VAULT_URL, credential
            );

            // Get Table Storage client
            const tableClient = TableClient.fromConnectionString(
                process.env.AzureWebJobsStorage,
                'playlists'
            );

            // Step 1 — Get saved YouTube token
            const tokenEntity = await tableClient.getEntity('tokens', 'youtube');
            const youtubeToken = tokenEntity.accessToken;

            // Step 2 — Get saved Spotify token
            const spotifyTokenEntity = await tableClient.getEntity('tokens', 'spotify');
            const spotifyToken = spotifyTokenEntity.accessToken;

            // Step 3 — Get all saved playlists to sync
            const playlistEntities = tableClient.listEntities({
                queryOptions: { filter: `PartitionKey eq 'user1'` }
            });

            let totalAdded = 0;
            let totalRemoved = 0;
            let playlistsProcessed = 0;

            for await (const playlist of playlistEntities) {
                context.log(`Syncing playlist: ${playlist.rowKey}`);

                // Get current tracks from Spotify
                const currentTracksResponse = await axios.get(
                    `https://api.spotify.com/v1/playlists/${playlist.rowKey}/tracks`,
                    { headers: { 'Authorization': `Bearer ${spotifyToken}` } }
                );

                const currentTracks = currentTracksResponse.data.items.map(item => ({
                    name: item.track.name,
                    artist: item.track.artists[0].name
                }));

                // Compare with last saved snapshot
                const lastTracks = JSON.parse(playlist.tracks || '[]');

                // Find new songs
                const newSongs = currentTracks.filter(curr =>
                    !lastTracks.find(last =>
                        last.name === curr.name && last.artist === curr.artist
                    )
                );

                // Find removed songs
                const removedSongs = lastTracks.filter(last =>
                    !currentTracks.find(curr =>
                        curr.name === last.name && curr.artist === last.artist
                    )
                );

                context.log(`Found ${newSongs.length} new, ${removedSongs.length} removed`);

                // Update snapshot in Table Storage
                await tableClient.upsertEntity({
                    partitionKey: 'user1',
                    rowKey: playlist.rowKey,
                    tracks: JSON.stringify(currentTracks),
                    lastSync: new Date().toISOString(),
                    trackCount: currentTracks.length,
                    lastAddedCount: newSongs.length,
                    lastRemovedCount: removedSongs.length
                });

                totalAdded += newSongs.length;
                totalRemoved += removedSongs.length;
                playlistsProcessed++;
            }

            // Step 4 — Log sync summary
            const summary = {
                date: new Date().toISOString(),
                playlistsProcessed,
                totalAdded,
                totalRemoved,
                status: 'success'
            };

            context.log('✅ Daily sync complete:', JSON.stringify(summary));

        } catch (error) {
            context.log('❌ Sync error:', error.message);
        }
    }
});