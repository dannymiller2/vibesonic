/* -------------------------------------------------------------
 * VIBESYNTH - Interactive Synth Engine & Visualizer
 * ------------------------------------------------------------- */

// Note to Frequency mapping (Standard tuning A4 = 440Hz)
const NOTE_FREQS = {
    "C3": 130.81, "C#3": 138.59, "D3": 146.83, "D#3": 155.56, "E3": 164.81,
    "F3": 174.61, "F#3": 185.00, "G3": 196.00, "G#3": 207.65, "A3": 220.00,
    "A#3": 233.08, "B3": 246.94,
    "C4": 261.63, "C#4": 277.18, "D4": 293.66, "D#4": 311.13, "E4": 329.63,
    "F4": 349.23
};

// Computer Keyboard Mapping to Piano Key Elements
const KEY_MAP = {
    'a': 'C3', 'w': 'C#3', 's': 'D3', 'e': 'D#3', 'd': 'E3', 'f': 'F3', 't': 'F#3',
    'g': 'G3', 'y': 'G#3', 'h': 'A3', 'u': 'A#3', 'j': 'B3',
    'k': 'C4', 'o': 'C#4', 'l': 'D4', 'p': 'D#4', ';': 'E4', "'": 'F4'
};

// Application State
let audioCtx = null;
let masterGain = null;
let analyserNode = null;
let filterNode = null;
let delayNode = null;
let delayFeedback = null;
let reverbNode = null;
let reverbDryWet = null;

// Track active playing voices
const activeVoices = {};

// Synth parameters
const synthParams = {
    oscType: 'sine',
    detune: 0,
    envelope: {
        attack: 0.1,
        decay: 0.2,
        sustain: 0.7,
        release: 0.4
    },
    filter: {
        type: 'lowpass',
        cutoff: 20000,
        Q: 1.0
    },
    delay: {
        time: 0.3,
        feedback: 0.3
    },
    reverb: {
        mix: 0.0 // dry wet
    },
    volume: 0.7
};

// Visualizer State
let canvas, ctx;
let animationId;
let vizMode = 'oscilloscope'; // 'oscilloscope' or 'frequency'
let ripples = [];

// Initialize Web Audio API
function initAudio() {
    if (audioCtx) return;

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();

    // Nodes creation
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 1024;

    masterGain = audioCtx.createGain();
    masterGain.gain.value = synthParams.volume;

    filterNode = audioCtx.createBiquadFilter();
    filterNode.type = synthParams.filter.type;
    filterNode.frequency.value = synthParams.filter.cutoff;
    filterNode.Q.value = synthParams.filter.Q;

    // Delay Setup
    delayNode = audioCtx.createDelay(1.0);
    delayNode.delayTime.value = synthParams.delay.time;
    delayFeedback = audioCtx.createGain();
    delayFeedback.gain.value = synthParams.delay.feedback;

    // Connect delay loop
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);

    // Reverb Setup
    reverbNode = audioCtx.createConvolver();
    reverbNode.buffer = createReverbImpulseResponse(audioCtx, 2.5, 2.0);
    reverbDryWet = audioCtx.createGain();
    reverbDryWet.gain.value = synthParams.reverb.mix;

    // Connections:
    // Voices -> filterNode -> masterGain -> analyserNode -> destination
    //             |-> delayNode -> masterGain
    //             |-> reverbNode -> reverbDryWet -> masterGain
    
    filterNode.connect(masterGain);
    
    // Connect filter output to delay and reverb too
    filterNode.connect(delayNode);
    delayNode.connect(masterGain);

    filterNode.connect(reverbNode);
    reverbNode.connect(reverbDryWet);
    reverbDryWet.connect(masterGain);

    masterGain.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);

    // Update UI Status
    const statusText = document.getElementById('status-text');
    const indicator = document.querySelector('.status-indicator');
    if (statusText && indicator) {
        statusText.textContent = 'Audio engine initialized and active';
        indicator.classList.add('ready');
    }

    // Hide Prompt
    const prompt = document.getElementById('interaction-prompt');
    if (prompt) {
        prompt.style.opacity = '0';
        setTimeout(() => prompt.style.display = 'none', 300);
    }

    // Start Visualizer Rendering Loop
    startVisualizer();
}

