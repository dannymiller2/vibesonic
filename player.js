/* -------------------------------------------------------------
 * VIBESONIC - 3D Spatial Audio Engine & Music Player
 * ------------------------------------------------------------- */

// DSP Settings & Node Variables
let audioCtx = null;
let audioSource = null;
let channelSplitter = null;
let leftGain = null;
let rightGain = null;

// Playlist Queue State
let playlistQueue = [];
let currentTrackIndex = -1;

// System audio capture variables
let captureStream = null;
let deviceAudioSourceNode = null;
let isCapturingSystemAudio = false;
let activeInputSource = null;

function connectInputSource(sourceNode) {
    if (activeInputSource) {
        try {
            activeInputSource.disconnect(channelSplitter);
            activeInputSource.disconnect(bassFilter);
        } catch (e) {}
    }
    activeInputSource = sourceNode;
    activeInputSource.connect(channelSplitter);
    activeInputSource.connect(bassFilter);
}

// Virtual speakers (PannerNodes)
let leftPanner = null;
let rightPanner = null;

// Crossfeed Network Nodes
let leftToRightDelay = null;
let leftToRightFilter = null;
let leftToRightGain = null;
let rightToLeftDelay = null;
let rightToLeftFilter = null;
let rightToLeftGain = null;

// DSP Nodes
let bassFilter = null;
let bassGain = null;
let vocalFilter = null;
let roomConvolver = null;
let roomGain = null;
let finalGain = null;
let analyserNode = null;

// Bypass control
let spatialBypassed = false;

// Audio element & state
let audioElement = null;
let timelineSlider = null;
let btnPlayPause = null;
let playIcon = null;
let pauseIcon = null;

// Visualizer State
let outputCanvas, outputCtx;
let drawVisualId;

// Speaker Radar Coordinates (Values in coordinates relative to canvas center)
// Normalized coordinates: -1.0 to 1.0 (relative to radar size)
// Listener is at (0, 0)
const speakerPositions = {
    L: { x: -0.5, y: -0.5 }, // Top-left (in front, to the left)
    R: { x: 0.5, y: -0.5 }   // Top-right (in front, to the right)
};
const defaultPositions = {
    L: { x: -0.5, y: -0.5 },
    R: { x: 0.5, y: -0.5 }
};

let radarCanvas, radarCtx;
let activeSpeakerHandle = null; // 'L', 'R', or null
let autoOrbitActive = false;
let orbitAngle = 0;

// DSP Parameters
const dspParams = {
    crossfeed: 0.4,
    roomWet: 0.25,
    bassBoost: 0.3,
    vocalClarity: 0.2,
    preset: 'studio'
};

