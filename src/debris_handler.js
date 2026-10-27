import * as TWEEN from "@tweenjs/tween.js";
import { degreesLat, degreesLong } from 'satellite.js/lib/index';
import * as THREE from 'three';
import { draw } from './debris.js';
import { predict_eol } from './predict_eol.js';
import { debris } from './satellite_registry.js';
import {
    getScaledCoordinates,
    getStationPosition,
    getStationRenderPosition,
    getTleEpoch,
} from './satellite_util.js';
import {
    estimateBayesianTleState,
    predictBayesianTrajectory,
    predictOrbit,
    simulateHypotheticalBreakup,
    findClosestApproach,
    simulateImmediateDeorbit,
} from './orbit_prediction.js';
import {
    archiveTleObservations,
    getTleHistory,
    getTleHistoryFingerprint,
    LSTM_MINIMUM_HISTORY,
    parseTleHistory,
} from './trajectory_history.js';
import { fetchCurrentTle, fetchSpaceTrackTleHistory } from './live_tle.js';
import { getLstmModelMetadata, predictLstmState, saveLstmModelMetadata } from './lstm_prediction.js';
import {
    addGoogleEarthFootprint,
    addGoogleEarthMarker,
    addGoogleEarthTrajectory,
    clearGoogleEarthOverlays,
    focusGoogleEarthPosition,
    addGoogleEarthPlaceMarker,
    moveGoogleEarthMarker,
    requestGoogleEarthRender,
    updateGoogleEarthSelectedObject,
    setGoogleEarthSatellitesVisible,
    updateGoogleEarthSatellite,
} from './google_earth.js';
import { camera, date, scene } from './script.js';
import {
    getImpactRegion,
    getGroundedImpactSummary,
    getScenarioEnvelopeRadiusKm,
    lookupSatelliteMass,
} from './impact_assessment.js';
import { REAL_EARTH_RADIUS } from './constants.js';
//import { degreesLong, degreesLat } from 'satellite.js';
 
const debris_size = 0.2;

// I am assuming I will have a point (vec3) and some kind of identifier, they should be one to one
// Each would be in this order debris = [ [debris_id, x, y, z] ]

let debris_texture;
let debris_points = null;
let selected_debris_id = null;
let trajectory_line = null;
let fragment_trajectory_lines = [];
let fragment_markers = [];
let impact_marker = null;
let hovered_debris_id = null;
let pending_mouse_event = null;
let mouse_move_scheduled = false;
let position_task_id = 0;
let focused_simulation = false;
let google_earth_active = false;
let animation_frame_id = null;
let scenario_marker = null;
let impact_footprint_line = null;
let scenario_run_id = 0;

const POSITION_BATCH_SIZE = 250;

function yieldToBrowser() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

const info_element = document.getElementById('debris-info');
const prediction_button = document.getElementById('predict-trajectory');
const scenario_mode = document.getElementById('scenario-mode');
const prediction_status = document.getElementById('prediction-status');
const estimation_status = document.getElementById('estimation-status');
const close_simulation_button = document.getElementById('close-simulation');
const debris_search = document.getElementById('debris-search');
const debris_search_button = document.getElementById('debris-search-button');
const debris_search_status = document.getElementById('debris-search-status');
const impact_data_status = document.getElementById('impact-data-status');
const ai_impact_summary = document.getElementById('ai-impact-summary');
const object_details_status = document.getElementById('object-details-status');
const object_details_summary = document.getElementById('object-details-summary');
const object_details_sources = document.getElementById('object-details-sources');
const object_map = document.getElementById('object-map');
const object_map_status = document.getElementById('object-map-status');
const object_earth_link = document.getElementById('object-earth-link');
const lstm_training_tasks = new Map();
const lstm_last_attempts = new Map();
const lstm_last_attempt_fingerprints = new Map();
const lstm_background_errors = new Map();
let lstm_engine_timer = null;
let lstm_engine_catalog_id = null;
let lstm_engine_last_history_refresh = 0;
let lstm_engine_cycle_promise = null;
let lstm_engine_cycle_catalog_id = null;
const satellite_mass_tasks = new Map();
const satellite_mass_results = new Map();
const current_tle_tasks = new Map();
const LSTM_RETRY_DELAY_MS = 15 * 60 * 1000;
const LSTM_ENGINE_INTERVAL_MS = 15 * 60 * 1000;
const LSTM_HISTORY_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;

export function draw_debris(debris, texture) {
    debris_texture = texture;
    debris_points = draw(debris, texture, debris_size);
    return [debris_points];
}

export async function redrawDebris(date, preserveCatalogId = null) {
    if (debris_points) {
        scene.remove(debris_points);
        setGoogleEarthSatellitesVisible(false);
        debris_points.geometry.dispose();
        debris_points.material.dispose();
    }
    const positions = debris.map((_station, id) => [id, 0, 0, 0]);
    draw_debris(positions, debris_texture);
    scene.add(debris_points);

    selected_debris_id = null;
    hovered_debris_id = null;
    info_element.textContent = 'Live catalog loaded. Search for a debris object or double-click one on the globe.';
    prediction_button.disabled = true;
    prediction_status.textContent = '';
    debris_search_status.textContent = '';
    impact_data_status.textContent = 'Select an object to start public data lookup. Missing mass or population will be shown as unknown.';
    info_element.textContent = `Preparing orbit positions for all ${debris.length.toLocaleString()} catalog objects...`;
    await updateDebrisPositions(date);
    if (debris_points) {
        info_element.textContent = 'Live catalog loaded. Search for a debris object or double-click one on the globe.';
    }
    if (preserveCatalogId) {
        const preservedIndex = debris.findIndex(station => station.tleLine1.slice(2, 7) === preserveCatalogId);
        if (preservedIndex !== -1) selectDebris(preservedIndex);
    }
}

export function updateSimulationStatus(message) {
    document.getElementById('simulation-status').textContent = message;
}

export function setGoogleEarthActive(active) {
    google_earth_active = active;
    if (active) {
        document.body.classList.add('google-earth-active');
        updateDebrisPositions(date);
    } else {
        document.body.classList.remove('google-earth-active');
    }
}

export function getSelectedCatalogId() {
    if (selected_debris_id === null) return null;
    return debris[selected_debris_id].tleLine1.slice(2, 7);
}

export async function updateDebrisPositions(date) {
    if (!debris_points) return;
    const taskId = ++position_task_id;
    const positionAttribute = debris_points.geometry.getAttribute('position');
    for (let start = 0; start < debris.length; start += POSITION_BATCH_SIZE) {
        if (taskId !== position_task_id) return;
        const end = Math.min(start + POSITION_BATCH_SIZE, debris.length);
        for (let i = start; i < end; i++) {
            const position = getStationPosition(debris[i], date);
            positionAttribute.setXYZ(i, position[0], position[1], position[2]);
            if (google_earth_active) {
                const { latitude, longitude, height } = debris[i].geodeticProperties;
                updateGoogleEarthSatellite(i, latitude, longitude, height);
                if (i === selected_debris_id) {
                    updateGoogleEarthSelectedObject(i, debris[i].name, latitude, longitude, height);
                }
            }
        }
        positionAttribute.needsUpdate = true;
        if (google_earth_active) requestGoogleEarthRender();
        if (end < debris.length) await yieldToBrowser();
    }
}
function get_name(id) {
    let to_text = `${debris[id].name}`
    return to_text;
}

function setImpactDataStatus(message, sources = []) {
    impact_data_status.replaceChildren(document.createTextNode(message));
    for (const source of sources) {
        const link = document.createElement('a');
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = ` ${source.label}`;
        impact_data_status.append(document.createTextNode(' '), link);
    }
}