// Generate algorithmic impulse response buffer for Reverb
function createReverbImpulseResponse(context, duration, decay) {
    const sampleRate = context.sampleRate;
    const length = sampleRate * duration;
    const impulse = context.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
        const percent = i / length;
        const decayEnvelope = Math.pow(1 - percent, decay);
        left[i] = (Math.random() * 2 - 1) * decayEnvelope;
        right[i] = (Math.random() * 2 - 1) * decayEnvelope;
    }
    return impulse;
}

// Synthesizer voice constructor
class SynthVoice {
    constructor(note, frequency) {
        this.note = note;
        this.frequency = frequency;

        // Base Oscillator
        this.osc1 = audioCtx.createOscillator();
        this.osc1.type = synthParams.oscType;
        this.osc1.frequency.value = frequency;
        
        // Sub/Detuned Oscillator for rich sound
        this.osc2 = audioCtx.createOscillator();
        this.osc2.type = synthParams.oscType;
        this.osc2.frequency.value = frequency;
        this.osc2.detune.value = synthParams.detune;

        // Amp Gain for Envelope
        this.gainNode = audioCtx.createGain();
        this.gainNode.gain.setValueAtTime(0, audioCtx.currentTime);

        // Connections
        this.osc1.connect(this.gainNode);
        this.osc2.connect(this.gainNode);
        this.gainNode.connect(filterNode);

        // Start
        this.osc1.start();
        this.osc2.start();
    }

    triggerAttack() {
        const now = audioCtx.currentTime;
        const attack = synthParams.envelope.attack;
        const decay = synthParams.envelope.decay;
        const sustain = synthParams.envelope.sustain;

        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
        
        // Attack
        this.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        // Decay & Sustain
        this.gainNode.gain.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), now + attack + decay);
    }

    triggerRelease() {
        const now = audioCtx.currentTime;
        const release = synthParams.envelope.release;

        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
        
        // Fade to zero
        this.gainNode.gain.exponentialRampToValueAtTime(0.0001, now + release);

        // Clean nodes
        const osc1Copy = this.osc1;
        const osc2Copy = this.osc2;
        const gainCopy = this.gainNode;
        setTimeout(() => {
            try {
                osc1Copy.stop();
                osc2Copy.stop();
                osc1Copy.disconnect();
                osc2Copy.disconnect();
                gainCopy.disconnect();
            } catch (e) {
                // Ignore if already cleaned
            }
        }, (release + 0.1) * 1000);
    }
}

// Play note
function playNote(note) {
    if (!audioCtx) initAudio();
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    const freq = NOTE_FREQS[note];
    if (!freq) return;

    // Prevent double triggering
    if (activeVoices[note]) {
        return;
    }

    const voice = new SynthVoice(note, freq);
    voice.triggerAttack();
    activeVoices[note] = voice;

    // Check tonic sol-fa song progress
    if (typeof checkSongProgress === 'function') {
        checkSongProgress(note);
    }

    // Keyboard styling trigger
    const keyEl = document.querySelector(`.piano-key[data-note="${note}"]`);
    if (keyEl) {
        keyEl.classList.add('active');
        // Add ripple at key position in visualizer
        triggerRipple(keyEl);
    }
}

// Stop note
function stopNote(note) {
    const voice = activeVoices[note];
    if (voice) {
        voice.triggerRelease();
        delete activeVoices[note];
    }

    const keyEl = document.querySelector(`.piano-key[data-note="${note}"]`);
    if (keyEl) {
        keyEl.classList.remove('active');
    }
}

// Visual ripple spawn
function triggerRipple(keyEl) {
    if (!canvas) return;
    const isBlack = keyEl.classList.contains('black');
    const rect = canvas.getBoundingClientRect();
    
    // Approximate horizontal offset based on key placement
    const keyboardEl = document.getElementById('piano-keyboard');
    const keyRect = keyEl.getBoundingClientRect();
    const relativeX = (keyRect.left + keyRect.width / 2) - rect.left;
    
    ripples.push({
        x: relativeX,
        y: canvas.height - 10,
        radius: 1,
        maxRadius: Math.random() * 80 + 60,
        opacity: 0.8,
        color: isBlack ? 'var(--pink-glow)' : 'var(--cyan-glow)',
        speed: Math.random() * 2 + 3
    });
}

