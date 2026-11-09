export default function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify({
    ok: true,
    service: 'StoryFlow Studio API',
    endpoints: ['/api/health', '/api/config', '/api/has-key', '/api/tts', '/api/generate-meta']
  }));
}