function showGroundedImpactSummary(summary) {
    ai_impact_summary.replaceChildren(document.createTextNode(
        `${summary.model} evidence-grounded scenario summary\n\n${summary.text}`
    ));
    const sources = [
        summary.evidence && summary.evidence.object && summary.evidence.object.source
            ? { url: summary.evidence.object.source, label: 'Retrieved object record' }
            : null,
        ...(summary.evidence && summary.evidence.location && Array.isArray(summary.evidence.location.sources)
            ? summary.evidence.location.sources.map(source => ({ url: source.url, label: source.name }))
            : []),
    ].filter(source => source && /^https:\/\//.test(source.url));
    for (const source of sources) {
        const link = document.createElement('a');
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = source.label;
        ai_impact_summary.append(document.createElement('br'), link);
    }
}

function getInternationalDesignator(tleLine1) {
    const designator = tleLine1.slice(9, 17).trim();
    const match = designator.match(/^(\d{2})(\d{3})([A-Z0-9]{0,3})$/i);
    if (!match) return 'unknown';
    const year = Number(match[1]);
    const fullYear = year >= 57 ? 1900 + year : 2000 + year;
    return `${fullYear}-${match[2]}${match[3]}`;
}

function setEarthPosition(latitude, longitude) {
    const earthUrl = `https://earth.google.com/web/@${latitude},${longitude},2500000a,0d,35y,0h,0t,0r`;
    object_earth_link.href = earthUrl;
    object_earth_link.hidden = false;
}

function appendObjectSource(source) {
    if (!source || !/^https:\/\//.test(source.url)) return;
    const link = document.createElement('a');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.name;
    const note = document.createElement('span');
    note.textContent = source.scope ? ` — ${source.scope}` : '';
    object_details_sources.append(link, note, document.createElement('br'));
}

async function loadSelectedObjectProfile(selectedId, info) {
    const station = debris[selectedId];
    const catalogId = station.tleLine1.slice(2, 7).trim();
    const internationalDesignator = getInternationalDesignator(station.tleLine1);
    const query = new URLSearchParams({
        name: station.name,
        noradId: catalogId,
        internationalDesignator,
        lat: info.latitude.toString(),
        lon: info.longitude.toString(),
    });
    object_details_status.textContent = `Retrieving public information for ${station.name} (NORAD ${catalogId})…`;
    object_details_summary.textContent = '';
    object_details_sources.replaceChildren();
    object_map.removeAttribute('src');
    object_map.hidden = true;
    object_map_status.textContent = 'Looking up an optional Google Maps satellite view…';
    setEarthPosition(info.latitude, info.longitude);

    try {
        const response = await fetch(`/api/impact/object?${query}`, {
            headers: { Accept: 'application/json' },
        });
        const profile = await response.json();
        if (!response.ok) throw new Error(profile.error || `Object lookup returned HTTP ${response.status}.`);
        if (selected_debris_id !== selectedId) return;

        const identity = [
            `Catalog name: ${profile.selectedName}`,
            `NORAD ID: ${profile.noradId}`,
            `International designator: ${profile.internationalDesignator || 'unknown'}`,
        ];
        if (profile.satcat) {
            const satcatName = profile.satcat.OBJECT_NAME;
            if (satcatName) {
                identity.push(`CelesTrak SATCAT name: ${satcatName}`);
                const normalizedSatcatName = satcatName.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                const normalizedTleName = profile.selectedName.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                if (normalizedSatcatName !== normalizedTleName) {
                    identity.push(`Name discrepancy: the selected TLE says "${profile.selectedName}", but CelesTrak lists this NORAD ID as "${satcatName}". Check the linked catalog record before relying on the name.`);
                }
            }
            const satcatDetails = [
                ['Object type', profile.satcat.OBJECT_TYPE],
                ['Owner/source code', profile.satcat.OWNER],
                ['Launch date', profile.satcat.LAUNCH_DATE],
                ['Launch site', profile.satcat.LAUNCH_SITE],
                ['Orbit period (min)', profile.satcat.PERIOD],
                ['Inclination (deg)', profile.satcat.INCLINATION],
                ['Apogee (km)', profile.satcat.APOGEE],
                ['Perigee (km)', profile.satcat.PERIGEE],
            ].filter(([, value]) => value !== undefined && value !== null && value !== '');
            for (const [label, value] of satcatDetails) {
                identity.push(`${label}: ${value}`);
            }
        }
        if (profile.profile && profile.profile.description) {
            identity.push(
                `${profile.profile.familyLevel ? 'Related family record' : 'Matched public record'}: ${profile.profile.name} — ${profile.profile.description}.`
            );
            if (profile.profile.massKg) {
                identity.push(`Published record mass: ${profile.profile.massKg.toLocaleString()} kg; this is not a verified surviving fragment mass.`);
            }
            if (profile.profile.note) identity.push(profile.profile.note);
        } else {
            identity.push('No exact individual-object public record was found; do not infer object-specific mission details from a similar name.');
        }
        object_details_status.textContent = identity.join('\n');

        const displayedText = profile.aiSummary ||
            (profile.article ? `Related program/family reference: ${profile.article.extract}` : '');
        object_details_summary.textContent = displayedText || profile.aiSummaryNote ||
            'No supporting public article or AI summary was available for this catalog name.';
        for (const source of profile.sources || []) appendObjectSource(source);
        if (profile.aiSummaryNote) {
            const note = document.createElement('p');
            note.textContent = profile.aiSummaryNote;
            object_details_sources.append(note);
        }
        if (profile.note) {
            const note = document.createElement('p');
            note.textContent = profile.note;
            object_details_sources.append(note);
        }

        if (profile.map && profile.map.url) {
            object_map.src = profile.map.url;
            object_map.hidden = false;
            object_map_status.textContent = profile.map.note;
        } else {
            object_map_status.textContent = profile.map && profile.map.note
                ? `${profile.map.note} Google Earth opens the current position in a new tab; the in-app 3D globe remains the live TLE visualization.`
                : 'The 3D globe shows the live TLE-propagated position. Google Maps imagery is not live satellite video.';
        }
    } catch (error) {
        if (selected_debris_id !== selectedId) return;
        object_details_status.textContent = `Public object lookup unavailable: ${error.message}`;
        object_details_summary.textContent = 'The catalog name, NORAD ID, international designator, and live propagated position above remain available. No unsupported mission details have been inferred.';
        object_map_status.textContent = 'The 3D globe shows the TLE-propagated position. Google Earth can open the same coordinates in a new tab.';
    }
}

function startSatelliteMassLookup(selectedId) {
    const station = debris[selectedId];
    const catalogId = station.tleLine1.slice(2, 7);
    if (satellite_mass_results.has(catalogId)) {
        const result = satellite_mass_results.get(catalogId);
        const message = result.massKg
            ? `Catalog mass for ${result.matchedName}: ${result.massKg.toLocaleString(undefined, { maximumFractionDigits: 2 })} kg. This may not equal surviving fragment mass.`
            : `Catalog mass: UNKNOWN (${result.error})`;
        setImpactDataStatus(message, result.source
            ? [{ url: result.source, label: 'Wikidata source' }]
            : []);
        return Promise.resolve(result);
    }
    if (satellite_mass_tasks.has(catalogId)) {
        return satellite_mass_tasks.get(catalogId);
    }

    setImpactDataStatus(`Searching Wikidata for a mass record for ${station.name}...`);
    const task = lookupSatelliteMass(station.name)
        .then(result => {
            satellite_mass_results.set(catalogId, result);
            if (selected_debris_id === selectedId) {
                const massStatus = result.massKg
                    ? `Catalog mass for ${result.matchedName}: ${result.massKg.toLocaleString(undefined, { maximumFractionDigits: 2 })} kg. This may not equal surviving fragment mass.`
                    : `Catalog mass: UNKNOWN (${result.error})`;
                setImpactDataStatus(massStatus, result.source
                    ? [{ url: result.source, label: 'Wikidata source' }]
                    : []);
            }
            return result;
        })
        .finally(() => satellite_mass_tasks.delete(catalogId));
    satellite_mass_tasks.set(catalogId, task);
    return task;
}

function print_info(id) {
    selected_debris_id = id;
    renderSelectedInfo(id);
    prediction_button.disabled = false;
    prediction_status.textContent = 'Refreshing the selected object’s TLE in the background. You can run a scenario now; it will use the fresh TLE when available.';
    clearTrajectory();
    startSatelliteMassLookup(id);
    loadSelectedObjectProfile(id, get_info(id));
    startBackgroundLstmEngine(id);

    ensureCurrentTle(id).then(updatedId => {
        if (updatedId === null || selected_debris_id !== updatedId) return;
        updateEstimationStatus(debris[updatedId]);
        renderSelectedInfo(updatedId);
        loadSelectedObjectProfile(updatedId, get_info(updatedId));
    }).catch(error => {
        if (selected_debris_id === id) {
            info_element.textContent += `\nCurrent TLE unavailable: ${error.message} The scenario button remains available, but a scenario will require a fresh TLE.`;
            prediction_status.textContent = `Selected-object TLE refresh failed: ${error.message} You can retry by running a scenario.`;
        }
    });
}

function renderSelectedInfo(id) {
    getStationPosition(debris[id], date);
    const info = get_info(id);
    const epoch = getTleEpoch(debris[id]);
    const epochAgeDays = epoch ? Math.floor((date.getTime() - epoch.getTime()) / (24 * 60 * 60 * 1000)) : null;
    const staleDataWarning = epochAgeDays !== null && epochAgeDays > 30
        ? `\nWarning: this TLE is ${epochAgeDays} days old; predictions may be unreliable.`
        : '';
    updateEstimationStatus(debris[id]);
    info_element.textContent = `Selected: ${debris[id].name}
Altitude: ${info.height.toFixed(2)} km
Latitude: ${info.latitude.toFixed(3)} deg
Longitude: ${info.longitude.toFixed(3)} deg
Velocity: ${info.velocity.toFixed(4)} km/s
TLE epoch: ${epoch ? epoch.toISOString().slice(0, 10) : 'unknown'}
Estimated re-entry: ${predict_eol(info.height)}

Re-entry is a coarse altitude-based estimate.${staleDataWarning}`;
    prediction_status.textContent = '';
    debris_search_status.textContent = '';
}

function ensureCurrentTle(selectedId) {
    const selected = debris[selectedId];
    const catalogId = selected.tleLine1.slice(2, 7);
    if (current_tle_tasks.has(catalogId)) return current_tle_tasks.get(catalogId);

    const task = fetchCurrentTle(catalogId).then(async currentTle => {
        const currentEpoch = getTleEpoch(currentTle);
        const ageDays = currentEpoch ? (Date.now() - currentEpoch.getTime()) / 86400000 : Infinity;
        if (!currentEpoch || ageDays < -1 || ageDays > 30) {
            throw new Error(`Latest available TLE is ${Number.isFinite(ageDays) ? `${Math.floor(ageDays)} days old` : 'invalid'}; a TLE no more than 30 days old is required.`);
        }

        const currentIndex = debris.findIndex(station => station.tleLine1.slice(2, 7) === catalogId);
        if (currentIndex === -1) throw new Error(`NORAD ${catalogId} is no longer in the active catalog.`);
        const activeStation = debris[currentIndex];
        const activeEpoch = getTleEpoch(activeStation);
        if (!activeEpoch || currentEpoch >= activeEpoch) {
            currentTle.satrec = null;
            debris[currentIndex] = currentTle;
        }
        const archived = archiveTleObservations(catalogId, [currentTle]);
        if (archived.error) {
            estimation_status.textContent = `Using the freshly fetched current TLE, but history storage failed: ${archived.error}`;
        }
        getStationPosition(debris[currentIndex], date);
        if (selected_debris_id !== null &&
            debris[selected_debris_id] &&
            debris[selected_debris_id].tleLine1.slice(2, 7) === catalogId) {
            selected_debris_id = currentIndex;
            renderSelectedInfo(currentIndex);
            if (google_earth_active) {
                const { latitude, longitude, height } = debris[currentIndex].geodeticProperties;
                updateGoogleEarthSelectedObject(currentIndex, debris[currentIndex].name, latitude, longitude, height);
            }
        }
        await updateDebrisPositions(date);
        return currentIndex;
    }).finally(() => current_tle_tasks.delete(catalogId));
    current_tle_tasks.set(catalogId, task);
    return task;
}

function updateEstimationStatus(station) {
    const catalogId = station.tleLine1.slice(2, 7);
    const history = getTleHistory(catalogId);
    const count = history.observations.length;
    const historyMessage = history.error
        ? `History storage error: ${history.error}`
        : `Stored distinct TLE snapshots: ${count}/${LSTM_MINIMUM_HISTORY}.`;
    const model = getLstmModelMetadata(catalogId);
    const lstmMessage = model
        ? `LSTM ${model.version === 2 && model.historyFingerprint === getTleHistoryFingerprint(history.observations) ? 'trained' : 'needs retraining'}; validation MSE ${model.validationMse.toExponential(2)} vs persistence ${model.persistenceBaselineMse.toExponential(2)} (${model.beatsPersistenceBaseline ? 'beats' : 'does not beat'} baseline).`
        : 'No LSTM model is trained.';
    estimation_status.textContent = `${historyMessage} ${lstmMessage} The model is an experimental TLE-only aid, not validated flight accuracy.`;
}

export function get_info(id) {
    let info = {
        id: id,
        height: debris[id].geodeticProperties.height,
        latitude: degreesLat(debris[id].geodeticProperties.latitude),
        longitude: degreesLong(debris[id].geodeticProperties.longitude),
        velocity: debris[id].velocity,
    };
    return info;
}

const mouse = new THREE.Vector2(0, 0);
const raygun = new THREE.Raycaster();
raygun.params.Points.threshold = 0.2;

function getDebrisHit(event) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raygun.setFromCamera(mouse, camera);
    const hits = raygun.intersectObject(debris_points, false);
    const hit = hits.find(intersection => Number.isInteger(intersection.index) && intersection.index >= 0 && intersection.index < debris.length);
    return hit || null;
}

function updateHoveredDebris(event) {
    const hit = getDebrisHit(event);
    const hitId = hit ? hit.index : null;
    if (hovered_debris_id !== hitId && debris_points) {
        const colors = debris_points.geometry.getAttribute('color');
        if (hovered_debris_id !== null) colors.setXYZ(hovered_debris_id, 1, 1, 1);
        if (hitId !== null) colors.setXYZ(hitId, 1, 0.25, 0.25);
        colors.needsUpdate = true;
        hovered_debris_id = hitId;
    }

    const debris_name_card = document.getElementById("debris-name");
    const debris_name_container = document.getElementById("debris-mouseover-name");
    if (hit) {
        debris_name_container.style.display = "block";
        debris_name_card.textContent = get_name(hit.index);
    } else {
        debris_name_container.style.display = "none";
    }
}

function MouseMove(event) {
    pending_mouse_event = event;
    if (mouse_move_scheduled) return;
    mouse_move_scheduled = true;
    requestAnimationFrame(() => {
        mouse_move_scheduled = false;
        if (pending_mouse_event) updateHoveredDebris(pending_mouse_event);
    });
}

function onClick(event) {
    const hit = getDebrisHit(event);
    if (hit) {
        selectDebris(hit.index);
    }
}

export function selectDebris(id) {
    print_info(id);
    const positions = debris_points.geometry.getAttribute('position');
    const position = getStationRenderPosition(debris[id], date);
    positions.setXYZ(id, position[0], position[1], position[2]);
    positions.needsUpdate = true;
    if (google_earth_active) {
        const { latitude, longitude, height } = debris[id].geodeticProperties;
        updateGoogleEarthSelectedObject(id, debris[id].name, latitude, longitude, height);
        focusGoogleEarthPosition(latitude, longitude, height);
        return;
    }
    const objectPosition = new THREE.Vector3(
        positions.getX(id),
        positions.getY(id),
        positions.getZ(id)
    );
    move_camera_to_debri(camera, { position: objectPosition });
}

function move_camera_to_debri(camera, debris) {
    const factor = 0.3;
    const targetCoordinates = {
        x: debris.position.x + factor * debris.position.x,
        y: debris.position.y + factor * debris.position.y,
        z: debris.position.z + factor * debris.position.z
    };
    const cameraCoordinates = { 
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z
    };
    new TWEEN.Tween(cameraCoordinates)
    .to(targetCoordinates)
    .onUpdate(() => {
      camera.position.set(cameraCoordinates.x, cameraCoordinates.y, cameraCoordinates.z);
      camera.lookAt(0, 0, 0);
    })
    .start();
}

function clearTrajectory() {
    if (animation_frame_id !== null) {
        cancelAnimationFrame(animation_frame_id);
        animation_frame_id = null;
    }
    if (scenario_marker) {
        scene.remove(scenario_marker);
        scenario_marker.geometry.dispose();
        scenario_marker.material.dispose();
        scenario_marker = null;
    }
    if (trajectory_line) {
        scene.remove(trajectory_line);
        trajectory_line.geometry.dispose();
        trajectory_line.material.dispose();
        trajectory_line = null;
    }
    for (const line of fragment_trajectory_lines) {
        scene.remove(line);
        line.geometry.dispose();
        line.material.dispose();
    }
    fragment_trajectory_lines = [];
    for (const marker of fragment_markers) {
        scene.remove(marker);
        marker.geometry.dispose();
        marker.material.dispose();
    }
    fragment_markers = [];
    if (impact_marker) {
        scene.remove(impact_marker);
        impact_marker.geometry.dispose();
        impact_marker.material.dispose();
        impact_marker = null;
    }
    if (impact_footprint_line) {
        scene.remove(impact_footprint_line);
        impact_footprint_line.geometry.dispose();
        impact_footprint_line.material.dispose();
        impact_footprint_line = null;
    }
    clearGoogleEarthOverlays();
}

function focusSimulation() {
    if (focused_simulation) return;
    scene.remove(debris_points);
    document.body.classList.add('scenario-active');
    close_simulation_button.hidden = false;
    focused_simulation = true;
}

export function closeSimulation() {
    scenario_run_id++;
    clearTrajectory();
    if (focused_simulation) {
        scene.add(debris_points);
        setGoogleEarthSatellitesVisible(true);
        document.body.classList.remove('scenario-active');
        close_simulation_button.hidden = true;
        focused_simulation = false;
    }
    prediction_status.textContent = '';
}

function hasUsableTle(id) {
    const epoch = getTleEpoch(debris[id]);
    const ageMilliseconds = epoch ? date.getTime() - epoch.getTime() : null;
    if (ageMilliseconds !== null && ageMilliseconds >= -24 * 60 * 60 * 1000 && ageMilliseconds <= 30 * 24 * 60 * 60 * 1000) {
        return true;
    }

    const age = ageMilliseconds === null
        ? 'invalid'
        : `${Math.floor(ageMilliseconds / (24 * 60 * 60 * 1000))} days old`;
    prediction_status.textContent = `Simulation not run: the selected TLE is ${age}. Refresh the catalog with recent TLE data first.`;
    return false;
}

function addTrajectory(points, color) {
    trajectory_line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points.map(position => new THREE.Vector3(...position))),
        new THREE.LineBasicMaterial({ color })
    );
    scene.add(trajectory_line);
    const colorString = `#${color.toString(16).padStart(6, '0')}`;
    addGoogleEarthTrajectory(points, colorString);
}

