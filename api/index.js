import { handleAppRequest } from '../server.js';

export default function handler(req, res) {
  return handleAppRequest(req, res);
}