// Initialize Audio Nodes
function initSpatialEngine() {
    if (audioCtx) return;

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();

    audioElement = document.getElementById('audio-element');
    audioSource = audioCtx.createMediaElementSource(audioElement);

    // 1. Channel Splitter
    channelSplitter = audioCtx.createChannelSplitter(2);

    // 2. Pre-spatial Mixing Gain nodes (combines split channel + crossfeed from opposite channel)
    leftGain = audioCtx.createGain();
    rightGain = audioCtx.createGain();

    // 3. Virtual Speakers (Binaural HRTF PannerNodes)
    leftPanner = audioCtx.createPanner();
    leftPanner.panningModel = 'HRTF';
    leftPanner.distanceModel = 'exponential';
    
    rightPanner = audioCtx.createPanner();
    rightPanner.panningModel = 'HRTF';
    rightPanner.distanceModel = 'exponential';

    // 4. Crossfeed Delay and Lowpass Filters (Simulating Head Shadowing)
    leftToRightDelay = audioCtx.createDelay(0.01);
    leftToRightFilter = audioCtx.createBiquadFilter();
    leftToRightFilter.type = 'lowpass';
    leftToRightFilter.frequency.value = 750; // Head shadow frequency cutoff
    leftToRightGain = audioCtx.createGain();
    leftToRightGain.gain.value = dspParams.crossfeed * 0.35; // attenuation

    rightToLeftDelay = audioCtx.createDelay(0.01);
    rightToLeftFilter = audioCtx.createBiquadFilter();
    rightToLeftFilter.type = 'lowpass';
    rightToLeftFilter.frequency.value = 750;
    rightToLeftGain = audioCtx.createGain();
    rightToLeftGain.gain.value = dspParams.crossfeed * 0.35;

    // Crossfeed Delays (Typical head width time difference ~ 270 microseconds)
    leftToRightDelay.delayTime.value = 0.00027;
    rightToLeftDelay.delayTime.value = 0.00027;

    // 5. Bass LFE Crossover (Bypasses panners to keep sub-bass centered/mono and punchy)
    bassFilter = audioCtx.createBiquadFilter();
    bassFilter.type = 'lowpass';
    bassFilter.frequency.value = 120; // LFE crossover
    bassGain = audioCtx.createGain();
    bassGain.gain.value = dspParams.bassBoost * 1.5;

    // 6. Vocal Presence Peaking Equalizer
    vocalFilter = audioCtx.createBiquadFilter();
    vocalFilter.type = 'peaking';
    vocalFilter.frequency.value = 2800; // Human vocal presence frequency
    vocalFilter.Q.value = 1.0;
    vocalFilter.gain.value = dspParams.vocalClarity * 6.0; // max +6dB boost

    // 7. Room Convolver Reverb Simulation
    roomConvolver = audioCtx.createConvolver();
    roomConvolver.buffer = createRoomImpulseResponse(audioCtx, 1.8, 2.5);
    roomGain = audioCtx.createGain();
    roomGain.gain.value = dspParams.roomWet * 0.4;

    // 8. Output Chain & Analyser
    finalGain = audioCtx.createGain();
    finalGain.gain.value = 1.0;
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 512;

    // -------------------------------------------------------------
    // AUDIO NODE CONNECTIONS GRAPH
    // -------------------------------------------------------------
    //
    //              [Media Source]
    //                    |
    //           +--------+--------+
    //           | (Splitter)      | (Bass Crossover Bypass)
    //           |                 v
    //       L   v   R        [bassFilter]
    //      [Ch0]   [Ch1]          |
    //        |       |        [bassGain]
    //        |       |            |
    //        |       +----+       |
    //        | (Crossfeed)|       |
    //        |            v       |
    //        |        [R->L delay]|
    //        |        [R->L filter]|
    //        |        [R->L gain] |
    //        |            |       |
    //        v            v       |
    //    [leftGain]  [rightGain]  |
    //        |            |       |
    //        v            v       |
    //   [leftPanner] [rightPanner]|
    //        +-----+------+       |
    //              |              |
    //              v              |
    //        [vocalFilter]        |
    //        +-----+------+       |
    //        |            |       |
    //        |      (Reverb)      |
    //        |            v       |
    //        |     [roomConvolver]|
    //        |     [roomGain]     |
    //        |            |       |
    //        v            v       v
    //     +--+------------+-------+
    //     |
    //     v
    // [finalGain] -> [analyserNode] -> [Speaker Output]
    //
    // -------------------------------------------------------------

    // Crossover bass connections
    bassFilter.connect(bassGain);
    bassGain.connect(finalGain); // Direct mono low bass to final mix

    // Connect default audio source
    connectInputSource(audioSource);

    // Left channel connections
    channelSplitter.connect(leftGain, 0); // L direct
    channelSplitter.connect(leftToRightDelay, 0); // L into R crossfeed
    leftToRightDelay.connect(leftToRightFilter);
    leftToRightFilter.connect(leftToRightGain);
    leftToRightGain.connect(rightGain); // Inject into Right channel mixer

    // Right channel connections
    channelSplitter.connect(rightGain, 1); // R direct
    channelSplitter.connect(rightToLeftDelay, 1); // R into L crossfeed
    rightToLeftDelay.connect(rightToLeftFilter);
    rightToLeftFilter.connect(rightToLeftGain);
    rightToLeftGain.connect(leftGain); // Inject into Left channel mixer

    // Mixers to Panners
    leftGain.connect(leftPanner);
    rightGain.connect(rightPanner);

    // Panners to Vocal EQ Filter
    leftPanner.connect(vocalFilter);
    rightPanner.connect(vocalFilter);

    // Vocal Filter to output & reverb
    vocalFilter.connect(finalGain);
    vocalFilter.connect(roomConvolver);
    roomConvolver.connect(roomGain);
    roomGain.connect(finalGain);

    // Final output chain
    finalGain.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);

    // Set initial positions of panners
    updateSpatializerPanners();

    // Start Visualizer
    startOutputVisualizer();
}

// Generate algorithmic Room Impulse Response Buffer
function createRoomImpulseResponse(context, duration, decay) {
    const sampleRate = context.sampleRate;
    const length = sampleRate * duration;
    const impulse = context.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
        const percent = i / length;
        const decayEnvelope = Math.pow(1 - percent, decay);
        // Discrete reflections programmatically added for realistic room depth
        const reflection = (i % 2400 === 0) ? 0.25 * (1 - percent) : 0;
        
        // Slightly decorrelate left and right phases for wide stereo room feel
        left[i] = ((Math.random() * 2 - 1) * decayEnvelope * 0.6) + reflection;
        right[i] = ((Math.random() * 2 - 1) * decayEnvelope * 0.6) - reflection;
    }
    return impulse;
}

// Update Panner nodes positions based on speakerPositions coordinates
function updateSpatializerPanners() {
    if (!leftPanner || !rightPanner) return;

    const now = audioCtx.currentTime;
    
    // Scale coordinate values for PannerNode coordinates
    // We map:
    // Left Speaker X coordinate -> leftPanner positionX
    // Left Speaker Y (represents distance) -> leftPanner positionZ (negative is in front)
    const scale = 5.0; // Distance scale
    
    const lx = speakerPositions.L.x * scale;
    const lz = speakerPositions.L.y * scale; // Mapping 2D Y to 3D Z coordinate
    
    const rx = speakerPositions.R.x * scale;
    const rz = speakerPositions.R.y * scale;

    // Use setPosition or positionX.setValueAtTime for modern standard
    if (leftPanner.positionX) {
        leftPanner.positionX.setTargetAtTime(lx, now, 0.05);
        leftPanner.positionY.setTargetAtTime(0, now, 0.05);
        leftPanner.positionZ.setTargetAtTime(lz, now, 0.05);

        rightPanner.positionX.setTargetAtTime(rx, now, 0.05);
        rightPanner.positionY.setTargetAtTime(0, now, 0.05);
        rightPanner.positionZ.setTargetAtTime(rz, now, 0.05);
    } else {
        // Fallback for older browsers
        leftPanner.setPosition(lx, 0, lz);
        rightPanner.setPosition(rx, 0, rz);
    }
}