function showCollisionBreakupScenario() {
    const selected = debris[selected_debris_id];
    const scenario = simulateHypotheticalBreakup(selected, date);
    const colors = [0xff5353, 0xff9f43, 0xffd166, 0x9be564, 0x48d7ff, 0x4d96ff, 0xb69cff, 0xff6fcf];
    let impactCount = 0;
    const fragments = scenario.fragments.filter(fragment => fragment.path.length >= 2);
    if (!fragments.length) {
        throw new Error('No fragment trajectory could be calculated from the selected TLE.');
    }

    const fragmentMarkers = fragments.map((fragment, index) => {
        const color = colors[index % colors.length];
        const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(fragment.path.map(position => new THREE.Vector3(...position))),
            new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 })
        );
        fragment_trajectory_lines.push(line);
        scene.add(line);
        addGoogleEarthTrajectory(fragment.path, `#${color.toString(16).padStart(6, '0')}`);

        const marker = new THREE.Mesh(
            new THREE.SphereGeometry(0.08, 10, 10),
            new THREE.MeshBasicMaterial({ color })
        );
        marker.position.set(...fragment.path[0]);
        scene.add(marker);
        fragment_markers.push(marker);
        const googleMarker = addGoogleEarthMarker(fragment.path[0], `#${color.toString(16).padStart(6, '0')}`, 7);
        if (fragment.impact) {
            impactCount++;
            addGoogleEarthPlaceMarker({
                latitude: fragment.impact.latitude,
                longitude: fragment.impact.longitude,
                name: `Hypothetical fragment ${index + 1}`,
                description: 'Spherical-Earth intersection in this 24-hour scenario',
            });
        }
        return { fragment, marker, googleMarker };
    });

    const animationFrames = 240;
    let frame = 0;
    function animateFragments() {
        frame++;
        const progress = Math.min(frame / animationFrames, 1);
        for (const { fragment, marker, googleMarker } of fragmentMarkers) {
            const pathIndex = Math.min(
                Math.floor(progress * (fragment.path.length - 1)),
                fragment.path.length - 1
            );
            const position = fragment.path[pathIndex];
            marker.position.set(...position);
            moveGoogleEarthMarker(googleMarker, position);
        }
        if (frame < animationFrames) {
            animation_frame_id = requestAnimationFrame(animateFragments);
        } else {
            animation_frame_id = null;
        }
    }
    animation_frame_id = requestAnimationFrame(animateFragments);

    const epoch = getTleEpoch(selected);
    const ageDays = epoch ? Math.floor((date.getTime() - epoch.getTime()) / 86400000) : null;
    const surfaceOutcome = impactCount
        ? `${impactCount} of ${fragments.length} simulated fragments intersect the simplified spherical Earth within 24 hours.`
        : `None of the ${fragments.length} simulated fragments intersects the simplified spherical Earth within 24 hours.`;
    prediction_status.textContent = `Hypothetical breakup at the selected object's current TLE state. ${surfaceOutcome} ${scenario.assumptions} This is not a detected collision, collision probability, or verified debris cloud. Actual fragment count, mass, collision energy, breakup speeds, atmospheric effects, impact damage, and casualties are unknown. TLE age: ${ageDays === null ? 'unknown' : `${ageDays} days`}.`;
}

