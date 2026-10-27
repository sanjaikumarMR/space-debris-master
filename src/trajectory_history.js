import { getTleEpoch } from './satellite_util.js';

const HISTORY_PREFIX = 'space-debris-tle-history-';
export const LSTM_MINIMUM_HISTORY = 30;
const MAX_HISTORY_PER_OBJECT = 100;

export function getTleHistoryFingerprint(observations) {
    let hash = 2166136261;
    const sorted = [...observations].sort((left, right) => getTleEpoch(left) - getTleEpoch(right));
    for (const observation of sorted) {
        const value = `${observation.tleLine1}\n${observation.tleLine2}\n`;
        for (let index = 0; index < value.length; index++) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
    }
    return (hash >>> 0).toString(16);
}

export function parseTleHistory(tleText) {
    const lines = tleText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const observations = [];
    let name = '';

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].startsWith('0 ') ? lines[index].slice(2).trim() : lines[index];
        if (!line.startsWith('1 ')) {
            name = line;
            continue;
        }
        const tleLine2 = lines[index + 1];
        if (!tleLine2 || !tleLine2.startsWith('2 ') || line.slice(2, 7) !== tleLine2.slice(2, 7)) {
            continue;
        }
        observations.push({
            name: name || `NORAD ${line.slice(2, 7)}`,
            tleLine1: line,
            tleLine2,
        });
        name = '';
        index++;
    }

    return observations;
}

export function getTleHistory(catalogId) {
    try {
        const serialized = localStorage.getItem(`${HISTORY_PREFIX}${catalogId}`);
        if (!serialized) return { observations: [], error: null };
        const observations = JSON.parse(serialized);
        if (!Array.isArray(observations) || observations.some(observation =>
            !observation ||
            typeof observation.tleLine1 !== 'string' ||
            typeof observation.tleLine2 !== 'string'
        )) {
            throw new Error('Saved trajectory history contains invalid TLE snapshots.');
        }
        return { observations, error: null };
    } catch (error) {
        console.warn(`Could not read TLE history for NORAD ${catalogId}:`, error);
        return { observations: [], error: error.message };
    }
}

export function archiveTleObservation(station, observedAt = Date.now()) {
    if (!station || typeof station.tleLine1 !== 'string' || typeof station.tleLine2 !== 'string') {
        return { count: 0, added: false, error: 'The selected object has no valid TLE lines to archive.' };
    }
    const catalogId = station.tleLine1.slice(2, 7);
    const epoch = getTleEpoch(station);
    if (!epoch) {
        return { count: 0, added: false, error: 'The TLE has an invalid epoch and was not archived.' };
    }

    return archiveTleObservations(catalogId, [station], observedAt);
}

export function archiveTleObservations(catalogId, stations, observedAt = Date.now()) {
    const history = getTleHistory(catalogId);
    if (history.error) {
        return { count: history.observations.length, added: false, error: history.error };
    }

    const knownTles = new Set(history.observations.map(observation =>
        `${observation.tleLine1}\n${observation.tleLine2}`
    ));
    const incoming = [];
    for (const station of stations) {
        if (!station || typeof station.tleLine1 !== 'string' || typeof station.tleLine2 !== 'string') continue;
        if (station.tleLine1.slice(2, 7) !== catalogId || !getTleEpoch(station)) continue;
        const key = `${station.tleLine1}\n${station.tleLine2}`;
        if (knownTles.has(key)) continue;
        knownTles.add(key);
        incoming.push({
            name: station.name || `NORAD ${catalogId}`,
            tleLine1: station.tleLine1,
            tleLine2: station.tleLine2,
            epoch: getTleEpoch(station).toISOString(),
            observedAt,
        });
    }

    const observations = [
        ...history.observations,
        ...incoming,
    ].sort((left, right) => new Date(left.epoch) - new Date(right.epoch))
        .slice(-MAX_HISTORY_PER_OBJECT);

    if (!incoming.length) {
        return { count: observations.length, added: false, error: null };
    }

    try {
        localStorage.setItem(`${HISTORY_PREFIX}${catalogId}`, JSON.stringify(observations));
        return { count: observations.length, added: true, error: null };
    } catch (error) {
        console.warn(`Could not save TLE history for NORAD ${catalogId}:`, error);
        return { count: history.observations.length, added: false, error: error.message };
    }
}
