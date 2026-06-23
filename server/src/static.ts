import fs from 'node:fs';
import path from 'node:path';

const clientDist = path.resolve(process.cwd(), '../client/dist');

export function serveStatic(urlPath: string) {
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(clientDist, safePath);

  if (!filePath.startsWith(clientDist)) {
    return null;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === '.js'
        ? 'text/javascript'
        : ext === '.css'
        ? 'text/css'
        : ext === '.svg'
        ? 'image/svg+xml'
        : ext === '.json'
        ? 'application/json'
        : 'text/html';
    return { filePath, contentType: type };
  }

  const indexPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(indexPath)) {
    return { filePath: indexPath, contentType: 'text/html' };
  }

  return null;
}