function showCloseApproach() {
    const hasCurrentTle = hasUsableTle(selected_debris_id);
    prediction_status.textContent = hasCurrentTle
        ? 'Screening the next 24 hours for close approaches...'
        : 'Showing an illustrative orbit from stale TLE data; collision screening is unavailable.';
    const points = predictOrbit(debris[selected_debris_id], date, 24, 10, !hasCurrentTle);
    if (points.length < 2) {
        prediction_status.textContent = 'A trajectory could not be calculated from this TLE.';
        return;
    }
    addTrajectory(points, 0x48d7ff);

    if (!hasCurrentTle) {
        focusSimulation();
        prediction_status.textContent += ' No collision result is reported because this TLE is too old to support a useful close-approach screen.';
        return;
    }

    const closest = findClosestApproach(selected_debris_id, debris, date);
    if (!closest) {
        prediction_status.textContent = '24-hour orbit shown. No recent comparison TLE was found. This is not a collision-probability calculation.';
    } else {
        const level = closest.distanceKm < 5 ? 'Potential close approach flagged' : 'No close approach found by this coarse screen';
        prediction_status.textContent = `${level}: nearest sampled distance ${closest.distanceKm.toFixed(2)} km from ${debris[closest.debrisId].name} at ${closest.date.toLocaleString()}. Thirty-minute samples do not confirm or rule out a collision.`;
    }
}