// Visualizer Setup and Rendering Loop
function startVisualizer() {
    canvas = document.getElementById('visualizer-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    // Resize handling
    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
        animationId = requestAnimationFrame(draw);

        const width = canvas.width / (window.devicePixelRatio || 1);
        const height = canvas.height / (window.devicePixelRatio || 1);

        // Dark background sweep
        ctx.fillStyle = 'rgba(10, 10, 15, 0.2)';
        ctx.fillRect(0, 0, width, height);

        // Draw ripples
        ctx.lineWidth = 2;
        for (let i = ripples.length - 1; i >= 0; i--) {
            const ripple = ripples[i];
            ctx.strokeStyle = ripple.color;
            ctx.globalAlpha = ripple.opacity;
            ctx.beginPath();
            ctx.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
            ctx.stroke();

            ripple.radius += ripple.speed;
            ripple.opacity -= 0.015;
            ripple.y -= 1;

            if (ripple.opacity <= 0) {
                ripples.splice(i, 1);
            }
        }
        ctx.globalAlpha = 1.0; // Reset opacity

        if (vizMode === 'oscilloscope') {
            // OSCILLOSCOPE WAVEFORM DRAW
            analyserNode.getByteTimeDomainData(dataArray);

            ctx.lineWidth = 3;
            ctx.strokeStyle = '#00f0ff';
            ctx.shadowBlur = 10;
            ctx.shadowColor = 'rgba(0, 240, 255, 0.5)';
            ctx.beginPath();

            const sliceWidth = width / bufferLength;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i] / 128.0;
                const y = (v * height) / 2;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }

                x += sliceWidth;
            }

            ctx.lineTo(width, height / 2);
            ctx.stroke();
            
            // Add purple secondary trace
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#bd00ff';
            ctx.shadowBlur = 4;
            ctx.beginPath();
            x = 0;
            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i] / 128.0;
                const y = (v * height) / 2 + 5; // offset slightly
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
                x += sliceWidth;
            }
            ctx.stroke();
            ctx.shadowBlur = 0; // Reset shadow

        } else {
            // CIRCULAR FREQUENCY RING DRAW
            analyserNode.getByteFrequencyData(dataArray);

            const centerX = width / 2;
            const centerY = height / 2;
            const baseRadius = Math.min(width, height) * 0.22;
            
            ctx.shadowBlur = 8;
            ctx.shadowColor = 'rgba(255, 0, 127, 0.4)';

            const barCount = 64;
            for (let i = 0; i < barCount; i++) {
                const percent = i / barCount;
                const angle = percent * Math.PI * 2;
                const dataIndex = Math.floor(percent * (bufferLength / 3)); // Focus on lower-mid frequencies
                const value = dataArray[dataIndex] || 0;
                const barHeight = (value / 255) * 45;

                const innerX = centerX + Math.cos(angle) * baseRadius;
                const innerY = centerY + Math.sin(angle) * baseRadius;
                const outerX = centerX + Math.cos(angle) * (baseRadius + barHeight);
                const outerY = centerY + Math.sin(angle) * (baseRadius + barHeight);

                // Alternating colors
                ctx.strokeStyle = `hsl(${(percent * 360) + 280 % 360}, 100%, 60%)`;
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.moveTo(innerX, innerY);
                ctx.lineTo(outerX, outerY);
                ctx.stroke();
            }
            ctx.shadowBlur = 0;
        }
    }
    draw();
}

