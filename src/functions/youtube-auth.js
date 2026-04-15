const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

app.http('youtube-auth', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const credential = new DefaultAzureCredential();
            const client = new SecretClient(
                process.env.KEY_VAULT_URL, credential
            );

            const clientId = await client.getSecret('youtube-client-id');
            const redirectUri = process.env.YOUTUBE_REDIRECT_URI;

            const scopes = [
                'https://www.googleapis.com/auth/youtube',
                'https://www.googleapis.com/auth/youtube.force-ssl'
            ].join(' ');

            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                `client_id=${clientId.value}` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&response_type=code` +
                `&scope=${encodeURIComponent(scopes)}` +
                `&access_type=offline` +
                `&prompt=consent`;

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