function showNaturalReentryEstimate() {
    if (!hasUsableTle(selected_debris_id)) return;

    const selected = debris[selected_debris_id];
    const altitude = selected.geodeticProperties.height;
    const points = predictOrbit(selected, date);
    if (points.length >= 2) addTrajectory(points, 0xffd166);

    if (altitude <= 120) {
        prediction_status.textContent = `The object is at approximately ${altitude.toFixed(1)} km, near the simplified 120 km atmospheric interface. A natural-reentry impact location cannot be determined from TLE data alone; this orbit line is not a landing prediction.`;
        return;
    }

    prediction_status.textContent = `Natural-reentry estimate: ${predict_eol(altitude)} from this altitude-based reference. The yellow line is only the next 24 hours of orbit; TLE data alone cannot reliably predict a natural re-entry date or impact location.`;
}

function blendLstmEstimate(estimate, prediction) {
    if (!prediction || !prediction.metadata.beatsPersistenceBaseline) {
        return { estimate, used: false };
    }
    const normalizedRmse = Math.sqrt(prediction.metadata.validationMse);
    const updated = {
        ...estimate,
        position: { ...estimate.position },
        velocity: { ...estimate.velocity },
        positionStandardDeviationsKm: [...estimate.positionStandardDeviationsKm],
        velocityStandardDeviationsKmPerSecond: [...estimate.velocityStandardDeviationsKmPerSecond],
    };
    for (let component = 0; component < 6; component++) {
        const axis = ['x', 'y', 'z'][component % 3];
        const isPosition = component < 3;
        const scale = isPosition ? 7000 : 8;
        const variance = isPosition
            ? updated.positionStandardDeviationsKm[component] ** 2
            : updated.velocityStandardDeviationsKmPerSecond[component - 3] ** 2;
        const lstmVariance = (normalizedRmse * scale) ** 2;
        const gain = variance / (variance + lstmVariance);
        const key = isPosition ? 'position' : 'velocity';
        updated[key][axis] += gain * (prediction[key][axis] - updated[key][axis]);
        const posteriorSigma = Math.sqrt(variance * (1 - gain));
        if (isPosition) {
            updated.positionStandardDeviationsKm[component] = posteriorSigma;
        } else {
            updated.velocityStandardDeviationsKmPerSecond[component - 3] = posteriorSigma;
        }
    }
    updated.positionUncertaintyKm = Math.max(...updated.positionStandardDeviationsKm);
    updated.velocityUncertaintyKmPerSecond = Math.max(...updated.velocityStandardDeviationsKmPerSecond);
    return { estimate: updated, used: true };
}

function drawImpactFootprint(center, radiusKm) {
    if (!Number.isFinite(radiusKm) || radiusKm <= 0) return;
    addGoogleEarthFootprint(center, radiusKm);
    const points = [];
    const latitude = center.latitude * Math.PI / 180;
    const longitude = center.longitude * Math.PI / 180;
    const angularRadius = Math.min(radiusKm / REAL_EARTH_RADIUS, Math.PI);
    for (let index = 0; index < 96; index++) {
        const bearing = index * 2 * Math.PI / 96;
        const pointLatitude = Math.asin(
            Math.sin(latitude) * Math.cos(angularRadius) +
            Math.cos(latitude) * Math.sin(angularRadius) * Math.cos(bearing)
        );
        const pointLongitude = longitude + Math.atan2(
            Math.sin(bearing) * Math.sin(angularRadius) * Math.cos(latitude),
            Math.cos(angularRadius) - Math.sin(latitude) * Math.sin(pointLatitude)
        );
        const radius = REAL_EARTH_RADIUS * 1.002;
        points.push(getScaledCoordinates({
            x: radius * Math.cos(pointLatitude) * Math.cos(pointLongitude),
            y: radius * Math.cos(pointLatitude) * Math.sin(pointLongitude),
            z: radius * Math.sin(pointLatitude),
        }));
    }
    impact_footprint_line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(points.map(point => new THREE.Vector3(...point))),
        new THREE.LineBasicMaterial({ color: 0xffd166 })
    );
    scene.add(impact_footprint_line);
}

