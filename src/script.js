import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import * as dat from 'dat.gui'
import * as globe from './globe.js'
import * as debris_handler from './debris_handler.js'
import { get_slider_value, get_playback_speed, is_simulation_playing } from './slider.js'
import * as TWEEN from "@tweenjs/tween.js";
import { drawPath } from './debris'
import "./area_selector.js";
import { sgp4 } from 'satellite.js';
import { debris, replaceDebrisCatalog } from './satellite_registry'
import { EARTH_RADIUS, REAL_EARTH_RADIUS, SCALE_RATIO } from './constants.js';
import { fetchLiveDebrisCatalog } from './live_tle.js';
import { archiveTleObservation } from './trajectory_history.js';
import { initializeGoogleEarth, setGoogleEarthLayerVisibility } from './google_earth.js';

export { EARTH_RADIUS, REAL_EARTH_RADIUS, SCALE_RATIO };

//Basic stuff
//const gui = new dat.GUI()
const canvas = document.querySelector('canvas.webgl')
export const scene = new THREE.Scene()          //Need to export it so that mouse_move event can have it with raycasting

export function add_to_scene(obj) {
    scene.add(obj);
}
export function remove_from_scene(obj) {
    scene.remove(obj);
}

// Textures
const textureLoader = new THREE.TextureLoader()
const earthTexture = textureLoader.load('compressed_textures/EarthTexture.jpg')
const earthNormalMap = textureLoader.load('compressed_textures/NormalMap.jpg')
const starsTexture = textureLoader.load('compressed_textures/8k_stars_milky_way.jpg')
const debrisTexture = textureLoader.load('compressed_textures/circle.png')

// sky
const sky = new THREE.SphereGeometry(50*EARTH_RADIUS, 64, 64)
const stars = new THREE.MeshBasicMaterial();
stars.map = starsTexture
stars.side = THREE.BackSide
scene.add(new THREE.Mesh(sky, stars))

// globe
const sphere = globe.globe(EARTH_RADIUS, earthTexture, earthNormalMap);
//const atmosphere = globe.atmosphere(EARTH_RADIUS-1);
scene.add(sphere)
//scene.add(atmosphere)

// Lights
scene.add(new THREE.AmbientLight(0x333333, 5));
const light = new THREE.DirectionalLight(0xffffff, 0.15)
light.castShadow = true;

light.position.set(100, 100, 0).normalize();
//gui.add(light, 'intensity').min(0).max(8).step(0.01)
//gui.add(light.position, 'x')
//gui.add(light.position, 'y')
//gui.add(light.position, 'z')
scene.add(light)

//Canvas Size
const sizes = {
    width: window.innerWidth,
    height: window.innerHeight
}

window.addEventListener('resize', () => {
    sizes.width = window.innerWidth
    sizes.height = window.innerHeight
    camera.aspect = sizes.width / sizes.height
    camera.updateProjectionMatrix()
    renderer.setSize(sizes.width, sizes.height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
})

// Camera
export const camera = new THREE.PerspectiveCamera(45, sizes.width / sizes.height, 0.01, 1000)
camera.position.x = 0
camera.position.y = 0
camera.position.z = EARTH_RADIUS*5
scene.add(camera)


// Controls
const controls = new OrbitControls(camera, canvas)
controls.rotateSpeed = 0.3;
controls.enableDamping = true;
controls.enablePan = true;
controls.minDistance = EARTH_RADIUS + 1;
controls.maxDistance = 20 * EARTH_RADIUS;

//debris
var debris_positions = [];
export const origin_date = new Date();
export let date = new Date();
let simulation_time_ms = date.getTime();
for (let i = 0; i < debris.length; i++) {
    debris_positions.push([i, 0, 0, 0]);
}
// Debris should be passed with ([ [debris_id, x, y, z], ...], Texture to draw)
export const debris_objects = debris_handler.draw_debris(debris_positions, debrisTexture);
scene.add(...debris_objects);

// Renderer
const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
})

renderer.setSize(sizes.width, sizes.height)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

//Animation
let last_frame_time;
let position_update_elapsed = 0;
let clock_update_elapsed = 0;
const POSITION_UPDATE_INTERVAL_MS = 5000;
const CLOCK_UPDATE_INTERVAL_MS = 1000;
const LIVE_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;

function tick(time) {
    if (last_frame_time !== undefined && is_simulation_playing()) {
        const elapsed = Math.min(time - last_frame_time, 1000);
        simulation_time_ms += elapsed * get_playback_speed();
        position_update_elapsed += elapsed;
        clock_update_elapsed += elapsed;
    }
    last_frame_time = time;

    if (clock_update_elapsed >= CLOCK_UPDATE_INTERVAL_MS) {
        date = new Date(simulation_time_ms);
        document.getElementById('simulation-clock').textContent = date.toLocaleString(undefined, {
            timeZone: 'UTC',
            timeZoneName: 'short',
        });
        clock_update_elapsed = 0;
    }
    if (position_update_elapsed >= POSITION_UPDATE_INTERVAL_MS) {
        date = new Date(simulation_time_ms);
        debris_handler.updateDebrisPositions(date);
        position_update_elapsed = 0;
    }
    if (!document.body.classList.contains('google-earth-active')) {
        controls.update()
        renderer.render(scene, camera)
    }
    TWEEN.update(time);
    requestAnimationFrame(tick);
}