// Toggle spatial bypass
function toggleSpatialBypass(bypass) {
    spatialBypassed = bypass;
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    if (spatialBypassed) {
        // Flat standard bypass - mute spatial paths and feed straight to final
        // For bypass:
        // Set crossfeed gain, room gain, and panner positions to bypass/flat state
        leftToRightGain.gain.setTargetAtTime(0, now, 0.01);
        rightToLeftGain.gain.setTargetAtTime(0, now, 0.01);
        roomGain.gain.setTargetAtTime(0, now, 0.01);
        bassGain.gain.setTargetAtTime(0, now, 0.01);
        vocalFilter.gain.setTargetAtTime(0, now, 0.01);

        // Position speakers directly left/right flat stereo (infinite width)
        if (leftPanner.positionX) {
            leftPanner.positionX.setTargetAtTime(-3.0, now, 0.01);
            leftPanner.positionZ.setTargetAtTime(0, now, 0.01);
            rightPanner.positionX.setTargetAtTime(3.0, now, 0.01);
            rightPanner.positionZ.setTargetAtTime(0, now, 0.01);
        }
    } else {
        // Restore active spatial settings
        leftToRightGain.gain.setTargetAtTime(dspParams.crossfeed * 0.35, now, 0.05);
        rightToLeftGain.gain.setTargetAtTime(dspParams.crossfeed * 0.35, now, 0.05);
        roomGain.gain.setTargetAtTime(dspParams.roomWet * 0.4, now, 0.05);
        bassGain.gain.setTargetAtTime(dspParams.bassBoost * 1.5, now, 0.05);
        vocalFilter.gain.setTargetAtTime(dspParams.vocalClarity * 6.0, now, 0.05);
        updateSpatializerPanners();
    }
}

// -------------------------------------------------------------
// Interactive Speaker Radar UI
// -------------------------------------------------------------
function initRadarCanvas() {
    radarCanvas = document.getElementById('radar-canvas');
    if (!radarCanvas) return;
    radarCtx = radarCanvas.getContext('2d');

    // Resize
    radarCanvas.width = 260;
    radarCanvas.height = 220;

    drawRadar();

    // Event listeners for dragging
    radarCanvas.addEventListener('mousedown', handleRadarMouseDown);
    radarCanvas.addEventListener('mousemove', handleRadarMouseMove);
    window.addEventListener('mouseup', handleRadarMouseUp);

    // Touch support
    radarCanvas.addEventListener('touchstart', handleRadarTouchStart, { passive: false });
    radarCanvas.addEventListener('touchmove', handleRadarTouchMove, { passive: false });
    window.addEventListener('touchend', handleRadarMouseUp);
}

function drawRadar() {
    if (!radarCtx) return;
    const w = radarCanvas.width;
    const h = radarCanvas.height;
    const cx = w / 2;
    const cy = h / 2 + 10; // Center listener slightly lower for better front display space

    radarCtx.clearRect(0, 0, w, h);

    // Draw concentric distance circles (Radar grid)
    radarCtx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    radarCtx.lineWidth = 1;
    for (let r = 40; r < 140; r += 40) {
        radarCtx.beginPath();
        radarCtx.arc(cx, cy, r, 0, Math.PI * 2);
        radarCtx.stroke();
    }

    // Radar crosshairs
    radarCtx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
    radarCtx.beginPath();
    radarCtx.moveTo(cx, 0); radarCtx.lineTo(cx, h);
    radarCtx.moveTo(0, cy); radarCtx.lineTo(w, cy);
    radarCtx.stroke();

    // Draw grid bounds
    radarCtx.strokeStyle = 'rgba(0, 240, 255, 0.06)';
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, 110, 0, Math.PI * 2);
    radarCtx.stroke();

    // Draw Listener head in center
    radarCtx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, 18, 0, Math.PI * 2); // Head
    radarCtx.fill();
    radarCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    radarCtx.lineWidth = 2;
    radarCtx.stroke();

    // Listener ears (indicators for stereo direction)
    radarCtx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    radarCtx.beginPath();
    radarCtx.arc(cx - 19, cy, 4, 0, Math.PI * 2); // Left ear
    radarCtx.arc(cx + 19, cy, 4, 0, Math.PI * 2); // Right ear
    radarCtx.fill();

    // Nose (showing forward face pointing up)
    radarCtx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    radarCtx.beginPath();
    radarCtx.moveTo(cx - 4, cy - 16);
    radarCtx.lineTo(cx, cy - 23);
    radarCtx.lineTo(cx + 4, cy - 16);
    radarCtx.closePath();
    radarCtx.fill();

    // Draw Speakers (L & R)
    drawSpeakerHandle('L', cx, cy);
    drawSpeakerHandle('R', cx, cy);
}