async function showImmediateDeorbitScenario() {
    const selectedId = selected_debris_id;
    const activeScenarioRunId = ++scenario_run_id;
    const selected = debris[selectedId];
    const epoch = getTleEpoch(selected);
    if (!epoch) {
        prediction_status.textContent = 'Simulation not run: the selected TLE has an invalid epoch.';
        return;
    }

    const catalogId = selected.tleLine1.slice(2, 7);
    prediction_status.textContent = 'Preparing the trajectory estimate; LSTM training and public mass lookup continue in the background.';
    startBackgroundLstmEngine(selectedId);
    startSatelliteMassLookup(selectedId).catch(error => {
        if (selected_debris_id === selectedId) {
            setImpactDataStatus(`Catalog mass lookup failed: ${error.message}`);
        }
    });
    const massRecord = satellite_mass_results.get(catalogId) || {
        massKg: null,
        error: 'mass lookup is still pending',
        source: null,
    };

    const history = getTleHistory(catalogId);
    if (history.error) {
        throw new Error(`Could not load this object's TLE history: ${history.error}`);
    }
    const bayesianEstimate = estimateBayesianTleState(selected, history.observations, date);
    const priorObservations = history.observations.filter(observation =>
        observation.tleLine1 !== selected.tleLine1 || observation.tleLine2 !== selected.tleLine2
    );
    let lstmPrediction = null;
    let lstmError = null;
    try {
        lstmPrediction = await predictLstmState(
            catalogId,
            priorObservations,
            date,
            getTleHistoryFingerprint(history.observations)
        );
    } catch (error) {
        lstmError = error.message;
    }
    if (!lstmPrediction && !lstmError) {
        lstmError = lstm_background_errors.get(catalogId) ||
            (lstm_training_tasks.has(catalogId) ? 'background training is still running' : null);
    }
    const blended = blendLstmEstimate(bayesianEstimate, lstmPrediction);
    const estimate = blended.estimate;
    const estimatedState = { position: estimate.position, velocity: estimate.velocity };
    const objectMassKg = massRecord.massKg;
    const assumedBulkDensityKgPerM3 = 2700;
    const equivalentRadiusMeters = objectMassKg
        ? Math.cbrt(3 * objectMassKg / (4 * Math.PI * assumedBulkDensityKgPerM3))
        : null;
    const estimatedReferenceAreaM2 = equivalentRadiusMeters === null
        ? null
        : Math.PI * equivalentRadiusMeters ** 2;
    const nominalAtmosphere = objectMassKg
        ? {
            massKg: objectMassKg,
            referenceAreaM2: estimatedReferenceAreaM2,
            dragCoefficient: 2.2,
            densityScale: 1,
            windEastMps: 0,
        }
        : null;
    const result = simulateImmediateDeorbit(selected, date, true, estimatedState, nominalAtmosphere);
    const regionLookup = getImpactRegion(result.impact.latitude, result.impact.longitude);
    ai_impact_summary.textContent = 'Retrieving source evidence and generating a cautious Gemini summary…';

    const scenarioImpacts = [];
    let unavailableScenarioCount = 0;
    const atmosphereVariants = nominalAtmosphere
        ? [
            { densityScale: 0.5, windEastMps: -50 },
            { densityScale: 0.5, windEastMps: 50 },
            { densityScale: 1.5, windEastMps: -50 },
            { densityScale: 1.5, windEastMps: 50 },
        ]
        : [null];
    for (let component = 0; component < 6; component++) {
        const standardDeviation = component < 3
            ? estimate.positionStandardDeviationsKm[component]
            : estimate.velocityStandardDeviationsKmPerSecond[component - 3];
        for (const sign of [-1, 1]) {
            const perturbedState = {
                position: { ...estimate.position },
                velocity: { ...estimate.velocity },
            };
            if (component < 3) {
                const axis = ['x', 'y', 'z'][component];
                perturbedState.position[axis] += sign * standardDeviation;
            } else {
                const axis = ['x', 'y', 'z'][component - 3];
                perturbedState.velocity[axis] += sign * standardDeviation;
            }
            for (const atmosphereVariant of atmosphereVariants) {
                try {
                    scenarioImpacts.push(simulateImmediateDeorbit(
                        selected,
                        date,
                        true,
                        perturbedState,
                        atmosphereVariant && { ...nominalAtmosphere, ...atmosphereVariant }
                    ).impact);
                } catch (error) {
                    if (error.message !== 'The simulated orbit did not intersect the simplified Earth within two hours.') {
                        throw error;
                    }
                    unavailableScenarioCount++;
                }
            }
        }
    }
    const scenarioEnvelopeRadiusKm = getScenarioEnvelopeRadiusKm(result.impact, scenarioImpacts);
    drawImpactFootprint(result.impact, scenarioEnvelopeRadiusKm);
    const footprintAreaKm2 = Number.isFinite(scenarioEnvelopeRadiusKm)
        ? Math.PI * scenarioEnvelopeRadiusKm ** 2
        : null;
    const massMessage = objectMassKg
        ? `Wikidata mass record: ${objectMassKg.toLocaleString(undefined, { maximumFractionDigits: 2 })} kg for ${massRecord.matchedName}.`
        : `Object mass: UNKNOWN (${massRecord.error}); drag was omitted for this run.`;
    setImpactDataStatus(
        `${massMessage} Impact-area region and any mapped population tag are being looked up. The outline is a scenario envelope, not a physical damage radius.`,
        massRecord.source ? [{ url: massRecord.source, label: 'Mass source' }] : []
    );
    const impactPosition = result.path[result.path.length - 1];
    const animationPath = result.path.filter(position =>
        Array.isArray(position) &&
        position.length === 3 &&
        position.every(Number.isFinite)
    );
    if (animationPath.length < 2) {
        throw new Error('Could not construct a visible descent path from this TLE.');
    }
    addTrajectory(animationPath, 0xff5252);

    scenario_marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xff5252 })
    );
    scenario_marker.position.set(...animationPath[0]);
    scene.add(scenario_marker);
    const googleScenarioMarker = addGoogleEarthMarker(animationPath[0], '#ff5252', 9);
    const pathVectors = animationPath.map(position => new THREE.Vector3(...position));
    let animationFrame = 0;
    const animationFrameCount = 300;
    function animateDescent() {
        animationFrame++;
        const progress = Math.min(animationFrame / animationFrameCount, 1);
        const pathPosition = progress * (pathVectors.length - 1);
        const pathIndex = Math.min(Math.floor(pathPosition), pathVectors.length - 2);
        const segmentStart = pathVectors[pathIndex];
        const segmentEnd = pathVectors[pathIndex + 1];
        if (!segmentStart || !segmentEnd) {
            closeSimulation();
            prediction_status.textContent = 'Simulation stopped: the descent path could not be animated.';
            return;
        }
        scenario_marker.position.copy(segmentStart).lerp(segmentEnd, pathPosition - pathIndex);
        moveGoogleEarthMarker(googleScenarioMarker, scenario_marker.position.toArray());
        if (progress < 1) {
            animation_frame_id = requestAnimationFrame(() => animateDescent());
        } else {
            animation_frame_id = null;
            impact_marker = new THREE.Mesh(
                new THREE.SphereGeometry(0.16, 12, 12),
                new THREE.MeshBasicMaterial({ color: 0xffd166 })
            );
            impact_marker.position.set(...impactPosition.map(coordinate => coordinate * 1.002));
            scene.add(impact_marker);
            addGoogleEarthMarker(impactPosition.map(coordinate => coordinate * 1.002), '#ffd166', 12);
            const sensitivityStatus = scenarioImpacts.length
                ? `The outlined footprint is the 90th-percentile offset (${scenarioEnvelopeRadiusKm.toFixed(1)} km) among ${scenarioImpacts.length} deterministic ±1σ ${nominalAtmosphere ? 'state / drag / wind' : 'state-only (drag and wind unavailable)'} scenario runs`
                    + (unavailableScenarioCount ? `; ${unavailableScenarioCount} cases did not reach the surface within two hours` : '')
                    + `; it is not a confidence region or probability of impact.`
                : `No ${nominalAtmosphere ? 'state / drag / wind' : 'state-only (drag and wind unavailable)'} sensitivity cases reached the surface within the simulation window.`;
            const lstmStatus = blended.used
                ? `LSTM state prediction was Bayesian-updated using ${lstmPrediction.metadata.validationSampleCount} chronological validation samples.`
                : lstmPrediction
                    ? 'The trained LSTM did not outperform its persistence baseline and was not used.'
                    : lstmError
                        ? `The Kalman/Bayesian estimate was used for this run; LSTM status: ${lstmError}.`
                        : 'LSTM was not applied; import at least 30 historical TLE snapshots and train it.';
            const footprintStatus = Number.isFinite(scenarioEnvelopeRadiusKm)
                ? `Scenario footprint radius: ${scenarioEnvelopeRadiusKm.toFixed(1)} km (about ${footprintAreaKm2.toFixed(1)} km² circular area); this represents deterministic sensitivity runs, not a damage zone or probability region.`
                : 'Scenario footprint radius unavailable; no perturbation runs reached the surface.';
            const atmosphericStatus = nominalAtmosphere
                ? `Illustrative drag treats the sourced catalog mass as one intact object and uses a spherical-equivalent area assuming ${assumedBulkDensityKgPerM3} kg/m³ bulk density, with ±50 m/s wind and 0.5–1.5× density cases. This does not model ablation or fragmentation and is not measured object shape or local weather.`
                : 'Atmospheric drag was not modeled because no source-backed object mass was found.';
            const populationStatus = region => {
                const regionText = region.name
                    ? `Approximate mapped region: ${region.name}.`
                    : `Regional name unavailable (${region.error}); coordinates are shown instead.`;
                const populationText = region.population
                    ? `OpenStreetMap has a population tag of ${region.population.toLocaleString()} for the mapped feature; this is not the number inside the footprint.`
                    : 'Local population inside the footprint: UNKNOWN; no suitable mapped population value was available.';
                return `${regionText} ${populationText} Actual damage and casualties: UNKNOWN; fragment survival and validated impact/damage data are unavailable.`;
            };
            prediction_status.textContent = `Simulation complete. Kalman/Bayesian${blended.used ? ' + LSTM' : ''} mean-state spherical-Earth intersection: ${result.impact.latitude.toFixed(2)}° latitude, ${result.impact.longitude.toFixed(2)}° longitude. Regional name and population lookup is pending. ${footprintStatus} ${sensitivityStatus} The estimate used ${estimate.measurementCount} distinct TLE snapshot(s), with assumed initial uncertainty of ±${estimate.positionUncertaintyKm.toFixed(1)} km (1σ position) and ±${(estimate.velocityUncertaintyKmPerSecond * 1000).toFixed(1)} m/s (1σ velocity). ${atmosphericStatus} ${lstmStatus} The LSTM is trained on TLE-derived state history only; it does not learn object mass or casualty outcomes. TLE age: ${Math.floor((date.getTime() - epoch.getTime()) / 86400000)} days. This highly simplified result is illustrative, not a reliable impact forecast.`;
            regionLookup.then(region => {
                if (activeScenarioRunId !== scenario_run_id || !focused_simulation) return;
                        addGoogleEarthPlaceMarker({
                            latitude: result.impact.latitude,
                            longitude: result.impact.longitude,
                            name: region.name || 'Modeled impact location',
                            description: 'Illustrative scenario location',
                        });
                        prediction_status.textContent = prediction_status.textContent.replace(
                    'Regional name and population lookup is pending.',
                    populationStatus(region)
                );
                const dataSources = [];
                if (massRecord.source) dataSources.push({ url: massRecord.source, label: 'Wikidata mass source' });
                for (const source of region.sources || []) {
                    dataSources.push({ url: source.url, label: `${source.name} map source` });
                }
                if (region.populationSource) dataSources.push({ url: region.populationSource, label: 'OpenStreetMap population source' });
                setImpactDataStatus(`${massMessage} ${populationStatus(region)} Footprint radius: ${Number.isFinite(scenarioEnvelopeRadiusKm) ? `${scenarioEnvelopeRadiusKm.toFixed(1)} km` : 'unknown'}.`, dataSources);
                getGroundedImpactSummary({
                    name: get_name(selectedId),
                    latitude: result.impact.latitude,
                    longitude: result.impact.longitude,
                    footprintRadiusKm: Number.isFinite(scenarioEnvelopeRadiusKm) ? scenarioEnvelopeRadiusKm : 0,
                    impactSpeedKmPerSecond: result.impact.velocityKmPerSecond,
                    tleAgeDays: Math.max(0, (date.getTime() - epoch.getTime()) / 86400000),
                }).then(summary => {
                    if (activeScenarioRunId === scenario_run_id && focused_simulation) {
                        showGroundedImpactSummary(summary);
                    }
                }).catch(error => {
                    if (activeScenarioRunId === scenario_run_id && focused_simulation) {
                        ai_impact_summary.textContent = `Evidence-grounded AI summary unavailable: ${error.message}`;
                    }
                });
            });
        }
    }
    animation_frame_id = requestAnimationFrame(() => animateDescent());

    const ageDays = Math.floor((date.getTime() - epoch.getTime()) / 86400000);
    prediction_status.textContent = `Animating the selected object's hypothetical descent from the Kalman/Bayesian estimated state. The path follows the simulated states; it does not connect to a potentially different stale catalog position. Idealized retrograde burn: ${result.burnDeltaV.toFixed(0)} m/s. ${nominalAtmosphere ? 'Simplified atmospheric drag and explicit wind/density sensitivity scenarios are included.' : 'Drag is omitted because object mass is unknown.'} Damage and casualties remain UNKNOWN; the outline is a state/atmosphere sensitivity footprint only. ${blended.used ? 'LSTM contributes through a Bayesian update after beating the chronological persistence baseline.' : lstmPrediction ? 'LSTM is trained but not used because it did not beat the persistence baseline.' : lstmError ? `LSTM could not be loaded and was excluded: ${lstmError}` : 'LSTM is not trained yet; import at least 30 historical TLE snapshots.'} TLE age: ${ageDays} days${ageDays > 30 ? '; this is not a reliable real-world trajectory because the TLE is stale' : ''}.`;
}

