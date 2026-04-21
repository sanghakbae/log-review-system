const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type GoogleChatWebhookPayload = {
  text?: string;
};

type RelayRequestBody = {
  webhookUrl?: string;
  webhookUrls?: string[];
  payload?: GoogleChatWebhookPayload;
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });

const isGoogleChatWebhookUrl = (url: string) => {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'https:' && parsedUrl.hostname === 'chat.googleapis.com';
  } catch {
    return false;
  }
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  let body: RelayRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const text = body.payload?.text?.trim() ?? '';
  if (!text) {
    return jsonResponse({ ok: false, error: 'Missing message text' }, 400);
  }

  const webhookUrls = Array.from(
    new Set([body.webhookUrl, ...(body.webhookUrls ?? [])].filter((url): url is string => Boolean(url?.trim()))),
  );

  if (webhookUrls.length === 0) {
    return jsonResponse({ ok: false, error: 'Missing webhook URL' }, 400);
  }

  const invalidUrls = webhookUrls.filter((url) => !isGoogleChatWebhookUrl(url));
  if (invalidUrls.length > 0) {
    return jsonResponse({ ok: false, error: 'Invalid Google Chat webhook URL' }, 400);
  }

  const results = await Promise.all(
    webhookUrls.map(async (webhookUrl) => {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text }),
        });

        return {
          ok: response.ok,
          status: response.status,
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }),
  );

  const ok = results.every((result) => result.ok);
  return jsonResponse({ ok, results }, ok ? 200 : 502);
});
