// Test-only preload: fake provider responses; never contact a real AI provider.
if (process.env.NODE_ENV !== 'test') throw new Error('AI fetch fixture requires NODE_ENV=test');
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  if (parsed.hostname !== 'provider.example') throw new Error('External fetch blocked by test fixture');
  if (parsed.pathname.endsWith('/models')) {
    if (parsed.pathname.includes('unsupported')) return new Response('No models API', { status: 404 });
    if (options.headers?.Authorization !== 'Bearer sk-fake-model-test-12345') return new Response('Denied', { status: 401 });
    return Response.json({ data: [{ id: 'chat-alpha' }, { id: 'vision-beta' }, { id: 'chat-alpha' }] });
  }
  if (parsed.pathname.endsWith('/chat/completions')) {
    const body = JSON.parse(options.body);
    if (body.model === 'denied-model') return new Response('secret upstream error', { status: 403 });
    if (body.model === 'invalid-response') return Response.json({ model: body.model });
    return Response.json({ model: body.model, choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }
  throw new Error('Unexpected fake provider path');
};
