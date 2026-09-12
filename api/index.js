import app from '../src/server.js';

// Vercel invokes this function under the /api prefix. The Express app exposes
// its routes at the root (/auth/login, /dashboard, etc.), so remove that
// deployment-only prefix before handing the request to Express.
const withoutApiPrefix = (url = '/') => {
  const queryIndex = url.indexOf('?');
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : url.slice(queryIndex);
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return `${pathname.slice(4) || '/'}${query}`;
  }
  return url || '/';
};

export default function handler(req, res) {
  req.url = withoutApiPrefix(req.url);
  return app(req, res);
}