function drawSpeakerHandle(channel, cx, cy) {
    const pos = speakerPositions[channel];
    const maxRadius = 110;
    
    // Convert normalized coordinates to canvas pixels
    const px = cx + pos.x * maxRadius;
    const py = cy + pos.y * maxRadius;

    // Glow
    radarCtx.shadowBlur = 10;
    radarCtx.shadowColor = channel === 'L' ? 'rgba(0, 240, 255, 0.5)' : 'rgba(255, 0, 127, 0.5)';

    // Connector line to head
    radarCtx.strokeStyle = channel === 'L' ? 'rgba(0, 240, 255, 0.15)' : 'rgba(255, 0, 127, 0.15)';
    radarCtx.lineWidth = 1.5;
    radarCtx.beginPath();
    radarCtx.moveTo(cx, cy);
    radarCtx.lineTo(px, py);
    radarCtx.stroke();

    // Speaker Node body
    radarCtx.fillStyle = channel === 'L' ? 'var(--cyan-glow)' : 'var(--pink-glow)';
    radarCtx.beginPath();
    radarCtx.arc(px, py, 10, 0, Math.PI * 2);
    radarCtx.fill();

    // Speaker label letter
    radarCtx.shadowBlur = 0; // reset
    radarCtx.fillStyle = '#000000';
    radarCtx.font = 'bold 10px var(--font-mono)';
    radarCtx.textAlign = 'center';
    radarCtx.textBaseline = 'middle';
    radarCtx.fillText(channel, px, py);
}

// Convert screen mouse coordinates to normalized soundstage coordinates
function getNormalizedRadarCoords(clientX, clientY) {
    const rect = radarCanvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    
    const w = radarCanvas.width;
    const h = radarCanvas.height;
    const cx = w / 2;
    const cy = h / 2 + 10;
    
    const maxRadius = 110;

    // Normalized relative offset
    let nx = (mx - cx) / maxRadius;
    let ny = (my - cy) / maxRadius;

    // Limit distance to radar boundary radius (1.0 normalized)
    const dist = Math.sqrt(nx*nx + ny*ny);
    if (dist > 1.0) {
        nx /= dist;
        ny /= dist;
    }

    return { x: nx, y: ny };
}

// Mouse Handlers
function handleRadarMouseDown(e) {
    const coords = getNormalizedRadarCoords(e.clientX, e.clientY);
    
    // Check if clicked close to left or right speaker handle
    const distL = Math.hypot(coords.x - speakerPositions.L.x, coords.y - speakerPositions.L.y);
    const distR = Math.hypot(coords.x - speakerPositions.R.x, coords.y - speakerPositions.R.y);

    const clickThreshold = 0.18; // radius of grab hit box

    if (distL < clickThreshold && distL < distR) {
        activeSpeakerHandle = 'L';
        autoOrbitActive = false; // Disable auto orbit on user interaction
        document.getElementById('btn-auto-orbit').classList.remove('active');
    } else if (distR < clickThreshold) {
        activeSpeakerHandle = 'R';
        autoOrbitActive = false;
        document.getElementById('btn-auto-orbit').classList.remove('active');
    }
}

function handleRadarMouseMove(e) {
    if (!activeSpeakerHandle) return;

    const coords = getNormalizedRadarCoords(e.clientX, e.clientY);

    if (activeSpeakerHandle === 'L') {
        speakerPositions.L.x = coords.x;
        speakerPositions.L.y = coords.y;
        
        // Mirror right speaker symmetrically (symmetrical soundstage is standard)
        speakerPositions.R.x = -coords.x;
        speakerPositions.R.y = coords.y;
    } else if (activeSpeakerHandle === 'R') {
        speakerPositions.R.x = coords.x;
        speakerPositions.R.y = coords.y;

        // Mirror left speaker symmetrically
        speakerPositions.L.x = -coords.x;
        speakerPositions.L.y = coords.y;
    }

    drawRadar();
    if (!spatialBypassed) updateSpatializerPanners();
}

function handleRadarMouseUp() {
    activeSpeakerHandle = null;
}

// Touch Handlers
function handleRadarTouchStart(e) {
    if (e.touches.length === 0) return;
    e.preventDefault();
    const touch = e.touches[0];
    const coords = getNormalizedRadarCoords(touch.clientX, touch.clientY);

    const distL = Math.hypot(coords.x - speakerPositions.L.x, coords.y - speakerPositions.L.y);
    const distR = Math.hypot(coords.x - speakerPositions.R.x, coords.y - speakerPositions.R.y);

    const clickThreshold = 0.22;

    if (distL < clickThreshold && distL < distR) {
        activeSpeakerHandle = 'L';
        autoOrbitActive = false;
        document.getElementById('btn-auto-orbit').classList.remove('active');
    } else if (distR < clickThreshold) {
        activeSpeakerHandle = 'R';
        autoOrbitActive = false;
        document.getElementById('btn-auto-orbit').classList.remove('active');
    }
}

