import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    base: './',
    plugins: [
      react(),
      {
        name: 'google-chat-webhook-relay',
        configureServer(server) {
          server.middlewares.use('/api/google-chat-webhook', (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
              return;
            }

            let rawBody = '';
            req.setEncoding('utf8');
            req.on('data', (chunk) => {
              rawBody += chunk;
            });
            req.on('end', () => {
              void (async () => {
                try {
                  const parsedBody = JSON.parse(rawBody) as {
                    webhookUrl?: string;
                    payload?: { text?: string };
                  };
                  const webhookUrl = parsedBody.webhookUrl?.trim() ?? '';
                  const text = parsedBody.payload?.text ?? '';

                  if (!webhookUrl.startsWith('https://chat.googleapis.com/')) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ok: false, error: 'Invalid Google Chat webhook URL' }));
                    return;
                  }

                  if (!text.trim()) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ok: false, error: 'Missing message text' }));
                    return;
                  }

                  const response = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ text }),
                  });
                  const responseBody = await response.text();

                  res.statusCode = response.ok ? 200 : response.status;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({
                    ok: response.ok,
                    status: response.status,
                    statusText: response.statusText,
                    error: response.ok ? undefined : responseBody,
                  }));
                } catch (error) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }));
                }
              })();
            });
          });
        },
      },
    ],
    define: {
      'import.meta.env.OPENAI_MODEL': JSON.stringify(env.OPENAI_MODEL ?? ''),
      'import.meta.env.LLM_PROVIDER': JSON.stringify(env.LLM_PROVIDER ?? ''),
    },
  };
});
