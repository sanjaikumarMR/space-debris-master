import * as satellite from 'satellite.js/lib/index';
import { SCALE_RATIO } from './constants.js';

export const parseStationsFromFile = (url) => {
    var request = new XMLHttpRequest();
    request.withCredentials = false;
    request.open('GET', url, false);  // `false` makes the request synchronous
    //request.open('GET', url, true);  // `false` makes the request synchronous
    request.send(null);
    const station_names = [];
    const stations = [];
    if (request.status === 200) {
        var fileContent = request.responseText;
        const lines = fileContent.split("\n");
        let station = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.length === 0) continue;
            if (line[0] === '1') {
                station.tleLine1 = line;
            } else if (line[0] === '2') {
                station.tleLine2 = line;
            } else {
                if (station_names.indexOf(line) != -1) {
                    continue;
                }
                if (station) 
                    stations.push(station);
                station = { 
                    name: line
                };
                station_names.push(line);
            }
        }
        stations.push(station);
    }
    return stations;
}

export const getScaledCoordinates = (v) => {
    let coords = [v.y, v.z, v.x];
    for (let i = 0; i < coords.length; i++) {
        coords[i] *= SCALE_RATIO;
    } 
    return coords;
}

export const getTleEpoch = (station) => {
    const yearInCentury = Number(station.tleLine1.slice(18, 20));
    const dayOfYear = Number(station.tleLine1.slice(20, 32));
    if (!Number.isFinite(yearInCentury) || !Number.isFinite(dayOfYear) || dayOfYear < 1 || dayOfYear >= 367) {
        return null;
    }
    const year = yearInCentury < 57 ? 2000 + yearInCentury : 1900 + yearInCentury;
    return new Date(Date.UTC(year, 0, 1) + (dayOfYear - 1) * 24 * 60 * 60 * 1000);
}

export const getStationState = (station, date) => {
    if (!station.satrec) station.satrec = satellite.twoline2satrec(station.tleLine1, station.tleLine2);
    const positionAndVelocity = satellite.propagate(station.satrec, date);
    if (station.satrec.error > 0 || !positionAndVelocity.position || !positionAndVelocity.velocity) {
        return null;
    }
    const gmst = satellite.gstime(date);
    const geodeticProperties = satellite.eciToGeodetic(positionAndVelocity.position, gmst);
    const position = getScaledCoordinates(satellite.eciToEcf(positionAndVelocity.position, gmst));
    const velocity = Math.sqrt(
        Math.pow(positionAndVelocity.velocity.x, 2) +
        Math.pow(positionAndVelocity.velocity.y, 2) +
        Math.pow(positionAndVelocity.velocity.z, 2)
    );

    if (![...position, geodeticProperties.height, geodeticProperties.latitude, geodeticProperties.longitude, velocity].every(Number.isFinite)) {
        return null;
    }

    return {
        position,
        eciPosition: positionAndVelocity.position,
        eciVelocity: positionAndVelocity.velocity,
        geodeticProperties,
        velocity,
    };
}

export const getStationRenderPosition = (station, date) => {
    if (!station.satrec) station.satrec = satellite.twoline2satrec(station.tleLine1, station.tleLine2);
    const propagated = satellite.propagate(station.satrec, date);
    if (station.satrec.error > 0 || !propagated.position) {
        return [0, 0, 0];
    }
    const gmst = satellite.gstime(date);
    return getScaledCoordinates(satellite.eciToEcf(propagated.position, gmst));
}

export const getStationPosition = (station, date) => {
    const state = getStationState(station, date);
    if (!state) {
        station.geodeticProperties = {height: 0, latitude: 0, longitude: 0};
        station.velocity = 0;
        return [0, 0, 0];
    }
    station.geodeticProperties = state.geodeticProperties;
    station.velocity = state.velocity;
    return state.position;
}
