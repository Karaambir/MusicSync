const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');
const { TableClient } = require('@azure/data-tables');
const axios = require('axios');

app.http('youtube-callback', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const code = request.query.get('code');
            if (!code) {
                return { status: 400, body: 'No code provided' };
            }

            // Get secrets from Key Vault
            const credential = new DefaultAzureCredential();
            const kvClient = new SecretClient(
                process.env.KEY_VAULT_URL, credential
            );

            const clientId = await kvClient.getSecret('youtube-client-id');
            const clientSecret = await kvClient.getSecret('youtube-client-secret');
            const redirectUri = process.env.YOUTUBE_REDIRECT_URI;

            // Exchange code for tokens
            const tokenResponse = await axios.post(
                'https://oauth2.googleapis.com/token',
                {
                    code,
                    client_id: clientId.value,
                    client_secret: clientSecret.value,
                    redirect_uri: redirectUri,
                    grant_type: 'authorization_code'
                }
            );

            const { access_token, refresh_token } = tokenResponse.data;

            // Save tokens to Table Storage
            const tableClient = TableClient.fromConnectionString(
                process.env.AzureWebJobsStorage,
                'playlists'
            );

            await tableClient.upsertEntity({
                partitionKey: 'tokens',
                rowKey: 'youtube',
                accessToken: access_token,
                refreshToken: refresh_token,
                updatedAt: new Date().toISOString()
            });

            context.log('YouTube tokens saved successfully!');

            return {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
                body: `
                    <html>
                    <body style="font-family:sans-serif;text-align:center;padding:50px">
                        <h1>✅ YouTube Connected!</h1>
                        <p>Your YouTube account is now connected to MusicSync.</p>
                        <p>You can close this window.</p>
                    </body>
                    </html>
                `
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