// UI Event Listeners and Setup
document.addEventListener('DOMContentLoaded', () => {
    // 1. Audio init trigger via visualizer prompt
    const prompt = document.getElementById('interaction-prompt');
    if (prompt) {
        prompt.addEventListener('click', () => {
            initAudio();
        });
    }

    // 2. Mouse/Touch events on piano keyboard
    const pianoKeyboard = document.getElementById('piano-keyboard');
    
    // Mouse Down
    pianoKeyboard.addEventListener('mousedown', (e) => {
        const key = e.target.closest('.piano-key');
        if (!key) return;
        const note = key.dataset.note;
        playNote(note);
        
        // Track key release on mouseup anywhere
        const handleMouseUp = () => {
            stopNote(note);
            window.removeEventListener('mouseup', handleMouseUp);
        };
        window.addEventListener('mouseup', handleMouseUp);
    });

    // Touch events for mobile compatibility
    pianoKeyboard.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const key = e.target.closest('.piano-key');
        if (!key) return;
        const note = key.dataset.note;
        playNote(note);
        
        const handleTouchEnd = () => {
            stopNote(note);
            window.removeEventListener('touchend', handleTouchEnd);
        };
        window.addEventListener('touchend', handleTouchEnd);
    }, { passive: false });

    // 3. Computer Keyboard Listeners
    window.addEventListener('keydown', (e) => {
        // Ignore inputs, textareas, etc.
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
        
        if (e.repeat) return; // Prevent continuous trigger
        
        const key = e.key.toLowerCase();
        const note = KEY_MAP[key];
        if (note) {
            playNote(note);
        }
    });

    window.addEventListener('keyup', (e) => {
        const key = e.key.toLowerCase();
        const note = KEY_MAP[key];
        if (note) {
            stopNote(note);
        }
    });

    // 4. Config & Sliders inputs
    // Waveform selector
    const oscButtons = document.querySelectorAll('.osc-btn');
    oscButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            oscButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            synthParams.oscType = btn.dataset.type;
        });
    });

    // Sub Detune Slider
    const sliderDetune = document.getElementById('slider-detune');
    const valDetune = document.getElementById('val-detune');
    sliderDetune.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        synthParams.detune = val;
        valDetune.textContent = `${val > 0 ? '+' : ''}${val} cents`;
    });

    // ADSR vertical sliders
    const adsrInputs = {
        attack: { slider: document.getElementById('slider-attack'), display: document.getElementById('val-attack'), suffix: 's' },
        decay: { slider: document.getElementById('slider-decay'), display: document.getElementById('val-decay'), suffix: 's' },
        sustain: { slider: document.getElementById('slider-sustain'), display: document.getElementById('val-sustain'), suffix: '%', multiplier: 100 },
        release: { slider: document.getElementById('slider-release'), display: document.getElementById('val-release'), suffix: 's' }
    };

    Object.keys(adsrInputs).forEach(key => {
        const item = adsrInputs[key];
        item.slider.addEventListener('input', (e) => {
            const rawVal = parseFloat(e.target.value);
            synthParams.envelope[key] = rawVal;
            
            // Format output values
            let displayVal = rawVal;
            if (item.multiplier) {
                displayVal = Math.round(rawVal * item.multiplier);
            } else {
                displayVal = rawVal.toFixed(2);
            }
            item.display.textContent = `${displayVal}${item.suffix}`;
        });
    });

    // Filter selectors and sliders
    const filterButtons = document.querySelectorAll('.filter-btn');
    filterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            filterButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            synthParams.filter.type = btn.dataset.type;
            if (filterNode) filterNode.type = synthParams.filter.type;
        });
    });

    const sliderCutoff = document.getElementById('slider-cutoff');
    const valCutoff = document.getElementById('val-cutoff');
    sliderCutoff.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        synthParams.filter.cutoff = val;
        valCutoff.textContent = `${val} Hz`;
        if (filterNode) {
            // AudioParam ramp curve to prevent clicks
            filterNode.frequency.setTargetAtTime(val, audioCtx.currentTime, 0.05);
        }
    });

    const sliderQ = document.getElementById('slider-q');
    const valQ = document.getElementById('val-q');
    sliderQ.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        synthParams.filter.Q = val;
        valQ.textContent = val.toFixed(1);
        if (filterNode) {
            filterNode.Q.setTargetAtTime(val, audioCtx.currentTime, 0.05);
        }
    });

    // FX Sliders
    const sliderDelayTime = document.getElementById('slider-delay-time');
    const valDelayTime = document.getElementById('val-delay-time');
    sliderDelayTime.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        synthParams.delay.time = val;
        valDelayTime.textContent = `${val.toFixed(1)}s`;
        if (delayNode) {
            delayNode.delayTime.setTargetAtTime(val, audioCtx.currentTime, 0.05);
        }
    });

    const sliderDelayFeedback = document.getElementById('slider-delay-feedback');
    const valDelayFeedback = document.getElementById('val-delay-feedback');
    sliderDelayFeedback.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        synthParams.delay.feedback = val;
        valDelayFeedback.textContent = `${Math.round(val * 100)}%`;
        if (delayFeedback) {
            delayFeedback.gain.setTargetAtTime(val, audioCtx.currentTime, 0.05);
        }
    });

    const sliderReverb = document.getElementById('slider-reverb');
    const valReverb = document.getElementById('val-reverb');
    sliderReverb.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        synthParams.reverb.mix = val;
        valReverb.textContent = val === 0 ? 'Off' : `${Math.round(val * 100)}%`;
        if (reverbDryWet) {
            reverbDryWet.gain.setTargetAtTime(val, audioCtx.currentTime, 0.05);
        }
    });

    // Master Volume
    const sliderVolume = document.getElementById('slider-master-volume');
    const valVolume = document.getElementById('val-master-volume');
    sliderVolume.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        synthParams.volume = val;
        valVolume.textContent = `${Math.round(val * 100)}%`;
        if (masterGain) {
            masterGain.gain.setTargetAtTime(val, audioCtx.currentTime, 0.05);
        }
    });

    // 5. Visualizer Mode switcher button
    const btnVizMode = document.getElementById('btn-viz-mode');
    const labelVizMode = document.getElementById('viz-mode-label');
    btnVizMode.addEventListener('click', () => {
        if (vizMode === 'oscilloscope') {
            vizMode = 'frequency';
            labelVizMode.textContent = 'Spectrogram';
        } else {
            vizMode = 'oscilloscope';
            labelVizMode.textContent = 'Oscilloscope';
        }
    });

    // 6. Preset Loaders helper
    function applyPreset(preset) {
        // Set Synth Params values
        synthParams.oscType = preset.oscType;
        synthParams.detune = preset.detune;
        Object.assign(synthParams.envelope, preset.envelope);
        Object.assign(synthParams.filter, preset.filter);
        Object.assign(synthParams.delay, preset.delay);
        Object.assign(synthParams.reverb, preset.reverb);

        // Update DOM selector buttons
        oscButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.type === preset.oscType);
        });

        filterButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.type === preset.filter.type);
        });

        // Set Slider Values and Labels programmatically
        sliderDetune.value = preset.detune;
        valDetune.textContent = `${preset.detune > 0 ? '+' : ''}${preset.detune} cents`;

        adsrInputs.attack.slider.value = preset.envelope.attack;
        adsrInputs.attack.display.textContent = `${preset.envelope.attack.toFixed(2)}s`;
        adsrInputs.decay.slider.value = preset.envelope.decay;
        adsrInputs.decay.display.textContent = `${preset.envelope.decay.toFixed(2)}s`;
        adsrInputs.sustain.slider.value = preset.envelope.sustain;
        adsrInputs.sustain.display.textContent = `${Math.round(preset.envelope.sustain * 100)}%`;
        adsrInputs.release.slider.value = preset.envelope.release;
        adsrInputs.release.display.textContent = `${preset.envelope.release.toFixed(2)}s`;

        sliderCutoff.value = preset.filter.cutoff;
        valCutoff.textContent = `${preset.filter.cutoff} Hz`;
        sliderQ.value = preset.filter.Q;
        valQ.textContent = preset.filter.Q.toFixed(1);

        sliderDelayTime.value = preset.delay.time;
        valDelayTime.textContent = `${preset.delay.time.toFixed(1)}s`;
        sliderDelayFeedback.value = preset.delay.feedback;
        valDelayFeedback.textContent = `${Math.round(preset.delay.feedback * 100)}%`;

        sliderReverb.value = preset.reverb.mix;
        valReverb.textContent = preset.reverb.mix === 0 ? 'Off' : `${Math.round(preset.reverb.mix * 100)}%`;

        // Update running Audio nodes if initialised
        if (audioCtx) {
            filterNode.type = preset.filter.type;
            filterNode.frequency.setValueAtTime(preset.filter.cutoff, audioCtx.currentTime);
            filterNode.Q.setValueAtTime(preset.filter.Q, audioCtx.currentTime);
            delayNode.delayTime.setValueAtTime(preset.delay.time, audioCtx.currentTime);
            delayFeedback.gain.setValueAtTime(preset.delay.feedback, audioCtx.currentTime);
            reverbDryWet.gain.setValueAtTime(preset.reverb.mix, audioCtx.currentTime);
        }
    }

    // Preset configurations
    const presets = {
        chill: {
            oscType: 'triangle',
            detune: -5,
            envelope: { attack: 0.35, decay: 0.4, sustain: 0.5, release: 0.8 },
            filter: { type: 'lowpass', cutoff: 800, Q: 1.0 },
            delay: { time: 0.4, feedback: 0.4 },
            reverb: { mix: 0.4 }
        },
        synthwave: {
            oscType: 'sawtooth',
            detune: 12,
            envelope: { attack: 0.08, decay: 0.25, sustain: 0.6, release: 0.3 },
            filter: { type: 'lowpass', cutoff: 2200, Q: 3.5 },
            delay: { time: 0.25, feedback: 0.25 },
            reverb: { mix: 0.2 }
        },
        space: {
            oscType: 'sine',
            detune: 0,
            envelope: { attack: 0.6, decay: 0.8, sustain: 0.8, release: 1.5 },
            filter: { type: 'bandpass', cutoff: 1200, Q: 0.8 },
            delay: { time: 0.6, feedback: 0.65 },
            reverb: { mix: 0.6 }
        }
    };

    document.getElementById('preset-chill').addEventListener('click', () => applyPreset(presets.chill));
    document.getElementById('preset-synthwave').addEventListener('click', () => applyPreset(presets.synthwave));
    document.getElementById('preset-space').addEventListener('click', () => applyPreset(presets.space));

    // Initialize Tonic Sol-fa Songboard
    initSolfaSongboard();
});