function handleRadarTouchMove(e) {
    if (!activeSpeakerHandle || e.touches.length === 0) return;
    e.preventDefault();
    const touch = e.touches[0];
    const coords = getNormalizedRadarCoords(touch.clientX, touch.clientY);

    if (activeSpeakerHandle === 'L') {
        speakerPositions.L.x = coords.x;
        speakerPositions.L.y = coords.y;
        speakerPositions.R.x = -coords.x;
        speakerPositions.R.y = coords.y;
    } else if (activeSpeakerHandle === 'R') {
        speakerPositions.R.x = coords.x;
        speakerPositions.R.y = coords.y;
        speakerPositions.L.x = -coords.x;
        speakerPositions.L.y = coords.y;
    }

    drawRadar();
    if (!spatialBypassed) updateSpatializerPanners();
}

// Auto Rotate/Orbit speakers around listener
function runSpeakerOrbitLoop() {
    if (!autoOrbitActive) return;

    orbitAngle += 0.008; // Orbit rotation speed

    // Radius representing current width of soundstage
    const widthRadius = Math.hypot(speakerPositions.R.x, speakerPositions.R.y);
    
    // Calculate new orbital positions
    speakerPositions.R.x = widthRadius * Math.cos(orbitAngle);
    speakerPositions.R.y = widthRadius * Math.sin(orbitAngle);

    // Left speaker is opposite ($180^\circ$ offset)
    speakerPositions.L.x = widthRadius * Math.cos(orbitAngle + Math.PI);
    speakerPositions.L.y = widthRadius * Math.sin(orbitAngle + Math.PI);

    drawRadar();
    if (!spatialBypassed) updateSpatializerPanners();

    requestAnimationFrame(runSpeakerOrbitLoop);
}

// -------------------------------------------------------------
// Real-Time Output Waveform/Bar Visualizer
// -------------------------------------------------------------
function startOutputVisualizer() {
    outputCanvas = document.getElementById('output-canvas');
    if (!outputCanvas) return;
    outputCtx = outputCanvas.getContext('2d');

    function resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = outputCanvas.getBoundingClientRect();
        outputCanvas.width = rect.width * dpr;
        outputCanvas.height = rect.height * dpr;
        outputCtx.scale(dpr, dpr);
    }
    resize();
    window.addEventListener('resize', resize);

    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
        drawVisualId = requestAnimationFrame(draw);

        const w = outputCanvas.width / (window.devicePixelRatio || 1);
        const h = outputCanvas.height / (window.devicePixelRatio || 1);

        outputCtx.fillStyle = 'rgba(7, 7, 10, 0.25)';
        outputCtx.fillRect(0, 0, w, h);

        analyserNode.getByteFrequencyData(dataArray);

        // Draw frequency bars
        const barWidth = (w / bufferLength) * 2.2;
        let barHeight;
        let x = 0;

        outputCtx.shadowBlur = 6;
        
        for (let i = 0; i < bufferLength; i++) {
            barHeight = (dataArray[i] / 255) * h;
            
            // Gradients from Cyan to Pink
            const percent = i / bufferLength;
            outputCtx.fillStyle = `hsl(${(percent * 150) + 180 % 360}, 100%, 55%)`;
            outputCtx.shadowColor = `hsl(${(percent * 150) + 180 % 360}, 100%, 55%)`;

            outputCtx.fillRect(x, h - barHeight, barWidth - 1, barHeight);
            x += barWidth;
        }
        outputCtx.shadowBlur = 0;
    }
    draw();
}

