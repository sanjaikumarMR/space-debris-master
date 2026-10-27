import { getTleEpoch } from './satellite_util.js';
import { parseTleCatalog } from './satellite_registry.js';

const LIVE_TLE_GROUPS = [
    'active',
    'analyst',
    'iridium-33-debris',
    'cosmos-2251-debris',
    'fengyun-1c-debris',
];
const REQUEST_TIMEOUT_MS = 20000;
const CACHE_PREFIX = 'space-debris-live-tle-';
const RETRY_PREFIX = 'space-debris-live-tle-retry-';
const REFRESH_LIMIT_MS = 2 * 60 * 60 * 1000;

async function fetchSpaceTrackCatalog(selectedCatalogId) {
    const url = new URL('/api/spacetrack/debris', window.location.origin);
    if (selectedCatalogId && /^\d{1,9}$/.test(selectedCatalogId)) {
        url.searchParams.set('noradId', selectedCatalogId);
    }
    let response;
    try {
        response = await fetch(url, {
            headers: { Accept: 'text/plain' },
        });
    } catch (error) {
        throw new Error(`Could not reach the local Space-Track API (${error.message}). Stop the old development server and restart it with "npm run dev".`);
    }
    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('The running development server has no Space-Track API route. Stop it with Ctrl+C, run "npm run dev" again, and open the localhost URL it prints.');
        }
        let message = `Space-Track returned HTTP ${response.status}.`;
        try {
            const details = JSON.parse(await response.text());
            if (typeof details.error === 'string') message = details.error;
        } catch {
            // A missing API route may return an HTML 404 page instead of JSON.
        }
        throw new Error(message);
    }

    const text = await response.text();
    return {
        stations: parseTleCatalog(text),
        updatedGroups: ['Space-Track debris'],
        cachedGroups: [],
        uncachedGroups: [],
        errors: [],
    };
}

export async function fetchSpaceTrackTleHistory(catalogId) {
    if (!/^\d{1,9}$/.test(catalogId)) {
        throw new Error('Select an object with a valid NORAD catalog ID before importing history.');
    }
    const url = new URL('/api/spacetrack/history', window.location.origin);
    url.searchParams.set('noradId', catalogId);
    let response;
    try {
        response = await fetch(url, { headers: { Accept: 'text/plain' } });
    } catch (error) {
        throw new Error(`Could not reach the local Space-Track API (${error.message}). Restart the development server with "npm run dev".`);
    }
    if (!response.ok) {
        let message = `Space-Track history returned HTTP ${response.status}.`;
        try {
            const details = JSON.parse(await response.text());
            if (typeof details.error === 'string') message = details.error;
        } catch {
            // The server can return an HTML error page when its history route is unavailable.
        }
        throw new Error(message);
    }
    return response.text();
}

