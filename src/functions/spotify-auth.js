const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

app.http('spotify-auth', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const credential = new DefaultAzureCredential();
            const client = new SecretClient(
                process.env.KEY_VAULT_URL, credential
            );

            const clientId = await client.getSecret('spotify-client-id');
            const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
            const scopes = [
                'playlist-read-private',
                'playlist-read-collaborative',
                'user-library-read'
            ].join(' ');

            const authUrl = `https://accounts.spotify.com/authorize?` +
                `client_id=${clientId.value}` +
                `&response_type=code` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&scope=${encodeURIComponent(scopes)}`;

            return {
                status: 302,
                headers: { 'Location': authUrl }
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