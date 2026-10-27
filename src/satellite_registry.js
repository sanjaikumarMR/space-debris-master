import { getTleEpoch, parseStationsFromFile } from "./satellite_util";

const bundledStations = [
    ...parseStationsFromFile('data/starlink.txt'),
	...parseStationsFromFile('data/2019-006.txt'),
	...parseStationsFromFile('data/iridium-33-debris.txt'),
    ...parseStationsFromFile('data/1999-025.txt'),
    ...parseStationsFromFile('data/stations.txt'),
    ...parseStationsFromFile('data/tle-new.txt'),
    ...parseStationsFromFile('data/visual.txt'),
    ...parseStationsFromFile('data/active.txt'),
    ...parseStationsFromFile('data/analyst.txt'),
];

function getLatestCatalogStations(stations) {
    const stationsByCatalogId = new Map();
    for (const station of stations) {
        const catalogId = station.tleLine1.slice(2, 7);
        const current = stationsByCatalogId.get(catalogId);
        const currentEpoch = current ? getTleEpoch(current) : null;
        const incomingEpoch = getTleEpoch(station);
        if (!current || (incomingEpoch && (!currentEpoch || incomingEpoch > currentEpoch))) {
            stationsByCatalogId.set(catalogId, station);
        }
    }

    return [...stationsByCatalogId.values()]
        .sort((left, right) => (getTleEpoch(right)?.getTime() || 0) - (getTleEpoch(left)?.getTime() || 0));
}

export const debris = getLatestCatalogStations(bundledStations);

export function parseTleCatalog(tleText) {
    const lines = tleText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const stations = [];
    const seenCatalogIds = new Set();
    let name = '';

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].startsWith('0 ') ? lines[index].slice(2).trim() : lines[index];
        if (!line.startsWith('1 ')) {
            name = line;
            continue;
        }

        const tleLine1 = line;
        const tleLine2 = lines[index + 1];
        if (!tleLine2 || !tleLine2.startsWith('2 ') || tleLine1.slice(2, 7) !== tleLine2.slice(2, 7)) {
            continue;
        }

        const catalogId = tleLine1.slice(2, 7);
        if (!seenCatalogIds.has(catalogId)) {
            seenCatalogIds.add(catalogId);
            stations.push({
                name: name || `NORAD ${catalogId}`,
                tleLine1,
                tleLine2,
            });
        }
        name = '';
        index++;
    }

    if (stations.length === 0) {
        throw new Error('The live feed did not contain any valid TLE records.');
    }

    return stations;
}

export function replaceDebrisCatalog(stations) {
    if (stations.length === 0) {
        throw new Error('Refusing to replace the debris catalog with an empty feed.');
    }

    const mergedStations = getLatestCatalogStations([...debris, ...stations]);
    debris.length = 0;
    debris.push(...mergedStations);
}