tick(0);
debris_handler.updateSimulationStatus(`Preparing positions for all ${debris.length.toLocaleString()} catalog objects...`);
debris_handler.updateDebrisPositions(date);
initializeGoogleEarth(
    document.getElementById('google-earth-container'),
    debris_handler.selectDebris
).then(result => {
    debris_handler.setGoogleEarthActive(result.enabled);
    document.getElementById('earth-layer-controls').hidden = !result.enabled;
    debris_handler.updateSimulationStatus(result.message);
}).catch(error => {
    document.getElementById('earth-layer-controls').hidden = true;
    debris_handler.updateSimulationStatus(`Google Earth tiles could not be loaded; using the built-in globe. ${error.message}`);
});
document.querySelectorAll('[data-map-layer]').forEach(control => {
    control.addEventListener('change', event => {
        setGoogleEarthLayerVisibility(event.currentTarget.dataset.mapLayer, event.currentTarget.checked);
    });
});
document.getElementById('simulation-clock').textContent = date.toLocaleString(undefined, {
    timeZone: 'UTC',
    timeZoneName: 'short',
});

const live_refresh_button = document.getElementById('refresh-tle-button');
let is_refreshing_live_catalog = false;

async function refreshLiveCatalog() {
    if (is_refreshing_live_catalog) return;

    is_refreshing_live_catalog = true;
    live_refresh_button.disabled = true;
    debris_handler.updateSimulationStatus('Connecting to Space-Track and CelesTrak live data...');
    try {
        const selectedCatalogId = debris_handler.getSelectedCatalogId();
        const live_catalog = await fetchLiveDebrisCatalog(selectedCatalogId);
        let trajectoryHistoryStatus = '';
        if (selectedCatalogId) {
            const selectedTle = live_catalog.stations.find(station =>
                station.tleLine1.slice(2, 7) === selectedCatalogId
            );
            if (selectedTle) {
                const archived = archiveTleObservation(selectedTle);
                trajectoryHistoryStatus = archived.error
                    ? ` Selected-object history could not be saved: ${archived.error}`
                    : archived.added
                        ? ` Saved a new TLE snapshot for the selected object (${archived.count} distinct snapshots).`
                        : ` Selected-object history is unchanged (${archived.count} distinct TLE snapshots).`;
            }
        }
        if (live_catalog.stations.length > 0) {
            replaceDebrisCatalog(live_catalog.stations);
            date = new Date();
            simulation_time_ms = date.getTime() + get_slider_value() * 60 * 60 * 1000;
            date = new Date(simulation_time_ms);
            await debris_handler.redrawDebris(date, selectedCatalogId);
        }
        if (live_catalog.stations.length === 0 && live_catalog.errors.length > 0) {
            debris_handler.updateSimulationStatus(`Live update unavailable. Current bundled catalog kept. ${live_catalog.errors.map(error => error.message).join(' ')}`);
            return;
        }
        const updatedStatus = live_catalog.updatedGroups.length
            ? `Updated ${live_catalog.updatedGroups.join(', ')}.`
            : 'No groups were downloaded; used available cached copies.';
        const cachedStatus = live_catalog.cachedGroups.length
            ? ` ${live_catalog.cachedGroups.length} group(s) used their last successful local download.`
            : '';
        const storageStatus = live_catalog.uncachedGroups.length
            ? ` Could not save local copies of: ${live_catalog.uncachedGroups.join(', ')}.`
            : '';
        const errorStatus = live_catalog.errors.length
            ? ` Some groups were unavailable: ${live_catalog.errors.map(error => `${error.group} (${error.message})`).join('; ')} Existing catalog data was retained.`
            : '';
        debris_handler.updateSimulationStatus(`${updatedStatus} Live catalog: ${live_catalog.stations.length.toLocaleString()} downloaded objects at ${new Date().toLocaleTimeString()}.${cachedStatus}${storageStatus}${errorStatus}${trajectoryHistoryStatus}`);
    } catch (error) {
        const reason = error.name === 'AbortError' ? 'The request timed out.' : error.message;
        debris_handler.updateSimulationStatus(`Live update failed (${reason}) Using the bundled catalog or last successful update.`);
    } finally {
        is_refreshing_live_catalog = false;
        live_refresh_button.disabled = false;
    }
}

live_refresh_button.addEventListener('click', event => {
    event.cancelBubble = true;
    refreshLiveCatalog();
});
debris_handler.updateSimulationStatus('Starting with the bundled catalog; checking for live TLE data...');
refreshLiveCatalog();
window.setInterval(refreshLiveCatalog, LIVE_REFRESH_INTERVAL_MS);

document.getElementById('slider-button').addEventListener('click', () => {
    simulation_time_ms = Date.now() + get_slider_value() * 60 * 60 * 1000;
    date = new Date(simulation_time_ms);
    debris_handler.updateDebrisPositions(date);
    position_update_elapsed = 0;
    clock_update_elapsed = 0;
    document.getElementById('simulation-clock').textContent = date.toLocaleString(undefined, {
        timeZone: 'UTC',
        timeZoneName: 'short',
    });
});