// -------------------------------------------------------------
// UI Event Handlers
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    initRadarCanvas();

    // Initialize global DOM references
    audioElement = document.getElementById('audio-element');
    timelineSlider = document.getElementById('timeline-slider');
    btnPlayPause = document.getElementById('btn-play-pause');
    playIcon = document.getElementById('play-icon');
    pauseIcon = document.getElementById('pause-icon');

    // Toggle play/pause UI icon state
    function setPlayingState(isPlaying) {
        if (!playIcon || !pauseIcon) return;
        if (isPlaying) {
            playIcon.style.display = 'none';
            pauseIcon.style.display = 'block';
        } else {
            playIcon.style.display = 'block';
            pauseIcon.style.display = 'none';
        }
    }

    // Play/Pause button action handler
    btnPlayPause.addEventListener('click', () => {
        if (audioElement.src) {
            if (audioElement.paused) {
                audioElement.play();
                setPlayingState(true);
            } else {
                audioElement.pause();
                setPlayingState(false);
            }
        }
    });

    // Time progress sync handler
    audioElement.addEventListener('timeupdate', () => {
        if (!audioElement.duration || isCapturingSystemAudio) return;
        const progress = (audioElement.currentTime / audioElement.duration) * 100;
        timelineSlider.value = progress;
        document.getElementById('current-time').textContent = formatTime(audioElement.currentTime);
    });

    // Track total duration handler
    audioElement.addEventListener('loadedmetadata', () => {
        document.getElementById('total-duration').textContent = formatTime(audioElement.duration);
    });

    // Seek track timeline slider event
    timelineSlider.addEventListener('input', (e) => {
        if (!audioElement.duration || isCapturingSystemAudio) return;
        const seekTime = (parseFloat(e.target.value) / 100) * audioElement.duration;
        audioElement.currentTime = seekTime;
    });

    // Format seconds to MM:SS
    function formatTime(secs) {
        if (isNaN(secs)) return "0:00";
        const minutes = Math.floor(secs / 60);
        const seconds = Math.floor(secs % 60);
        return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    }

    // 1. File Upload Dropzone listeners (Multiple Files)
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');

    dropzone.addEventListener('click', () => fileInput.click());

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            handleAudioFiles(e.dataTransfer.files);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleAudioFiles(e.target.files);
        }
    });

    // Handle adding multiple files to the playlist
    function handleAudioFiles(files) {
        initSpatialEngine();
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }

        // If system audio is active, stop it first to play local files
        if (isCapturingSystemAudio) {
            stopSystemAudioCapture();
        }

        const startIndex = playlistQueue.length;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileURL = URL.createObjectURL(file);
            const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
            const format = file.type.split('/')[1]?.toUpperCase() || 'AUDIO';

            playlistQueue.push({
                file: file,
                name: file.name,
                url: fileURL,
                size: sizeMB,
                format: format
            });
        }

        renderPlaylist();

        // If nothing was playing, play the first added track
        if (currentTrackIndex === -1 && playlistQueue.length > 0) {
            playPlaylistTrack(startIndex);
        }
    }

    // Play specific track in the playlist queue
    function playPlaylistTrack(index) {
        if (index < 0 || index >= playlistQueue.length) return;

        // Disconnect capture stream if active
        if (isCapturingSystemAudio) {
            stopSystemAudioCapture();
        }

        currentTrackIndex = index;
        const track = playlistQueue[index];

        // Load into audio tag
        audioElement.src = track.url;

        // Display Info
        document.getElementById('track-title').textContent = track.name;
        document.getElementById('track-status').textContent = `PLAYING [${index + 1}/${playlistQueue.length}]`;
        document.getElementById('track-details').textContent = `Format: ${track.format} | Size: ${track.size} MB`;

        // Enable UI Controls
        document.getElementById('timeline-slider').disabled = false;
        document.getElementById('btn-play-pause').disabled = false;

        audioElement.play();
        setPlayingState(true);
        updateActivePlaylistUI();
    }

    // Render playlist queue items to DOM
    function renderPlaylist() {
        const container = document.getElementById('playlist-queue-container');
        if (!container) return;

        container.innerHTML = '';

        if (playlistQueue.length === 0) {
            container.innerHTML = '<div class="playlist-empty-state">Queue is empty. Drag files above to start.</div>';
            return;
        }

        playlistQueue.forEach((track, index) => {
            const item = document.createElement('div');
            item.className = 'playlist-item';
            if (index === currentTrackIndex) {
                item.classList.add('active');
            }

            const info = document.createElement('div');
            info.className = 'playlist-item-info';

            const idx = document.createElement('span');
            idx.className = 'playlist-item-index';
            idx.textContent = index + 1;

            const title = document.createElement('span');
            title.className = 'playlist-item-title';
            title.textContent = track.name;
            title.title = track.name;

            const badge = document.createElement('span');
            badge.className = 'playlist-item-badge';
            badge.textContent = track.format;

            info.appendChild(idx);
            info.appendChild(title);
            info.appendChild(badge);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'playlist-item-remove';
            removeBtn.title = "Remove track";
            removeBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
                </svg>
            `;

            // Prevent item click event on remove button click
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removePlaylistTrack(index);
            });

            item.appendChild(info);
            item.appendChild(removeBtn);

            item.addEventListener('click', () => {
                playPlaylistTrack(index);
            });

            container.appendChild(item);
        });
    }

    function updateActivePlaylistUI() {
        const items = document.querySelectorAll('.playlist-item');
        items.forEach((item, index) => {
            item.classList.toggle('active', index === currentTrackIndex);
        });
    }

    function removePlaylistTrack(index) {
        // Free memory URL
        URL.revokeObjectURL(playlistQueue[index].url);
        playlistQueue.splice(index, 1);

        if (playlistQueue.length === 0) {
            currentTrackIndex = -1;
            audioElement.src = '';
            document.getElementById('track-title').textContent = "Select or drag an audio file above";
            document.getElementById('track-status').textContent = "NO TRACK LOADED";
            document.getElementById('track-details').textContent = "Format: -- | Size: --";
            document.getElementById('timeline-slider').disabled = true;
            document.getElementById('btn-play-pause').disabled = true;
            setPlayingState(false);
        } else if (index === currentTrackIndex) {
            // If we removed the playing track, skip to next or first
            const nextIndex = index >= playlistQueue.length ? 0 : index;
            playPlaylistTrack(nextIndex);
        } else if (index < currentTrackIndex) {
            // Shift index back
            currentTrackIndex--;
        }

        renderPlaylist();
    }

    // Clear entire playlist
    document.getElementById('btn-clear-playlist').addEventListener('click', () => {
        playlistQueue.forEach(track => URL.revokeObjectURL(track.url));
        playlistQueue = [];
        currentTrackIndex = -1;
        audioElement.src = '';
        document.getElementById('track-title').textContent = "Select or drag an audio file above";
        document.getElementById('track-status').textContent = "NO TRACK LOADED";
        document.getElementById('track-details').textContent = "Format: -- | Size: --";
        document.getElementById('timeline-slider').disabled = true;
        document.getElementById('btn-play-pause').disabled = true;
        setPlayingState(false);
        renderPlaylist();
    });

    // Automatically advance to the next track when a song ends
    audioElement.addEventListener('ended', () => {
        if (currentTrackIndex !== -1 && currentTrackIndex + 1 < playlistQueue.length) {
            playPlaylistTrack(currentTrackIndex + 1);
        } else {
            setPlayingState(false);
        }
    });

    // 2. System Audio Loopback Capture Handler
    const btnCaptureAudio = document.getElementById('btn-capture-audio');
    
    btnCaptureAudio.addEventListener('click', async () => {
        if (isCapturingSystemAudio) {
            stopSystemAudioCapture();
        } else {
            await startSystemAudioCapture();
        }
    });

    async function startSystemAudioCapture() {
        // Check if page is loaded directly via file://
        if (window.location.protocol === 'file:') {
            alert("System audio capture is not supported when opening HTML files directly via file://.\n\nPlease host this site on a local web server (e.g., XAMPP Apache) and access it via http://localhost/ or http://127.0.0.1/.");
            return;
        }

        // Check for Secure Context requirement (HTTPS or localhost)
        if (!window.isSecureContext) {
            alert("System audio capture requires a Secure Context.\n\nPlease access the page via http://localhost/ or http://127.0.0.1/, or set up HTTPS if you are accessing it via a custom domain or over the network.");
            return;
        }

        // Check if getDisplayMedia is supported/exposed by the browser
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            alert("Your browser does not support display media capture, or it has disabled it. If you are in private/incognito mode, some permission features might be restricted.");
            return;
        }

        try {
            // Request display media stream with audio capture
            captureStream = await navigator.mediaDevices.getDisplayMedia({
                video: true, // video track is mandatory for getDisplayMedia in standard specs
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    suppressLocalAudioPlayback: true
                }
            });

            const audioTracks = captureStream.getAudioTracks();
            if (audioTracks.length === 0) {
                // User didn't share system audio
                alert("No audio track detected. Please make sure to select a tab or screen and check the 'Share audio' or 'Share tab audio' checkbox at the bottom of the browser prompt.");
                stopSystemAudioCapture();
                return;
            }

            initSpatialEngine();
            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }

            // Pause local music player
            audioElement.pause();
            setPlayingState(false);

            // Create media stream source node
            deviceAudioSourceNode = audioCtx.createMediaStreamSource(captureStream);
            
            // Connect to spatial processor, bypassing standard file source
            connectInputSource(deviceAudioSourceNode);

            // Update state
            isCapturingSystemAudio = true;
            btnCaptureAudio.classList.add('active');
            btnCaptureAudio.querySelector('.btn-text').textContent = "Capturing System Audio (Active)";

            // Update Track Info Panels
            document.getElementById('track-title').textContent = "External Device/System Audio Stream";
            document.getElementById('track-status').textContent = "STREAMING SYSTEM AUDIO";
            document.getElementById('track-details').textContent = "Capturing active browser tab or window sound output";
            document.getElementById('timeline-slider').disabled = true;
            document.getElementById('btn-play-pause').disabled = true;

            // Handle when screen share ends from browser UI ("Stop Sharing" bar)
            audioTracks[0].onended = () => {
                stopSystemAudioCapture();
            };

        } catch (err) {
            console.error("System audio capture failed:", err);
            alert("Could not start device audio capture.\n\nError details: " + err.name + " - " + err.message + "\n\nCommon reasons:\n1. The browser sharing dialog was cancelled.\n2. The page is not being served over a secure origin (http://localhost or HTTPS).\n3. You did not check 'Share audio' (or 'Share tab audio') in the sharing dialog.");
            stopSystemAudioCapture();
        }
    }

    function stopSystemAudioCapture() {
        isCapturingSystemAudio = false;
        btnCaptureAudio.classList.remove('active');
        btnCaptureAudio.querySelector('.btn-text').textContent = "Capture Other Device Audio (System Loopback)";

        if (captureStream) {
            captureStream.getTracks().forEach(track => track.stop());
            captureStream = null;
        }

        if (audioCtx) {
            // Reconnect the local file player source back to processor inputs
            connectInputSource(audioSource);
        }

        // Restore track UI
        if (currentTrackIndex !== -1 && currentTrackIndex < playlistQueue.length) {
            const track = playlistQueue[currentTrackIndex];
            document.getElementById('track-title').textContent = track.name;
            document.getElementById('track-status').textContent = `PLAYING [${currentTrackIndex + 1}/${playlistQueue.length}]`;
            document.getElementById('track-details').textContent = `Format: ${track.format} | Size: ${track.size} MB`;
            document.getElementById('timeline-slider').disabled = false;
            document.getElementById('btn-play-pause').disabled = false;
        } else {
            document.getElementById('track-title').textContent = "Select or drag an audio file above";
            document.getElementById('track-status').textContent = "NO TRACK LOADED";
            document.getElementById('track-details').textContent = "Format: -- | Size: --";
        }
    }



    // 4. Room Environment Presets Loader
    const presetButtons = document.querySelectorAll('.preset-btn');
    presetButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            presetButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyRoomPreset(btn.dataset.preset);
        });
    });

    const presets = {
        studio: { roomWet: 0.10, crossfeed: 0.50, bassBoost: 0.15, vocalClarity: 0.20 },
        cinema: { roomWet: 0.35, crossfeed: 0.30, bassBoost: 0.55, vocalClarity: 0.40 },
        cathedral: { roomWet: 0.65, crossfeed: 0.20, bassBoost: 0.30, vocalClarity: 0.10 },
        outerspace: { roomWet: 0.85, crossfeed: 0.05, bassBoost: 0.40, vocalClarity: 0.0 }
    };

    function applyRoomPreset(presetName) {
        const config = presets[presetName];
        if (!config) return;

        dspParams.preset = presetName;
        Object.assign(dspParams, config);

        // Update Slider DOM Values
        document.getElementById('slider-room-wet').value = config.roomWet;
        document.getElementById('val-room-wet').textContent = `${Math.round(config.roomWet * 100)}%`;

        document.getElementById('slider-crossfeed').value = config.crossfeed;
        document.getElementById('val-crossfeed').textContent = `${Math.round(config.crossfeed * 100)}%`;

        document.getElementById('slider-bass-boost').value = config.bassBoost;
        document.getElementById('val-bass-boost').textContent = `${Math.round(config.bassBoost * 100)}%`;

        document.getElementById('slider-vocal-clarity').value = config.vocalClarity;
        document.getElementById('val-vocal-clarity').textContent = `${Math.round(config.vocalClarity * 100)}%`;

        // Update Audio Nodes
        if (audioCtx) {
            const now = audioCtx.currentTime;
            
            // Reverb wet mix
            roomGain.gain.setTargetAtTime(config.roomWet * 0.4, now, 0.05);

            // Crossfeed Gains
            leftToRightGain.gain.setTargetAtTime(config.crossfeed * 0.35, now, 0.05);
            rightToLeftGain.gain.setTargetAtTime(config.crossfeed * 0.35, now, 0.05);

            // Bass Crossover boost
            bassGain.gain.setTargetAtTime(config.bassBoost * 1.5, now, 0.05);

            // Vocal peak gain
            vocalFilter.gain.setTargetAtTime(config.vocalClarity * 6.0, now, 0.05);
            
            // Generate a different impulse response decay based on room wetness
            const decay = 1.0 + (config.roomWet * 3.0);
            roomConvolver.buffer = createRoomImpulseResponse(audioCtx, 1.0 + config.roomWet * 2.0, decay);
        }
    }

    // 5. DSP Param Sliders listeners
    // Room Wetness
    const sliderRoomWet = document.getElementById('slider-room-wet');
    sliderRoomWet.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        dspParams.roomWet = val;
        document.getElementById('val-room-wet').textContent = `${Math.round(val * 100)}%`;
        if (audioCtx && !spatialBypassed) {
            roomGain.gain.setTargetAtTime(val * 0.4, audioCtx.currentTime, 0.05);
        }
    });

    // Crossfeed
    const sliderCrossfeed = document.getElementById('slider-crossfeed');
    sliderCrossfeed.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        dspParams.crossfeed = val;
        document.getElementById('val-crossfeed').textContent = `${Math.round(val * 100)}%`;
        if (audioCtx && !spatialBypassed) {
            leftToRightGain.gain.setTargetAtTime(val * 0.35, audioCtx.currentTime, 0.05);
            rightToLeftGain.gain.setTargetAtTime(val * 0.35, audioCtx.currentTime, 0.05);
        }
    });

    // Bass Boost
    const sliderBassBoost = document.getElementById('slider-bass-boost');
    sliderBassBoost.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        dspParams.bassBoost = val;
        document.getElementById('val-bass-boost').textContent = `${Math.round(val * 100)}%`;
        if (audioCtx && !spatialBypassed) {
            bassGain.gain.setTargetAtTime(val * 1.5, audioCtx.currentTime, 0.05);
        }
    });

    // Vocal Clarity
    const sliderVocalClarity = document.getElementById('slider-vocal-clarity');
    sliderVocalClarity.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        dspParams.vocalClarity = val;
        document.getElementById('val-vocal-clarity').textContent = `${Math.round(val * 100)}%`;
        if (audioCtx && !spatialBypassed) {
            vocalFilter.gain.setTargetAtTime(val * 6.0, audioCtx.currentTime, 0.05);
        }
    });

    // Reset Speaker Positions button
    document.getElementById('btn-reset-speakers').addEventListener('click', () => {
        autoOrbitActive = false;
        document.getElementById('btn-auto-orbit').classList.remove('active');
        
        speakerPositions.L.x = defaultPositions.L.x;
        speakerPositions.L.y = defaultPositions.L.y;
        speakerPositions.R.x = defaultPositions.R.x;
        speakerPositions.R.y = defaultPositions.R.y;
        
        drawRadar();
        if (!spatialBypassed) updateSpatializerPanners();
    });

    // Auto Rotate/Orbit button
    const btnAutoOrbit = document.getElementById('btn-auto-orbit');
    btnAutoOrbit.addEventListener('click', () => {
        autoOrbitActive = !autoOrbitActive;
        btnAutoOrbit.classList.toggle('active', autoOrbitActive);

        if (autoOrbitActive) {
            // Find current starting angle of speaker R to start smoothly
            orbitAngle = Math.atan2(speakerPositions.R.y, speakerPositions.R.x);
            runSpeakerOrbitLoop();
        }
    });
});