function showBayesianTrajectory() {
    const selected = debris[selected_debris_id];
    const catalogId = selected.tleLine1.slice(2, 7);
    const history = getTleHistory(catalogId);
    if (history.error) {
        throw new Error(`Could not load this object's TLE history: ${history.error}`);
    }

    const estimate = estimateBayesianTleState(selected, history.observations, date);
    const points = predictBayesianTrajectory(estimate, date);
    if (points.length < 2) {
        throw new Error('Could not calculate a trajectory from the available TLE snapshots.');
    }
    addTrajectory(points, 0xb69cff);
    const epoch = getTleEpoch(selected);
    const ageDays = epoch ? Math.floor((date.getTime() - epoch.getTime()) / 86400000) : null;
    prediction_status.textContent = `Experimental 24-hour two-body forecast from a Bayesian Kalman estimate using ${estimate.measurementCount} distinct TLE snapshot(s). Initial state uncertainty: ±${estimate.positionUncertaintyKm.toFixed(1)} km (1σ position), ±${(estimate.velocityUncertaintyKmPerSecond * 1000).toFixed(1)} m/s (1σ velocity), under assumed TLE error values. Current TLE age: ${ageDays === null ? 'unknown' : `${ageDays} days`}. This is not calibrated accuracy; atmospheric drag, Earth oblateness, and other perturbations are omitted. LSTM is not trained or used.`;
}

async function showPrediction() {
    if (selected_debris_id === null) return;

    clearTrajectory();
    prediction_button.disabled = true;
    prediction_status.textContent = 'Refreshing the selected object’s current TLE and preparing the scenario...';
    try {
        const selectedCatalogId = getSelectedCatalogId();
        const refreshedId = await ensureCurrentTle(selected_debris_id);
        if (getSelectedCatalogId() !== selectedCatalogId) return;
        selected_debris_id = refreshedId;
        if (!hasUsableTle(selected_debris_id)) {
            prediction_status.textContent = 'Simulation not run: no recent TLE is available for this object. Refresh its TLE and try again.';
            return;
        }
        focusSimulation();
        if (scenario_mode.value === 'forced-reentry') {
            await showImmediateDeorbitScenario();
        } else if (scenario_mode.value === 'natural-reentry') {
            showNaturalReentryEstimate();
        } else if (scenario_mode.value === 'bayesian-trajectory') {
            showBayesianTrajectory();
        } else if (scenario_mode.value === 'collision-breakup') {
            showCollisionBreakupScenario();
        } else {
            showCloseApproach();
        }
    } catch (error) {
        closeSimulation();
        prediction_status.textContent = `Simulation failed: ${error.message}`;
    } finally {
        prediction_button.disabled = false;
    }
}

