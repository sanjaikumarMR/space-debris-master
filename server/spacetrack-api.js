const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const SPACE_TRACK_URL = 'https://www.space-track.org';
const REQUEST_TIMEOUT_MS = 20000;

function loadLocalCredentials() {
    const localEnvironmentPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(localEnvironmentPath)) return;

    const contents = fs.readFileSync(localEnvironmentPath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
        const match = line.match(/^\s*(SPACETRACK_IDENTITY|SPACETRACK_PASSWORD|GOOGLE_MAPS_API_KEY|GOOGLE_MAPS_EMBED_KEY|GOOGLE_MAPS_TILES_KEY|GEMINI_API_KEY)\s*=\s*(.*?)\s*$/);
        if (!match || process.env[match[1]]) continue;

        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[match[1]] = value;
    }
}

loadLocalCredentials();

function response(res, statusCode, body, contentType = 'application/json; charset=utf-8') {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
}

function getCookieHeader(headers) {
    const getSetCookie = headers.getSetCookie;
    const rawCookies = typeof getSetCookie === 'function'
        ? getSetCookie.call(headers)
        : [headers.get('set-cookie')].filter(Boolean);

    return rawCookies
        .flatMap(cookie => cookie.split(/,(?=\s*[^;,=\s]+=)/))
        .map(cookie => cookie.split(';', 1)[0].trim())
        .filter(Boolean)
        .join('; ');
}

async function getSpaceTrackCookie() {
    const identity = process.env.SPACETRACK_IDENTITY;
    const password = process.env.SPACETRACK_PASSWORD;
    if (!identity || !password) {
        const error = new Error('Space-Track credentials are not configured. Set SPACETRACK_IDENTITY and SPACETRACK_PASSWORD in the ignored .env.local file or process environment, then restart the server.');
        error.statusCode = 503;
        throw error;
    }

    const login = await fetch(`${SPACE_TRACK_URL}/ajaxauth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ identity, password }),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const cookie = getCookieHeader(login.headers);
    if (!cookie) {
        throw new Error('Space-Track login failed. Check the server credentials and account access.');
    }
    return cookie;
}

async function fetchSpaceTrackTle(selectedNoradId) {
    const cookie = await getSpaceTrackCookie();
    const catalogPath = '/basicspacedata/query/class/gp/OBJECT_TYPE/DEBRIS/orderby/EPOCH%20desc/format/tle';
    const catalogRequest = fetch(`${SPACE_TRACK_URL}${catalogPath}`, {
        headers: { Cookie: cookie, Accept: 'text/plain' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const selectedRequest = selectedNoradId
        ? fetch(`${SPACE_TRACK_URL}/basicspacedata/query/class/gp/NORAD_CAT_ID/${selectedNoradId}/format/tle`, {
            headers: { Cookie: cookie, Accept: 'text/plain' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        : null;
    const [catalog, selectedObject] = await Promise.all([
        catalogRequest,
        selectedRequest,
    ]);
    if (!catalog.ok) {
        throw new Error(`Space-Track catalog request returned HTTP ${catalog.status}.`);
    }
    if (selectedObject && !selectedObject.ok) {
        throw new Error(`Space-Track selected-object request returned HTTP ${selectedObject.status}.`);
    }

    const tleText = `${selectedObject ? await selectedObject.text() : ''}\n${await catalog.text()}`;
    if (!tleText.trim()) {
        throw new Error('Space-Track returned an empty catalog.');
    }
    return tleText;
}

async function fetchSpaceTrackHistory(noradId) {
    const cookie = await getSpaceTrackCookie();
    const historyPath = `/basicspacedata/query/class/gp_history/NORAD_CAT_ID/${noradId}/orderby/EPOCH%20desc/limit/100/format/tle`;
    const history = await fetch(`${SPACE_TRACK_URL}${historyPath}`, {
        headers: { Cookie: cookie, Accept: 'text/plain' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!history.ok) {
        throw new Error(`Space-Track history request returned HTTP ${history.status}.`);
    }
    const tleText = await history.text();
    if (!tleText.trim()) {
        throw new Error(`Space-Track returned no historical TLE records for NORAD ${noradId}.`);
    }
    return tleText;
}

async function fetchSpaceTrackCurrentTle(noradId) {
    const cookie = await getSpaceTrackCookie();
    const currentPath = `/basicspacedata/query/class/gp/NORAD_CAT_ID/${noradId}/orderby/EPOCH%20desc/limit/1/format/tle`;
    const response = await fetch(`${SPACE_TRACK_URL}${currentPath}`, {
        headers: { Cookie: cookie, Accept: 'text/plain' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Space-Track current-TLE request returned HTTP ${response.status}.`);
    }
    const tleText = await response.text();
    if (!tleText.trim()) {
        throw new Error(`Space-Track returned no current TLE for NORAD ${noradId}.`);
    }
    return tleText;
}

async function handleSpaceTrackRequest(req, res) {
    if (req.method !== 'GET') {
        response(res, 405, JSON.stringify({ error: 'Use GET to request the debris catalog.' }));
        return;
    }

    try {
        const requestUrl = new URL(req.url, 'http://localhost');
        const requestedId = requestUrl.searchParams.get('noradId');
        if (requestUrl.pathname.endsWith('/current')) {
            if (!requestedId || !/^\d{1,9}$/.test(requestedId)) {
                response(res, 400, JSON.stringify({ error: 'A valid noradId is required for current TLE lookup.' }));
                return;
            }
            const currentTle = await fetchSpaceTrackCurrentTle(requestedId);
            response(res, 200, currentTle, 'text/plain; charset=utf-8');
            return;
        }
        if (requestUrl.pathname.endsWith('/history')) {
            if (!requestedId || !/^\d{1,9}$/.test(requestedId)) {
                response(res, 400, JSON.stringify({ error: 'A valid noradId is required for history import.' }));
                return;
            }
            const historyText = await fetchSpaceTrackHistory(requestedId);
            response(res, 200, historyText, 'text/plain; charset=utf-8');
            return;
        }
        const selectedNoradId = requestedId && /^\d{1,9}$/.test(requestedId) ? requestedId : null;
        const tleText = await fetchSpaceTrackTle(selectedNoradId);
        response(res, 200, tleText, 'text/plain; charset=utf-8');
    } catch (error) {
        const statusCode = error.statusCode || 502;
        response(res, statusCode, JSON.stringify({ error: error.message }));
    }
}

module.exports = { handleSpaceTrackRequest };

if (require.main === module) {
    const port = Number(process.env.API_PORT || 3001);
    http.createServer(handleSpaceTrackRequest).listen(port, '127.0.0.1', () => {
        console.log(`Space-Track API proxy listening on http://127.0.0.1:${port}`);
    });
}
