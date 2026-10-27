import * as THREE from 'three';

import { add_to_scene, remove_from_scene } from './script.js'
import { EARTH_RADIUS, SCALE_RATIO } from './constants.js';
import { getStationState } from './satellite_util.js';
import { date } from './script.js';
import { debris } from './satellite_registry.js';
import { degreesLat, degreesLong } from 'satellite.js/lib/index';
import { isGoogleEarthReady, removeGoogleEarthArea, showGoogleEarthArea } from './google_earth.js';

const submit_button = document.getElementById('area-selector-submit');
const test_button   = document.getElementById('area-selector-test');
const latitude_btn  = document.getElementById('latitude-btn');
const longitude_btn = document.getElementById('longitude-btn');
const altitude_btn  = document.getElementById('altitude-btn');
const radius_btn    = document.getElementById('radius-btn');
const period_btn      = document.getElementById('period-btn');
const num_of_debris = document.getElementById('number-of-debris-area');

let prev_obj = undefined;

function get_values() {
    let data = {
        latitude: Number(latitude_btn.value),
        longitude: Number(longitude_btn.value),
        altitude: Number(altitude_btn.value),
        radius: Number(radius_btn.value),
        period: Number(period_btn.value),
    };
    return data;
}

function test_area(event) {
    event.cancelBubble = true;
    let data = get_values();
    if (prev_obj) {
        remove_from_scene(prev_obj);
        prev_obj = undefined;
    }
    removeGoogleEarthArea();
    if (!Number.isFinite(data.latitude) || Math.abs(data.latitude) > 90) {
        alert("Invalid Latitude")
        return
    }
    if (!Number.isFinite(data.longitude) || Math.abs(data.longitude) > 180) {
        alert("Invalid longitude")
        return
    }
    if (!Number.isFinite(data.altitude) || data.altitude <= 0) {
        alert("Invalid altitude")
        return
    }
    if (!Number.isFinite(data.radius) || data.radius <= 0) {
        alert("Invalid radius")
        return
    }
    if (!Number.isFinite(data.period) || data.period < 0 || data.period > 100) {
        alert("Time period must be between 0 and 100 minutes")
        return
    }
    if (isGoogleEarthReady()) {
        showGoogleEarthArea(data);
        return;
    }
    const height = data.altitude*SCALE_RATIO+EARTH_RADIUS
    const cylinderGeo   = new THREE.CylinderGeometry(data.radius*SCALE_RATIO, data.radius*SCALE_RATIO, height, 32);
    cylinderGeo.applyMatrix4( new THREE.Matrix4().makeTranslation(0, height/2, 0) );
    const cylinderMat   = new THREE.MeshNormalMaterial({transparent: true, opacity: 0.4});
    cylinderMat.wireframe = true;
    //console.log(cylinderMat)
    const my_cyli = new THREE.Mesh(cylinderGeo, cylinderMat);
    my_cyli.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), ((data.latitude-90)*Math.PI)/180);
    my_cyli.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), ((data.longitude-90)*Math.PI)/180);
    prev_obj = my_cyli
    add_to_scene(my_cyli);
}

function getDistanceFromLatLonInKm(lat1,lon1,lat2,lon2) {
  var R = 6371; // Radius of the earth in km
  var dLat = deg2rad(lat2-lat1);  // deg2rad below
  var dLon = deg2rad(lon2-lon1); 
  var a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2)
    ; 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  var d = R * c; // Distance in km
  return d;
}


export function show_number_of_debris_in_area() {         //Period will be in mins
    let data = get_values();
    const matches = new Set();
    const endSeconds = data.period * 60;

    for (let elapsedSeconds = 0; elapsedSeconds <= endSeconds; elapsedSeconds += 20) {
        const sampleDate = new Date(date.getTime() + elapsedSeconds * 1000);
        for (let id = 0; id < debris.length; id++) {
            const state = getStationState(debris[id], sampleDate);
            if (!state) continue;

            const latitude = degreesLat(state.geodeticProperties.latitude);
            const longitude = degreesLong(state.geodeticProperties.longitude);
            if (
                state.geodeticProperties.height <= data.altitude &&
                getDistanceFromLatLonInKm(latitude, longitude, data.latitude, data.longitude) <= data.radius
            ) {
                matches.add(id);
            }
        }
    }

    return matches.size;
}

function deg2rad(deg) {
  return deg * (Math.PI/180)
}

function sumbit_onclick(event) {
    event.cancelBubble = true;
    const data = get_values();
    if (
        !Number.isFinite(data.latitude) || Math.abs(data.latitude) > 90 ||
        !Number.isFinite(data.longitude) || Math.abs(data.longitude) > 180 ||
        !Number.isFinite(data.altitude) || data.altitude <= 0 ||
        !Number.isFinite(data.radius) || data.radius <= 0 ||
        !Number.isFinite(data.period) || data.period < 0 || data.period > 100
    ) {
        alert("Enter valid coordinates, positive altitude and radius, and a time between 0 and 100 minutes");
        return;
    }
    num_of_debris.innerText = show_number_of_debris_in_area();
}
submit_button.onclick = sumbit_onclick;
test_button.onclick = test_area;