function startBackgroundLstmTraining(selectedId, historyAlreadyRefreshed = false) {
    const selected = debris[selectedId];
    const catalogId = selected.tleLine1.slice(2, 7);
    if (lstm_training_tasks.has(catalogId)) return lstm_training_tasks.get(catalogId);

    const localHistory = getTleHistory(catalogId);
    const existingModel = getLstmModelMetadata(catalogId);
    if (existingModel &&
        existingModel.version === 2 &&
        !localHistory.error &&
        existingModel.historyFingerprint === getTleHistoryFingerprint(localHistory.observations)) {
        updateEstimationStatus(selected);
        return Promise.resolve();
    }

    const requiresModelUpgrade = Boolean(existingModel && existingModel.version !== 2);
    const historyFingerprint = getTleHistoryFingerprint(localHistory.observations);
    const lastAttempt = lstm_last_attempts.get(catalogId);
    const attemptedFingerprint = lstm_last_attempt_fingerprints.get(catalogId);
    if (!requiresModelUpgrade &&
        attemptedFingerprint === historyFingerprint &&
        lastAttempt &&
        Date.now() - lastAttempt < LSTM_RETRY_DELAY_MS) {
        const retryMinutes = Math.ceil((LSTM_RETRY_DELAY_MS - (Date.now() - lastAttempt)) / 60000);
        if (selected_debris_id === selectedId) {
            estimation_status.textContent = `Automatic history import/training will retry in about ${retryMinutes} minute(s).`;
        }
        return Promise.resolve();
    }

    const isStillSelected = () => selected_debris_id === selectedId;
    const task = (async () => {
        try {
            if (isStillSelected()) {
                estimation_status.textContent = 'Background LSTM: importing up to 100 historical TLE snapshots from Space-Track...';
            }
            let importError = null;
            if (!historyAlreadyRefreshed) {
                try {
                    const tleText = await fetchSpaceTrackTleHistory(catalogId);
                    const imported = archiveTleObservations(catalogId, parseTleHistory(tleText));
                    if (imported.error) throw new Error(`History could not be saved: ${imported.error}`);
                } catch (error) {
                    importError = error.message;
                }
            }
            const history = getTleHistory(catalogId);
            if (history.error) throw new Error(`History could not be read: ${history.error}`);
            if (history.observations.length < LSTM_MINIMUM_HISTORY) {
                lstm_background_errors.set(catalogId, importError || 'History contains too few distinct TLE snapshots.');
                if (isStillSelected()) {
                    estimation_status.textContent = importError
                        ? `Background LSTM import failed: ${importError} Local storage has ${history.observations.length}/${LSTM_MINIMUM_HISTORY} distinct snapshots; training is unavailable.`
                        : `Background LSTM paused: only ${history.observations.length}/${LSTM_MINIMUM_HISTORY} distinct TLE snapshots are available.`;
                }
                return;
            }

            if (isStillSelected()) {
                estimation_status.textContent = `Background LSTM: preparing and training on ${history.observations.length} dated TLE snapshots${importError ? ' from local history; live import was unavailable' : ''}...`;
            }
            const metadata = await trainLstmModelInWorker(catalogId, history.observations, (epoch, totalEpochs) => {
                if (isStillSelected()) {
                    estimation_status.textContent = `Background LSTM worker: training epoch ${epoch}/${totalEpochs}; chronological testing follows.`;
                }
            });
            saveLstmModelMetadata(catalogId, metadata);
            lstm_background_errors.delete(catalogId);
            if (isStillSelected()) {
                estimation_status.textContent = `Background LSTM tested on ${metadata.validationSampleCount} later samples. Validation MSE ${metadata.validationMse.toExponential(2)}; persistence baseline ${metadata.persistenceBaselineMse.toExponential(2)}. ${metadata.beatsPersistenceBaseline ? 'It can contribute to the next de-orbit estimate.' : 'It did not outperform the baseline and will not be used.'}${importError ? ` Live import failed (${importError}); the model used saved local snapshots.` : ''}`;
            }
        } catch (error) {
            lstm_background_errors.set(catalogId, error.message);
            if (isStillSelected()) {
                estimation_status.textContent = `Background LSTM import/training failed: ${error.message} It will retry after the cooldown.`;
            }
        } finally {
            lstm_training_tasks.delete(catalogId);
        }
    })();
    lstm_last_attempts.set(catalogId, Date.now());
    lstm_last_attempt_fingerprints.set(catalogId, historyFingerprint);
    lstm_training_tasks.set(catalogId, task);
    return task;
}

function startBackgroundLstmEngine(selectedId) {
    const station = debris[selectedId];
    if (!station) return;
    const catalogId = station.tleLine1.slice(2, 7);
    if (lstm_engine_catalog_id !== catalogId) {
        if (lstm_engine_timer !== null) clearTimeout(lstm_engine_timer);
        lstm_engine_catalog_id = catalogId;
        lstm_engine_last_history_refresh = 0;
    } else if (lstm_engine_timer !== null ||
        (lstm_engine_cycle_promise && lstm_engine_cycle_catalog_id === catalogId)) {
        return;
    }

    const cycle = runBackgroundLstmEngineCycle(catalogId);
    lstm_engine_cycle_promise = cycle;
    lstm_engine_cycle_catalog_id = catalogId;
    cycle.then(() => {
        if (lstm_engine_cycle_promise === cycle) {
            lstm_engine_cycle_promise = null;
            lstm_engine_cycle_catalog_id = null;
        }
    }, () => {
        if (lstm_engine_cycle_promise === cycle) {
            lstm_engine_cycle_promise = null;
            lstm_engine_cycle_catalog_id = null;
        }
    });
}

async function runBackgroundLstmEngineCycle(catalogId) {
    if (lstm_engine_catalog_id !== catalogId) return;
    const selectedId = debris.findIndex(station => station.tleLine1.slice(2, 7) === catalogId);
    if (selectedId < 0 || getSelectedCatalogId() !== catalogId) return;

    try {
        if (Date.now() - lstm_engine_last_history_refresh >= LSTM_HISTORY_REFRESH_INTERVAL_MS) {
            estimation_status.textContent = `Background LSTM engine: checking Space-Track history for NORAD ${catalogId}...`;
            const historyText = await fetchSpaceTrackTleHistory(catalogId);
            if (lstm_engine_catalog_id !== catalogId || getSelectedCatalogId() !== catalogId) return;
            const imported = archiveTleObservations(catalogId, parseTleHistory(historyText));
            if (imported.error) throw new Error(`TLE history could not be saved: ${imported.error}`);
            lstm_engine_last_history_refresh = Date.now();
        }

        const currentSelectedId = debris.findIndex(station => station.tleLine1.slice(2, 7) === catalogId);
        if (currentSelectedId < 0 || getSelectedCatalogId() !== catalogId) return;
        await startBackgroundLstmTraining(currentSelectedId, true);
        if (!lstm_background_errors.has(catalogId) && getSelectedCatalogId() === catalogId) {
            estimation_status.textContent += ' Background LSTM engine is active; it checks for new history every 2 hours and retrains when distinct TLE data arrives.';
        }
    } catch (error) {
        lstm_background_errors.set(catalogId, error.message);
        if (getSelectedCatalogId() === catalogId) {
            estimation_status.textContent = `Background LSTM engine could not update: ${error.message} It will retry automatically.`;
        }
    } finally {
        if (lstm_engine_catalog_id === catalogId && getSelectedCatalogId() === catalogId) {
            lstm_engine_timer = setTimeout(() => {
                lstm_engine_timer = null;
                void runBackgroundLstmEngineCycle(catalogId);
            }, LSTM_ENGINE_INTERVAL_MS);
        }
    }
}

function trainLstmModelInWorker(catalogId, observations, onProgress) {
    if (typeof Worker === 'undefined') {
        return Promise.reject(new Error('This browser does not support Web Workers; background LSTM training is unavailable.'));
    }

    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./lstm-training.worker.js', import.meta.url), { type: 'module' });
        const finish = callback => value => {
            worker.terminate();
            callback(value);
        };
        worker.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'progress') {
                onProgress(message.epoch, message.totalEpochs);
            } else if (message.type === 'complete') {
                finish(resolve)(message.metadata);
            } else if (message.type === 'error') {
                finish(reject)(new Error(message.error));
            }
        });
        worker.addEventListener('error', event => {
            event.preventDefault();
            finish(reject)(new Error(event.message || 'The LSTM training worker failed.'));
        }, { once: true });
        worker.postMessage({ catalogId, observations });
    });
}

function searchDebris() {
    const query = debris_search.value.trim().toLocaleLowerCase();
    if (!query) {
        debris_search_status.textContent = 'Enter an object name to search.';
        return;
    }
    const id = debris.findIndex(station => station.name.toLocaleLowerCase().includes(query));
    if (id < 0) {
        debris_search_status.textContent = 'No matching object found.';
        return;
    }
    selectDebris(id);
}

debris_search_button.addEventListener('click', searchDebris);
debris_search.addEventListener('keydown', event => {
    if (event.key === 'Enter') searchDebris();
});
prediction_button.addEventListener('click', showPrediction);
close_simulation_button.addEventListener('click', closeSimulation);
scenario_mode.addEventListener('change', () => {
    document.getElementById('impact-assumptions').hidden = scenario_mode.value !== 'forced-reentry';
});
document.getElementById('impact-assumptions').hidden = scenario_mode.value !== 'forced-reentry';
window.addEventListener('mousemove', MouseMove, true);
window.addEventListener('dblclick', onClick, true);