// -------------------------------------------------------------
// Tonic Sol-fa Songboard System
// -------------------------------------------------------------

// Notes mapping to Tonic Sol-fa syllable names
const NOTE_TO_SOLFA = {
    'C3': 'Do', 'C#3': 'De', 'D3': 'Re', 'D#3': 'Ri', 'E3': 'Mi',
    'F3': 'Fa', 'F#3': 'Fi', 'G3': 'Sol', 'G#3': 'Si', 'A3': 'La',
    'A#3': 'Li', 'B3': 'Ti',
    'C4': 'Do\'', 'C#4': 'De\'', 'D4': 'Re\'', 'D#4': 'Ri\'', 'E4': 'Mi\'',
    'F4': 'Fa\''
};

// Song Database
const SOLFA_SONGS = {
    twinkle: {
        name: "Twinkle Twinkle Little Star",
        notes: [
            'C3', 'C3', 'G3', 'G3', 'A3', 'A3', 'G3', 
            'F3', 'F3', 'E3', 'E3', 'D3', 'D3', 'C3', 
            'G3', 'G3', 'F3', 'F3', 'E3', 'E3', 'D3', 
            'G3', 'G3', 'F3', 'F3', 'E3', 'E3', 'D3', 
            'C3', 'C3', 'G3', 'G3', 'A3', 'A3', 'G3', 
            'F3', 'F3', 'E3', 'E3', 'D3', 'D3', 'C3'
        ]
    },
    mary: {
        name: "Mary Had a Little Lamb",
        notes: [
            'E3', 'D3', 'C3', 'D3', 'E3', 'E3', 'E3', 
            'D3', 'D3', 'D3', 'E3', 'G3', 'G3', 
            'E3', 'D3', 'C3', 'D3', 'E3', 'E3', 'E3', 
            'E3', 'D3', 'D3', 'E3', 'D3', 'C3'
        ]
    },
    'do-re-mi': {
        name: "Do-Re-Mi (Sound of Music)",
        notes: [
            'C3', 'D3', 'E3', 'C3', 'E3', 'C3', 'E3', 
            'D3', 'E3', 'F3', 'F3', 'E3', 'D3', 'F3', 
            'E3', 'F3', 'G3', 'E3', 'G3', 'E3', 'G3', 
            'F3', 'G3', 'A3', 'A3', 'G3', 'F3', 'A3', 
            'G3', 'C3', 'D3', 'E3', 'F3', 'G3', 'A3', 
            'A3', 'D3', 'E3', 'F#3', 'G3', 'A3', 'B3', 
            'B3', 'E3', 'F#3', 'G#3', 'A3', 'B3', 'C4', 
            'C4', 'B3', 'A3', 'F3', 'B3', 'G3', 'C4'
        ]
    },
    ode: {
        name: "Ode to Joy",
        notes: [
            'E3', 'E3', 'F3', 'G3', 'G3', 'F3', 'E3', 'D3', 
            'C3', 'C3', 'D3', 'E3', 'E3', 'D3', 'D3',
            'E3', 'E3', 'F3', 'G3', 'G3', 'F3', 'E3', 'D3', 
            'C3', 'C3', 'D3', 'E3', 'D3', 'C3', 'C3'
        ]
    }
};

