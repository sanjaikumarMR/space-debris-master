const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { handleSpaceTrackRequest } = require('./spacetrack-api.js');
const { handleImpactAssessmentRequest } = require('./impact-assessment-api.js');

const distDirectory = path.resolve(__dirname, '..', 'dist');
const contentTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.svg', 'image/svg+xml'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
]);

function respond(res, status, message) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(message);
}

function serveStaticFile(req, res) {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (error) {
        respond(res, 400, 'Invalid URL path.');
        return;
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = path.resolve(distDirectory, relativePath);
    if (!filePath.startsWith(`${distDirectory}${path.sep}`)) {
        respond(res, 403, 'Forbidden.');
        return;
    }
    fs.stat(filePath, (error, stats) => {
        if (error || !stats.isFile()) {
            respond(res, 404, 'Not found.');
            return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', contentTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        fs.createReadStream(filePath).pipe(res);
    });
}

const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('ok');
        return;
    }
    if (req.url.startsWith('/api/spacetrack')) {
        handleSpaceTrackRequest(req, res);
        return;
    }
    if (req.url.startsWith('/api/impact')) {
        req.url = req.url.slice('/api/impact'.length) || '/';
        handleImpactAssessmentRequest(req, res);
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        respond(res, 405, 'Method not allowed.');
        return;
    }
    serveStaticFile(req, res);
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => {
    console.log(`Space Debris Prediction server listening on port ${port}`);
});
