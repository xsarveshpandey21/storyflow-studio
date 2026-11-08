export default function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify({
    hasKey: Boolean(process.env.GEMINI_API_KEY)
  }));
}