// State
let currentSongId = 'twinkle';
let currentNoteIndex = 0;
let noteElements = [];

function initSolfaSongboard() {
    const selectEl = document.getElementById('solfa-song-select');
    const resetBtn = document.getElementById('btn-solfa-reset');

    if (selectEl) {
        selectEl.addEventListener('change', (e) => {
            currentSongId = e.target.value;
            loadSong(currentSongId);
        });
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            loadSong(currentSongId);
        });
    }

    // Initial load
    loadSong(currentSongId);
}

// Generate the key mapping representation helper
function getBindingKeyName(note) {
    // Find the computer keyboard key bound to this note
    for (const [key, val] of Object.entries(KEY_MAP)) {
        if (val === note) {
            return key.toUpperCase();
        }
    }
    return '?';
}

function loadSong(songId) {
    const song = SOLFA_SONGS[songId];
    if (!song) return;

    currentNoteIndex = 0;
    noteElements = [];

    const displayContainer = document.getElementById('solfa-song-display');
    if (!displayContainer) return;

    displayContainer.innerHTML = '';

    // Create note bubbles
    song.notes.forEach((note, index) => {
        const bubble = document.createElement('div');
        bubble.className = 'solfa-note-bubble';
        bubble.dataset.index = index;

        const syllable = document.createElement('span');
        syllable.className = 'solfa-syllable';
        syllable.textContent = NOTE_TO_SOLFA[note] || note;

        const binding = document.createElement('span');
        binding.className = 'solfa-binding';
        binding.textContent = getBindingKeyName(note);

        bubble.appendChild(syllable);
        bubble.appendChild(binding);
        displayContainer.appendChild(bubble);

        noteElements.push(bubble);
    });

    updateSongUI();
}

