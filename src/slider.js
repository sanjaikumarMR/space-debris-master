const slider = document.getElementById("time-slider");
const slider_button = document.getElementById("slider-button");
const playback_speed = document.getElementById("playback-speed");
const play_button = document.getElementById("play-button");

let slider_val = 0;
let is_playing = true;

export function get_slider_value() {
    return slider_val;
}

export function get_playback_speed() {
    return Number(playback_speed.value);
}

export function is_simulation_playing() {
    return is_playing;
}

function set_new_time(event) {
    event.cancelBubble = true;
    slider_val = Number(slider.value);
}

slider_button.onclick = set_new_time;
play_button.onclick = event => {
    event.cancelBubble = true;
    is_playing = !is_playing;
    play_button.textContent = is_playing ? 'Pause' : 'Play';
    play_button.setAttribute('aria-pressed', String(is_playing));
};