export async function fetchCurrentTle(catalogId) {
    if (!/^\d{1,9}$/.test(catalogId)) {
        throw new Error('A valid NORAD catalog ID is required to fetch the current TLE.');
    }

    let spaceTrackError;
    try {
        const url = new URL('/api/spacetrack/current', window.location.origin);
        url.searchParams.set('noradId', catalogId);
        const response = await fetch(url, {
            headers: { Accept: 'text/plain' },
            cache: 'no-store',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
            const details = await response.json().catch(() => ({}));
            throw new Error(details.error || `Space-Track current-TLE request returned HTTP ${response.status}.`);
        }
        const stations = parseTleCatalog(await response.text())
            .filter(station => station.tleLine1.slice(2, 7) === catalogId);
        const latest = stations.sort((left, right) =>
            (getTleEpoch(right)?.getTime() || 0) - (getTleEpoch(left)?.getTime() || 0)
        )[0];
        if (!latest) throw new Error(`Space-Track returned no TLE for NORAD ${catalogId}.`);
        return latest;
    } catch (error) {
        spaceTrackError = error;
    }

    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${encodeURIComponent(catalogId)}&FORMAT=tle`;
    const response = await fetch(url, {
        headers: { Accept: 'text/plain' },
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(error => {
        throw new Error(`Could not fetch a current TLE from Space-Track (${spaceTrackError.message}) or CelesTrak (${error.message}).`);
    });
    if (!response.ok) {
        throw new Error(`Could not fetch a current TLE from Space-Track (${spaceTrackError.message}) or CelesTrak (HTTP ${response.status}).`);
    }
    const stations = parseTleCatalog(await response.text())
        .filter(station => station.tleLine1.slice(2, 7) === catalogId);
    const latest = stations.sort((left, right) =>
        (getTleEpoch(right)?.getTime() || 0) - (getTleEpoch(left)?.getTime() || 0)
    )[0];
    if (!latest) {
        throw new Error(`Neither Space-Track nor CelesTrak returned a TLE for NORAD ${catalogId}.`);
    }
    return latest;
}

function readCachedGroup(group) {
    try {
        const saved = localStorage.getItem(`${CACHE_PREFIX}${group}`);
        if (!saved) return null;
        const cached = JSON.parse(saved);
        if (typeof cached.text !== 'string' || !Number.isFinite(cached.savedAt)) return null;
        return cached;
    } catch (error) {
        console.warn(`Could not read the cached CelesTrak "${group}" catalog:`, error);
        return null;
    }
}

function saveCachedGroup(group, text) {
    try {
        localStorage.setItem(`${CACHE_PREFIX}${group}`, JSON.stringify({
            savedAt: Date.now(),
            text,
        }));
        localStorage.removeItem(`${RETRY_PREFIX}${group}`);
        return true;
    } catch (error) {
        console.warn(`Could not cache the CelesTrak "${group}" catalog:`, error);
        return false;
    }
}

function readRetryAfter(group) {
    try {
        const retryAfter = Number(localStorage.getItem(`${RETRY_PREFIX}${group}`));
        return Number.isFinite(retryAfter) && retryAfter > Date.now() ? retryAfter : null;
    } catch (error) {
        console.warn(`Could not read the CelesTrak "${group}" retry time:`, error);
        return null;
    }
}

function saveRetryAfter(group, retryAfter) {
    try {
        localStorage.setItem(`${RETRY_PREFIX}${group}`, String(retryAfter));
    } catch (error) {
        console.warn(`Could not save the CelesTrak "${group}" retry time:`, error);
    }
}

function rateLimitRetryAfter(responseText) {
    const match = responseText.match(/at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC/i);
    if (match) {
        const downloadedAt = new Date(`${match[1].replace(' ', 'T').replace(' ', ':')}Z`);
        if (Number.isFinite(downloadedAt.getTime())) {
            return downloadedAt.getTime() + REFRESH_LIMIT_MS;
        }
    }
    return Date.now() + REFRESH_LIMIT_MS;
}

export async function fetchLiveDebrisCatalog(selectedCatalogId) {
    let spaceTrackError;
    try {
        return await fetchSpaceTrackCatalog(selectedCatalogId);
    } catch (error) {
        spaceTrackError = error;
    }

    const requests = LIVE_TLE_GROUPS.map(async group => {
        const cached = readCachedGroup(group);
        const retryAfter = readRetryAfter(group);
        if (retryAfter) {
            if (cached) return { group, text: cached.text, isCached: true, isSaved: true };
            throw new Error(`CelesTrak limits "${group}" downloads to once every 2 hours. Try again after ${new Date(retryAfter).toLocaleTimeString()}.`);
        }

        if (cached && Date.now() - cached.savedAt < REFRESH_LIMIT_MS) {
            return { group, text: cached.text, isCached: true, isSaved: true };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { Accept: 'text/plain' },
            });
            if (!response.ok) {
                const responseText = await response.text();
                const normalizedResponse = responseText.replace(/\s+/g, ' ');
                if (response.status === 403) {
                    const retryAfter = rateLimitRetryAfter(responseText);
                    saveRetryAfter(group, retryAfter);
                    if (cached) return { group, text: cached.text, isCached: true, isSaved: true };
                    const reason = normalizedResponse.includes('has not updated since your last successful download')
                        ? 'CelesTrak limits downloads to once every 2 hours.'
                        : 'CelesTrak denied this request (HTTP 403); retry is delayed to avoid repeated blocked requests.';
                    throw new Error(`${reason} Try "${group}" again after ${new Date(retryAfter).toLocaleTimeString()}; this group has no local copy.`);
                }
                throw new Error(`CelesTrak group "${group}" returned HTTP ${response.status}.`);
            }
            const text = await response.text();
            return { group, text, isCached: false, isSaved: saveCachedGroup(group, text) };
        } finally {
            clearTimeout(timeout);
        }
    });
    const results = await Promise.allSettled(requests);
    const catalogs = [];
    const errors = [];
    for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result.status === 'fulfilled') {
            catalogs.push(result.value);
        } else {
            errors.push({ group: LIVE_TLE_GROUPS[index], message: result.reason.message });
        }
    }
    errors.unshift({
        group: 'Space-Track',
        message: spaceTrackError.message,
    });

    let stations = [];
    if (catalogs.length > 0) {
        stations = parseTleCatalog(catalogs.map(catalog => catalog.text).join('\n'));
    }
    return {
        stations,
        updatedGroups: catalogs.filter(catalog => !catalog.isCached).map(catalog => catalog.group),
        cachedGroups: catalogs.filter(catalog => catalog.isCached).map(catalog => catalog.group),
        uncachedGroups: catalogs.filter(catalog => !catalog.isSaved).map(catalog => catalog.group),
        errors,
    };
}