function updateSongUI() {
    const song = SOLFA_SONGS[currentSongId];
    if (!song) return;

    const displayContainer = document.getElementById('solfa-song-display');
    const hintSolfa = document.getElementById('next-solfa-hint');
    const hintKey = document.getElementById('next-key-hint');

    // Update classes of bubbles
    noteElements.forEach((el, index) => {
        el.classList.remove('active', 'completed');
        if (index < currentNoteIndex) {
            el.classList.add('completed');
        } else if (index === currentNoteIndex) {
            el.classList.add('active');
            // Scroll the active note into view
            if (displayContainer) {
                const containerRect = displayContainer.getBoundingClientRect();
                const elRect = el.getBoundingClientRect();
                if (elRect.bottom > containerRect.bottom || elRect.top < containerRect.top) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
        }
    });

    // Update hints
    if (currentNoteIndex < song.notes.length) {
        const nextNote = song.notes[currentNoteIndex];
        if (hintSolfa) hintSolfa.textContent = NOTE_TO_SOLFA[nextNote] || nextNote;
        if (hintKey) hintKey.textContent = getBindingKeyName(nextNote);
    } else {
        if (hintSolfa) hintSolfa.textContent = "Song Completed! 🎉";
        if (hintKey) hintKey.textContent = "RESET";
        
        // Spawn splash visualizer ripples for celebration!
        triggerCelebrationEffects();
    }
}

function checkSongProgress(playedNote) {
    const song = SOLFA_SONGS[currentSongId];
    if (!song) return;

    if (currentNoteIndex < song.notes.length) {
        const expectedNote = song.notes[currentNoteIndex];
        if (playedNote === expectedNote) {
            currentNoteIndex++;
            updateSongUI();
        }
    }
}

// Celebration effect: spawn random ripples radiating from visualizer center
function triggerCelebrationEffects() {
    if (!canvas) return;
    const colors = ['var(--cyan-glow)', 'var(--pink-glow)', 'var(--purple-glow)'];
    
    for (let i = 0; i < 6; i++) {
        setTimeout(() => {
            ripples.push({
                x: Math.random() * (canvas.width / (window.devicePixelRatio || 1)),
                y: Math.random() * ((canvas.height / (window.devicePixelRatio || 1)) - 60) + 40,
                radius: 1,
                maxRadius: Math.random() * 100 + 80,
                opacity: 0.9,
                color: colors[Math.floor(Math.random() * colors.length)],
                speed: Math.random() * 2 + 2
            });
        }, i * 200);
    }
}

