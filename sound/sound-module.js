/* sound/sound-module.js */

/**
 * Manages Web Audio API for synthesis, effects, analysis, and Arpeggiator.
 * Provides the core sound generation engine for the Maleficarum.
 */
export default class SoundModule {
    constructor(initialPresetName = 'vaporwave') {
        this.audioState = {
            isInitialized: false,
            isPlaying: false, // Tracks if any note (sustained or arp) is active
            audioContext: null,
            masterGain: null,
            analyser: null,
            // Main Synth Nodes (managed by note/arp handlers)
            currentOscillator: null,
            currentFilter: null,
            currentGainNode: null, // Envelope control
            activeNote: null,      // The base note name being held/arp'd ('C4')
            currentNoteFrequency: null, // Frequency of the last note played (for visuals)
            // Effect Nodes (persistent)
            delayNode: null,
            delayFeedback: null,
            reverbNode: null,
            reverbGain: null,
            // Arpeggiator State
            arp: {
                active: false,
                intervalId: null,
                rate: 8,            // Steps per second
                pattern: [0, 4, 7], // Semitone offsets
                currentStep: 0,
                baseNote: null,     // Base note name for the current arp sequence
            },
            // Parameters (will be updated by external calls & presets)
            parameters: {
                // Structure initialized by preset
                oscillator: {},
                filter: {},
                envelope: {},
                effects: {
                    delay: {},
                    reverb: {},
                    arpeggiator: {},
                    glitch: {} // Placeholder for glitch toggle state
                }
            },
            // Preset Data
            presets: this.getPresetsDefinition(),
            activePresetName: initialPresetName,
        };

        // Note Frequencies Map
        this.noteFrequencies = {
            'C4': 261.63, 'C#4': 277.18, 'D4': 293.66, 'D#4': 311.13, 'E4': 329.63,
            'F4': 349.23, 'F#4': 369.99, 'G4': 392.00, 'G#4': 415.30, 'A4': 440.00,
            'A#4': 466.16, 'B4': 493.88, 'C5': 523.25
            // Add more octaves if needed
        };
        this.semitoneRatio = Math.pow(2, 1/12);

        // Load initial parameters but defer AudioContext creation
        this.applyPresetAudio(initialPresetName);

        // Defer actual AudioContext initialization until user interaction
        this.initPromise = new Promise(resolve => { this.resolveInit = resolve; });
        this._addInteractionListener();
    }

    // --- Initialization ---
    _addInteractionListener() {
       if (typeof window !== 'undefined' && typeof document !== 'undefined') {
           const initAudio = async () => {
               // Double check if already initialized before proceeding
               if (this.audioState && !this.audioState.isInitialized) {
                   await this._initializeAudio();
               }
               // Clean up listeners regardless of init success/failure
                document.removeEventListener('click', initAudio, { capture: true, once: true });
                document.removeEventListener('keydown', initAudio, { capture: true, once: true });
                document.removeEventListener('touchstart', initAudio, { capture: true, once: true });
           };
           // Listen for first interaction
            document.addEventListener('click', initAudio, { capture: true, once: true });
            document.addEventListener('keydown', initAudio, { capture: true, once: true });
            document.addEventListener('touchstart', initAudio, { capture: true, once: true });
       } else {
           console.warn("SoundModule: Not in a browser environment, audio might not initialize.");
            if (this.resolveInit) this.resolveInit(false); // Assume failure
       }
   }

   async _initializeAudio() {
        // Prevent duplicate initialization
        if (this.audioState?.isInitialized) return true;
        // Ensure audioState exists before proceeding
        if (!this.audioState) {
            console.error("SoundModule: audioState is null during initialization attempt.");
            if (this.resolveInit) this.resolveInit(false);
            return false;
        }

       try {
           const AudioContext = window.AudioContext || window.webkitAudioContext;
           if (!AudioContext) {
                console.error("Web Audio API not supported.");
                this.resolveInit(false); return false;
           }
           this.audioState.audioContext = new AudioContext();

           // Attempt to resume if suspended
           if (this.audioState.audioContext.state === 'suspended') {
                await this.audioState.audioContext.resume();
           }

           this.audioState.masterGain = this.audioState.audioContext.createGain();
           this.audioState.masterGain.gain.value = 0.7; // Master volume
           this.audioState.masterGain.connect(this.audioState.audioContext.destination);

           this.audioState.analyser = this.audioState.audioContext.createAnalyser();
           this.audioState.analyser.fftSize = 512;
           this.audioState.analyser.smoothingTimeConstant = 0.8;
           // Connect analyser AFTER master gain to analyse the final output level
           this.audioState.masterGain.connect(this.audioState.analyser);

           this._createAudioEffects(); // Create persistent effect nodes

           this.audioState.isInitialized = true;
           console.log('Sound Module: Audio Initialized.');
           // Apply initial toggle states from parameters *after* init
           this._applyCurrentToggleStates();
           this.resolveInit(true);
           return true;

       } catch (error) {
           console.error('Sound Module: Error initializing audio:', error);
           if (this.audioState) this.audioState.isInitialized = false; // Ensure state reflects failure
           this.resolveInit(false);
           return false;
       }
   }

    // --- Effects Setup ---
    _createAudioEffects() {
        const ac = this.audioState.audioContext;
        if (!ac || !this.audioState.parameters?.effects) return;
        const params = this.audioState.parameters.effects;

        // Delay
        try {
            this.audioState.delayNode = ac.createDelay(2.0); // Max delay time
            this.audioState.delayFeedback = ac.createGain();
            this.audioState.delayNode.delayTime.setValueAtTime(params.delay?.time ?? 0.5, ac.currentTime);
            this.audioState.delayFeedback.gain.setValueAtTime(params.delay?.feedback ?? 0.4, ac.currentTime);

            this.audioState.delayNode.connect(this.audioState.delayFeedback);
            this.audioState.delayFeedback.connect(this.audioState.delayNode);
            // Delay output connects to master gain
            this.audioState.delayNode.connect(this.audioState.masterGain);
        } catch (e) { console.error("Error creating Delay nodes:", e); }

        // Reverb
        try {
            this.audioState.reverbNode = ac.createConvolver();
            this.audioState.reverbGain = ac.createGain(); // Wet control for reverb
            this._updateReverbImpulse(); // Generate initial impulse
            this.audioState.reverbGain.gain.setValueAtTime(params.reverb?.wet ?? 0.5, ac.currentTime);

            this.audioState.reverbNode.connect(this.audioState.reverbGain);
            // Reverb Gain output connects to master gain
            this.audioState.reverbGain.connect(this.audioState.masterGain);
        } catch (e) { console.error("Error creating Reverb nodes:", e); }
    }

    _updateReverbImpulse() {
        if (!this.audioState?.isInitialized || !this.audioState.reverbNode || !this.audioState.audioContext || !this.audioState.parameters?.effects?.reverb) {
            // console.warn("Cannot update reverb: Not ready or params missing.");
            return;
        }
        const ac = this.audioState.audioContext;
        const decay = this.audioState.parameters.effects.reverb.decay;
        const sampleRate = ac.sampleRate;
        // Ensure decay is positive and reasonable, calculate length in samples
        const validDecay = Math.max(0.01, decay || 2.0); // Default decay 2s
        const length = Math.max(sampleRate * 0.01, Math.min(sampleRate * 10, validDecay * sampleRate)); // Limit max length

        try {
            const impulse = ac.createBuffer(2, length, sampleRate);
            const left = impulse.getChannelData(0);
            const right = impulse.getChannelData(1);
            // Exponential decay noise
            for (let i = 0; i < length; i++) {
                const env = Math.exp(-i / (sampleRate * validDecay / 4)); // Adjust decay curve shape
                left[i] = (Math.random() * 2 - 1) * env;
                right[i] = (Math.random() * 2 - 1) * env;
            }
            this.audioState.reverbNode.buffer = impulse;
        } catch (e) {
           console.error("Error creating reverb impulse buffer:", e, "Length:", length, "Decay:", validDecay);
           // Assign null or a minimal buffer to prevent errors using the node
           try {
               this.audioState.reverbNode.buffer = ac.createBuffer(2, sampleRate * 0.01, sampleRate); // Minimal buffer
           } catch (bufferError) {
               console.error("Error creating fallback reverb buffer:", bufferError);
               this.audioState.reverbNode.buffer = null; // Last resort
           }
        }
    }

    // --- Note Handling ---
    async startNote(note) {
        const initialized = await this.initPromise;
        if (!this.audioState || !initialized || !this.noteFrequencies[note]) {
            console.warn(`SoundModule: Cannot start note ${note}. Not ready or note invalid.`);
            return;
        }
        const ac = this.audioState.audioContext;
        if (!ac || ac.state !== 'running') {
            console.warn(`SoundModule: AudioContext not running. State: ${ac?.state}`);
            return; // Don't proceed if context isn't running
        }

        this.audioState.activeNote = note; // Store the base note being pressed

        if (this.audioState.arp.active) {
            if (!this.audioState.isPlaying) { // Start arp if not already running
                this.audioState.arp.baseNote = note;
                this.audioState.arp.currentStep = 0;
                this._startArpeggiator();
                this.audioState.isPlaying = true;
            } else { // Arp running, just update base note
                this.audioState.arp.baseNote = note;
                // Option: Reset step? Current logic lets sequence continue with new base.
                // this.audioState.arp.currentStep = 0;
            }
        } else {
            this._stopSustainedNote(false); // Stop previous sustained note abruptly
            this._playSustainedNote(note); // Play new sustained note
            // isPlaying is set within _playSustainedNote
        }
    }

    stopNote(useRelease = true) {
        if (!this.audioState || !this.audioState.isPlaying) return; // Nothing to stop

        if (this.audioState.arp.active && this.audioState.arp.intervalId) {
            // Arpeggiator is ON and running: Stop the sequence
            this._stopArpeggiator();
        } else if (!this.audioState.arp.active && this.audioState.currentOscillator) {
            // Arpeggiator is OFF and a sustained note is playing: Stop it
            this._stopSustainedNote(useRelease);
        }

        this.audioState.isPlaying = false; // Mark main state as stopped
        this.audioState.activeNote = null; // Clear the held note name
        // Don't clear currentNoteFrequency here, let visualizer use the last played freq
    }

    // --- Internal Note Playing Methods ---
    _playSustainedNote(note) {
        const ac = this.audioState.audioContext;
        const params = this.audioState.parameters;
        const frequency = this.noteFrequencies[note];
        if (!frequency || !ac || !params || !params.oscillator || !params.filter || !params.envelope) {
            console.error(`SoundModule: Cannot play sustained note ${note}. Missing context or parameters.`);
            return false;
        }
        const now = ac.currentTime;

        try {
            // --- Create Nodes ---
            const osc = ac.createOscillator();
            const filter = ac.createBiquadFilter();
            const gainNode = ac.createGain(); // Envelope control

            osc.type = params.oscillator.type || 'sine';
            osc.frequency.setValueAtTime(frequency, now);

            filter.type = params.filter.type || 'lowpass';
            // Clamp values to prevent errors
            filter.frequency.setValueAtTime(Math.max(10, Math.min(ac.sampleRate / 2, params.filter.frequency || 1000)), now);
            filter.Q.setValueAtTime(Math.max(0.0001, params.filter.Q || 1), now);

            // --- Envelope Attack ---
            gainNode.gain.setValueAtTime(0, now); // Start at zero
            const attackTime = Math.max(0.001, params.envelope.attack || 0.01); // Ensure positive time
            const targetGain = Math.max(0, Math.min(1, params.oscillator.gain || 0.5)); // Clamp gain
            gainNode.gain.linearRampToValueAtTime(targetGain, now + attackTime);

            // --- Connections ---
            // Source -> Filter -> Envelope Gain -> Master Gain
            osc.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(this.audioState.masterGain);
            // Connect envelope gain output to active effects
            this._connectEffectsToNode(gainNode);

            // --- Store References & State ---
            this.audioState.currentOscillator = osc;
            this.audioState.currentFilter = filter;
            this.audioState.currentGainNode = gainNode;
            this.audioState.isPlaying = true; // Mark as playing NOW
            this.audioState.currentNoteFrequency = frequency; // Update last played frequency

            osc.start(now);
            return true;
        } catch (e) {
            console.error(`SoundModule: Error creating sustained note ${note}:`, e);
            this._cleanupCurrentNoteNodes(); // Clean up on failure
            this.audioState.isPlaying = false;
            this.audioState.currentNoteFrequency = null;
            return false;
        }
    }

    _stopSustainedNote(useRelease = true) {
        if (!this.audioState?.currentOscillator || !this.audioState.currentGainNode || !this.audioState.audioContext) {
            // console.warn("Attempted to stop note, but nodes are missing.");
            return;
        }

        const ac = this.audioState.audioContext;
        const params = this.audioState.parameters;
        const now = ac.currentTime;
        const gainParam = this.audioState.currentGainNode.gain;
        const currentOsc = this.audioState.currentOscillator; // Reference before cleanup
        const releaseTime = Math.max(0.005, params.envelope?.release || 0.5); // Ensure minimum release

        try {
            gainParam.cancelScheduledValues(now); // Stop any ongoing ramps (like attack)
            // Explicitly set value before starting release ramp for reliability
            gainParam.setValueAtTime(gainParam.value, now);

            if (useRelease && releaseTime > 0.005) {
                gainParam.linearRampToValueAtTime(0, now + releaseTime);
                currentOsc.stop(now + releaseTime + 0.1); // Schedule stop after release
            } else {
                gainParam.linearRampToValueAtTime(0, now + 0.005); // Very quick fade
                currentOsc.stop(now + 0.01);
            }
        } catch (e) {
            console.error("Error scheduling note stop/release:", e);
            // Attempt immediate stop as fallback
            try { currentOsc.stop(now); } catch(stopErr) { /* Ignore */ }
        }

        // Schedule cleanup slightly after the oscillator is supposed to stop
        const cleanupDelay = (useRelease ? releaseTime + 0.15 : 0.05) * 1000; // ms
        setTimeout(() => {
             // Check if these are still the nodes we intended to clean up
             if (this.audioState?.currentOscillator === currentOsc) {
                 this._cleanupCurrentNoteNodes();
             }
         }, Math.max(50, cleanupDelay)); // Ensure minimum delay

        // Note: isPlaying and activeNote are typically cleared in the calling stopNote() function
    }

    _playArpNote(frequency) {
        const ac = this.audioState.audioContext;
        const params = this.audioState.parameters;
        if (!this.audioState || !frequency || !ac || !params || !params.oscillator || !params.filter || !params.envelope) {
            console.error(`SoundModule: Cannot play arp note. Missing context or parameters.`);
            return;
        }
        const now = ac.currentTime;

        // --- Calculate Timing ---
        const rate = Math.max(0.1, this.audioState.arp.rate || 8);
        const stepDuration = 1.0 / rate;
        // Ensure note duration is positive and slightly less than step duration for separation
        const noteDuration = Math.max(0.01, stepDuration * 0.8);
        // Short release within the note's duration
        const arpReleaseTime = Math.min(0.05, Math.max(0.005, stepDuration * 0.1));

        // --- Stop Previous Arp Note ---
        // Stop previous oscillator immediately for clear articulation
        if (this.audioState.currentOscillator) {
            try {
                // Don't use release envelope for previous arp notes, just cut them
                this.audioState.currentOscillator.stop(now);
                this._cleanupCurrentNoteNodes(); // Clean up previous nodes now
            } catch(e) { /* ignore errors stopping already stopped osc */ }
        }

        try {
            // --- Create New Nodes ---
            const osc = ac.createOscillator();
            const filter = ac.createBiquadFilter();
            const gainNode = ac.createGain(); // Envelope for THIS arp note

            osc.type = params.oscillator.type || 'sine';
            osc.frequency.setValueAtTime(frequency, now);

            filter.type = params.filter.type || 'lowpass';
            filter.frequency.setValueAtTime(Math.max(10, Math.min(ac.sampleRate / 2, params.filter.frequency || 1000)), now);
            filter.Q.setValueAtTime(Math.max(0.0001, params.filter.Q || 1), now);

            // --- Short Envelope ---
            gainNode.gain.setValueAtTime(0, now);
            const attackTime = Math.min(0.01, stepDuration * 0.1); // Very short attack
            const targetGain = Math.max(0, Math.min(1, params.oscillator.gain || 0.5));
            gainNode.gain.linearRampToValueAtTime(targetGain, now + attackTime);
            // Hold gain until release starts
            gainNode.gain.setValueAtTime(targetGain, Math.max(now + attackTime, now + noteDuration - arpReleaseTime));
            // Release ramp to zero at the end of noteDuration
            gainNode.gain.linearRampToValueAtTime(0, now + noteDuration);

            // --- Connections ---
            osc.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(this.audioState.masterGain);
            this._connectEffectsToNode(gainNode);

            // --- Store Refs & State ---
            this.audioState.currentOscillator = osc;
            this.audioState.currentFilter = filter;
            this.audioState.currentGainNode = gainNode;
            this.audioState.currentNoteFrequency = frequency; // Update last played frequency

            osc.start(now);
            osc.stop(now + noteDuration + 0.1); // Schedule stop after envelope ends

            // Auto-cleanup is handled by the next arp step or stopArpeggiator

        } catch (e) {
            console.error(`SoundModule: Error playing arp note (${frequency.toFixed(2)} Hz):`, e);
            this._cleanupCurrentNoteNodes(); // Clean up failed attempt
            this.audioState.currentNoteFrequency = null;
        }
    }

    _cleanupCurrentNoteNodes() {
        if (!this.audioState) return;
        // Use try/catch for disconnect errors
        if(this.audioState.currentOscillator) {
            try { this.audioState.currentOscillator.disconnect(); } catch(e){}
            // Note: Oscillator stop() is usually handled by the release envelope logic
            this.audioState.currentOscillator = null;
        }
        if(this.audioState.currentFilter) {
             try { this.audioState.currentFilter.disconnect(); } catch(e){}
            this.audioState.currentFilter = null;
        }
        if(this.audioState.currentGainNode) {
             try { this.audioState.currentGainNode.disconnect(); } catch(e){}
            this.audioState.currentGainNode = null;
        }
    }

    // --- Arpeggiator Control ---
    _startArpeggiator() {
        if (!this.audioState?.isInitialized || this.audioState.arp.intervalId || !this.audioState.arp.active) return;

        const rate = Math.max(0.1, this.audioState.arp.rate || 8);
        const stepTimeMs = 1000.0 / rate;

        this._arpStep(); // Immediately play the first note
        this.audioState.arp.intervalId = setInterval(this._arpStep.bind(this), stepTimeMs);
    }

    _stopArpeggiator() {
        if (!this.audioState?.arp.intervalId) return;

        clearInterval(this.audioState.arp.intervalId);
        this.audioState.arp.intervalId = null;

        // Stop the currently sounding arp note using a quick release
        if (this.audioState.currentOscillator && this.audioState.currentGainNode && this.audioState.audioContext) {
             const ac = this.audioState.audioContext;
             const now = ac.currentTime;
             const gainParam = this.audioState.currentGainNode.gain;
             const currentOsc = this.audioState.currentOscillator;
             try {
                 gainParam.cancelScheduledValues(now);
                 gainParam.setValueAtTime(gainParam.value, now);
                 gainParam.linearRampToValueAtTime(0, now + 0.02); // Quick fade
                 currentOsc.stop(now + 0.05);
             } catch(e) {
                 console.error("Error stopping final arp note:", e);
                 try { currentOsc.stop(now); } catch(stopErr) {} // Fallback stop
             }
              // Schedule cleanup shortly after stopping
              setTimeout(() => {
                  // Check if nodes weren't replaced and arp is still stopped
                  if (this.audioState && !this.audioState.arp.intervalId && this.audioState.currentOscillator === currentOsc) {
                     this._cleanupCurrentNoteNodes();
                  }
                }, 100); // ms
        }
        // Don't clear last played frequency here
    }

    _arpStep() {
        // Check essential state
        if (!this.audioState?.arp.active || !this.audioState.arp.pattern || this.audioState.arp.pattern.length === 0 || !this.audioState.arp.baseNote || !this.noteFrequencies[this.audioState.arp.baseNote]) {
            console.warn("Arp step failed: Invalid state or parameters.");
            this._stopArpeggiator(); // Stop if state is invalid
            return;
        }

        const arp = this.audioState.arp;
        const baseFrequency = this.noteFrequencies[arp.baseNote];
        const semitoneOffset = arp.pattern[arp.currentStep % arp.pattern.length];
        const stepFrequency = baseFrequency * Math.pow(this.semitoneRatio, semitoneOffset);

        this._playArpNote(stepFrequency); // Play the calculated note

        arp.currentStep++; // Move to the next step
    }


    // --- Parameter Setting ---
    setParameter(type, name, value) {
        if (!this.audioState || !this.audioState.parameters) {
             console.warn("SoundModule setParameter: State or parameters missing.");
             return;
        }

        // --- Resolve Parameter Path ---
        const path = type.split('.');
        let paramGroup = this.audioState.parameters;
        for(let i = 0; i < path.length; ++i) {
            if (paramGroup && paramGroup.hasOwnProperty(path[i])) {
                paramGroup = paramGroup[path[i]];
            } else {
                console.warn(`SoundModule: Invalid parameter group path: ${type}`);
                return; // Group not found
            }
        }

        if (typeof paramGroup !== 'object' || paramGroup === null) {
            console.warn(`SoundModule: Target parameter group is not an object: ${type}`);
            return;
        }

        // --- Update Stored Parameter ---
        paramGroup[name] = value;

        // --- Apply Change to Active Audio Nodes (if initialized) ---
        if (!this.audioState.isInitialized || !this.audioState.audioContext) return;
        const ac = this.audioState.audioContext;
        const now = ac.currentTime;
        const rampTime = 0.02; // Short ramp for smooth changes

        try {
            const fullParamName = `${type}.${name}`;
            switch (fullParamName) {
                // Oscillator gain affects current note's gain node
                case 'oscillator.gain':
                    if (this.audioState.currentGainNode) {
                        // Only ramp if the note isn't in release phase? Tricky. Simple ramp for now.
                        this.audioState.currentGainNode.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, value)), now + rampTime);
                    }
                    break;
                // Filter params affect current filter node
                case 'filter.frequency':
                     if (this.audioState.currentFilter) {
                        this.audioState.currentFilter.frequency.exponentialRampToValueAtTime(Math.max(10, Math.min(ac.sampleRate / 2, value)), now + rampTime);
                     }
                    break;
                case 'filter.Q':
                     if (this.audioState.currentFilter) {
                        this.audioState.currentFilter.Q.linearRampToValueAtTime(Math.max(0.0001, value), now + rampTime);
                     }
                    break;
                // Envelope times affect next note trigger/release
                case 'envelope.attack':
                case 'envelope.release':
                    // No immediate audio node change needed for these time parameters
                    break;

                // Effect Parameters
                case 'effects.delay.time':
                    if(this.audioState.delayNode) this.audioState.delayNode.delayTime.linearRampToValueAtTime(Math.max(0, Math.min(2.0, value)), now + rampTime); // Clamp to max delay
                    break;
                case 'effects.delay.feedback':
                    if(this.audioState.delayFeedback) this.audioState.delayFeedback.gain.linearRampToValueAtTime(Math.max(0, Math.min(0.98, value)), now + rampTime); // Clamp feedback
                    break;
                 case 'effects.reverb.decay':
                     this._updateReverbImpulse(); // Re-generate impulse response
                     break;
                case 'effects.reverb.wet':
                    if(this.audioState.reverbGain) this.audioState.reverbGain.gain.linearRampToValueAtTime(Math.max(0, Math.min(1.0, value)), now + rampTime);
                    break;

                // Arpeggiator parameters (require restart if rate changes)
                case 'effects.arpeggiator.rate':
                     this.audioState.arp.rate = value; // Update internal arp state too
                     if (this.audioState.arp.active && this.audioState.arp.intervalId) {
                         this._stopArpeggiator();
                         // Restart only if a note is supposed to be playing
                         if (this.audioState.activeNote) {
                             this._startArpeggiator();
                             this.audioState.isPlaying = true; // Ensure playing state is correct
                         }
                     }
                     break;
                case 'effects.arpeggiator.pattern':
                     this.audioState.arp.pattern = value; // Update internal arp state too
                     // Optional: Reset step count?
                     // this.audioState.arp.currentStep = 0;
                     break;
                 default:
                    // Parameter exists in structure but no specific handler
                    // console.log(`SoundModule: Parameter ${fullParamName} updated internally.`);
                    break;
            }
        } catch (e) {
            console.error(`SoundModule: Error applying parameter ${type}.${name} = ${value}:`, e);
        }
    }

    setOscillatorType(type) {
        if (!this.audioState?.parameters?.oscillator) return;
        const validTypes = ['sine', 'square', 'sawtooth', 'triangle'];
        if (validTypes.includes(type)) {
            this.audioState.parameters.oscillator.type = type;
            // Apply to current oscillator if playing
            if (this.audioState.isPlaying && this.audioState.currentOscillator) {
                try { this.audioState.currentOscillator.type = type; } catch(e) { console.error("Error setting osc type:", e); }
            }
        } else { console.warn(`SoundModule: Invalid oscillator type ${type}`); }
    }

    setFilterType(type) {
        if (!this.audioState?.parameters?.filter) return;
        const validTypes = ['lowpass', 'highpass', 'bandpass', 'notch', 'lowshelf', 'highshelf', 'peaking', 'allpass'];
        if (validTypes.includes(type)) {
             this.audioState.parameters.filter.type = type;
             // Apply to current filter if playing
             if (this.audioState.isPlaying && this.audioState.currentFilter) {
                 try { this.audioState.currentFilter.type = type; } catch(e) { console.error("Error setting filter type:", e); }
             }
         } else { console.warn(`SoundModule: Invalid filter type ${type}`); }
    }

    toggleEffect(effectName, isActive) {
        if (!this.audioState?.parameters?.effects) {
            console.error("SoundModule toggleEffect: Effects parameters missing.");
            return;
        }
        const effectParams = this.audioState.parameters.effects[effectName];
        if (effectParams === undefined) {
            // Initialize default arp params if toggling arp and it's missing
            if (effectName === 'arpeggiator') {
                 this.audioState.parameters.effects.arpeggiator = { active: false, rate: 8, pattern: [0, 4, 7] };
                 console.log("Initialized default arpeggiator params during toggle.");
            } else if (effectName === 'glitch') {
                 this.audioState.parameters.effects.glitch = { active: false }; // Store toggle state even if no audio effect
                 console.log("Initialized default glitch params during toggle.");
            }
             else {
                console.warn(`SoundModule: Cannot toggle unknown effect '${effectName}'`);
                return;
            }
        }

        const newState = !!isActive; // Ensure boolean
        if (effectParams.active === newState) return; // No change

        effectParams.active = newState;
        // console.log(`SoundModule: Toggled ${effectName} to ${newState}`);

        // Handle specific effect logic
        if (effectName === 'arpeggiator') {
            this.audioState.arp.active = newState; // Sync internal state flag
            if (newState) {
                // If a note is currently held (activeNote), start the arp
                if (this.audioState.activeNote && !this.audioState.arp.intervalId) {
                    this._stopSustainedNote(false); // Stop sustained if it was playing
                    this.audioState.arp.baseNote = this.audioState.activeNote;
                    this.audioState.arp.currentStep = 0;
                    this._startArpeggiator();
                    this.audioState.isPlaying = true; // Arp is now playing
                }
            } else {
                // Turning Arp OFF
                if (this.audioState.arp.intervalId) {
                    this._stopArpeggiator();
                    // If the base note key is still held, transition back to sustained
                    if (this.audioState.activeNote) {
                        this._playSustainedNote(this.audioState.activeNote);
                        // isPlaying should be set by _playSustainedNote
                    } else {
                       this.audioState.isPlaying = false; // No note held, just ensure stopped
                    }
                }
            }
        } else {
            // For other effects (Delay, Reverb), re-evaluate connections
            // This ensures the current playing note (sustained or arp) connects/disconnects correctly
            if (this.audioState.currentGainNode) {
                this._connectEffectsToNode(this.audioState.currentGainNode);
            }
        }
    }

    // Helper to connect/disconnect effects based on their 'active' state
    _connectEffectsToNode(sourceNode) {
        if (!sourceNode || !this.audioState?.isInitialized || !this.audioState.parameters?.effects) return;
        const effects = this.audioState.parameters.effects;

        // Use try/catch for disconnect errors if nodes aren't connected
        try {
            // Delay Connection
            if (this.audioState.delayNode) {
                sourceNode.disconnect(this.audioState.delayNode); // Always try disconnecting first
                if (effects.delay?.active) {
                    sourceNode.connect(this.audioState.delayNode);
                }
            }
            // Reverb Connection
            if (this.audioState.reverbNode) {
                 sourceNode.disconnect(this.audioState.reverbNode); // Always try disconnecting first
                if (effects.reverb?.active) {
                    sourceNode.connect(this.audioState.reverbNode);
                }
            }
        } catch(e) {
            // console.warn("SoundModule: Minor error during effect disconnection (may be expected):", e.message);
        }
    }

     // Applies the current toggle states from parameters (used during init)
     _applyCurrentToggleStates() {
         if (!this.audioState?.parameters?.effects) return;
         const effects = this.audioState.parameters.effects;
         for (const effectName in effects) {
             if (effects[effectName]?.hasOwnProperty('active')) {
                 this.toggleEffect(effectName, effects[effectName].active);
             }
         }
     }

    // --- Audio Analysis ---
    getAudioLevels() {
        // Return zero values if not initialized or analyser missing
        if (!this.audioState?.isInitialized || !this.audioState.analyser || !this.audioState.audioContext) {
            return { bass: 0, mid: 0, high: 0, frequency: this.audioState?.currentNoteFrequency || null };
        }

        try {
            const analyser = this.audioState.analyser;
            const bufferLength = analyser.frequencyBinCount; // Half the fftSize
            const dataArray = new Uint8Array(bufferLength); // Use Uint8Array for frequency data
            analyser.getByteFrequencyData(dataArray);

            // --- Frequency Band Calculation ---
            const ac = this.audioState.audioContext;
            const sampleRate = ac.sampleRate;
            const nyquist = sampleRate / 2;
            // Define frequency bands
            const bassEndFreq = 250;    // 0 - 250 Hz
            const midEndFreq = 2000;   // 251 - 2000 Hz
            const highEndFreq = 6000; // 2001 - 6000 Hz (adjust as needed)
            // Calculate corresponding indices in the dataArray
            const bassEndIndex = Math.min(bufferLength - 1, Math.floor(bassEndFreq / nyquist * bufferLength));
            const midStartIndex = bassEndIndex + 1;
            const midEndIndex = Math.min(bufferLength - 1, Math.floor(midEndFreq / nyquist * bufferLength));
            const highStartIndex = midEndIndex + 1;
            const highEndIndex = Math.min(bufferLength - 1, Math.floor(highEndFreq / nyquist * bufferLength));

            let bassSum = 0, midSum = 0, highSum = 0;
            let bassCount = 0, midCount = 0, highCount = 0;

            // Sum energy in each band
            for (let i = 0; i < bufferLength; i++) {
                const value = dataArray[i]; // Value from 0 to 255
                if (i <= bassEndIndex) {
                    bassSum += value; bassCount++;
                } else if (i >= midStartIndex && i <= midEndIndex) {
                    midSum += value; midCount++;
                } else if (i >= highStartIndex && i <= highEndIndex) {
                    highSum += value; highCount++;
                }
            }

            // Calculate average (0-255) and normalize (0-1)
            // Add small epsilon to counts to avoid division by zero
            const epsilon = 1e-6;
            const bassAvg = (bassSum / (bassCount + epsilon)) / 255.0;
            const midAvg = (midSum / (midCount + epsilon)) / 255.0;
            const highAvg = (highSum / (highCount + epsilon)) / 255.0;

            // Apply scaling/boosting and clamp to 0-1 range
            // These curves can be tweaked for desired visual responsiveness
            return {
                bass: Math.min(1.0, Math.max(0.0, Math.pow(bassAvg, 0.8) * 1.8)),
                mid:  Math.min(1.0, Math.max(0.0, Math.pow(midAvg, 0.9) * 1.4)),
                high: Math.min(1.0, Math.max(0.0, Math.pow(highAvg, 0.7) * 2.2)),
                frequency: this.audioState.currentNoteFrequency // Include last played frequency
            };

        } catch (e) {
            console.error("SoundModule: Error getting audio levels:", e);
            // Return default values on error
            return { bass: 0, mid: 0, high: 0, frequency: this.audioState?.currentNoteFrequency || null };
        }
    }


    // --- Presets ---
    applyPresetAudio(presetName) {
        if (!this.audioState) return;
        const preset = this.audioState.presets[presetName];
        if (!preset) {
            console.warn(`SoundModule: Preset '${presetName}' not found.`);
            return; // Or load a default preset?
        }
        console.log(`SoundModule: Applying audio preset '${presetName}'`);
        this.audioState.activePresetName = presetName;

        // --- Deep Copy & Merge with Defaults ---
        // Start with a deep copy of default structure to ensure all keys exist
        const defaultPreset = this.getPresetsDefinition()['default'];
        const mergedParams = JSON.parse(JSON.stringify(defaultPreset));

        // Merge oscillator params
        if (preset.oscillator) { Object.assign(mergedParams.oscillator, preset.oscillator); }
        // Merge filter params
        if (preset.filter) { Object.assign(mergedParams.filter, preset.filter); }
        // Merge envelope params
        if (preset.envelope) { Object.assign(mergedParams.envelope, preset.envelope); }
        // Merge effects params (individually)
        if (preset.effects) {
            for (const effectKey in preset.effects) {
                if (mergedParams.effects[effectKey]) {
                    Object.assign(mergedParams.effects[effectKey], preset.effects[effectKey]);
                } else { // If effect exists in preset but not default (e.g., new effect)
                    mergedParams.effects[effectKey] = JSON.parse(JSON.stringify(preset.effects[effectKey]));
                }
            }
        }
        this.audioState.parameters = mergedParams;

        // --- Sync Internal Arp State ---
        const arpParams = this.audioState.parameters.effects.arpeggiator;
        this.audioState.arp.rate = arpParams.rate;
        this.audioState.arp.pattern = arpParams.pattern;
        // Active state is handled by _applyCurrentToggleStates below

        // --- Apply Parameters to Audio Nodes (if initialized) ---
        if (this.audioState.isInitialized) {
           this.setOscillatorType(this.audioState.parameters.oscillator.type);
           this.setFilterType(this.audioState.parameters.filter.type);
           this.setParameter('filter', 'frequency', this.audioState.parameters.filter.frequency);
           this.setParameter('filter', 'Q', this.audioState.parameters.filter.Q);
           // Envelope params (attack, release) don't need immediate application
           this.setParameter('effects.delay', 'time', this.audioState.parameters.effects.delay.time);
           this.setParameter('effects.delay', 'feedback', this.audioState.parameters.effects.delay.feedback);
           this.setParameter('effects.reverb', 'decay', this.audioState.parameters.effects.reverb.decay);
           this.setParameter('effects.reverb', 'wet', this.audioState.parameters.effects.reverb.wet);
           this.setParameter('effects.arpeggiator', 'rate', arpParams.rate);
           this.setParameter('effects.arpeggiator', 'pattern', arpParams.pattern);

           // Apply toggle states AFTER params are set
            this._applyCurrentToggleStates();
        }
    }

    getPresetsDefinition() {
        // Define a default structure first
        const defaultStructure = {
             oscillator: {type: 'sawtooth', gain: 0.5},
             filter: {type: 'lowpass', frequency: 1500, Q: 1.0},
             envelope: {attack: 0.05, release: 0.5}, // Added default attack
             effects: {
                 delay: {active: false, time: 0.3, feedback: 0.3},
                 reverb: {active: false, decay: 1.5, wet: 0.3},
                 glitch: {active: false}, // Only needs active state
                 arpeggiator: {active: false, rate: 8, pattern: [0, 7, 12]}
             },
        };

        // Specific Presets (will merge with default structure)
        return {
            'default': defaultStructure, // Keep the default structure accessible
            'vaporwave': {
                oscillator: {type: 'sine', gain: 0.4},
                filter: {frequency: 800, Q: 1.0},
                envelope: {attack: 0.8, release: 2.0},
                effects: {
                    delay: {active: true, time: 0.5, feedback: 0.4},
                    reverb: {active: true, decay: 3.0, wet: 0.7},
                    arpeggiator: {active: false, rate: 4}
                },
            },
             'ambient_drone': {
                oscillator: {type: 'sine', gain: 0.4},
                filter: {frequency: 600, Q: 1.5},
                envelope: {attack: 2.5, release: 4.0}, // Long A/R
                effects: {
                    delay: {active: true, time: 0.7, feedback: 0.55},
                    reverb: {active: true, decay: 5.0, wet: 0.8},
                    arpeggiator: {active: false}
                },
             },
            'synthwave_lead': {
                oscillator: {type: 'sawtooth', gain: 0.6},
                filter: {frequency: 1200, Q: 5.0}, // High Q for resonance
                envelope: {attack: 0.02, release: 0.4},
                effects: {
                    delay: {active: true, time: 0.25, feedback: 0.3},
                    reverb: {active: true, decay: 1.5, wet: 0.4},
                    arpeggiator: {active: true, rate: 12, pattern: [0, 7, 12, 7]} // Faster arp
                },
             },
             'grimoire_pulse': {
                oscillator: {type: 'square', gain: 0.4}, // Square wave
                filter: {type: 'bandpass', frequency: 900, Q: 6.0}, // Resonant bandpass
                envelope: {attack: 0.01, release: 0.2}, // Very short pulse
                effects: {
                    delay: {active: true, time: 0.15, feedback: 0.6}, // Short, feedbacky delay
                    reverb: {active: false},
                    glitch: {active: true}, // Enable potential visual glitch
                    arpeggiator: {active: true, rate: 10, pattern: [0, 3, 7, 10]} // Minor chord arp
                },
             }
         };
    }

    getPresetNames() {
        if (!this.audioState?.presets) return [];
        // Exclude the 'default' preset from the list shown to the user
        return Object.keys(this.audioState.presets).filter(name => name !== 'default');
    }


    // --- Cleanup ---
    dispose() {
        console.log("SoundModule: Disposing...");
        if (!this.audioState) return; // Already disposed or never created

        // Stop any sound generation
        this._stopArpeggiator();
        this.stopNote(false); // Force stop any sustained note immediately

        // Disconnect nodes and close context if initialized
        if (this.audioState.isInitialized && this.audioState.audioContext) {
            const ac = this.audioState.audioContext;
            console.log("SoundModule: Disconnecting nodes...");
             try { // Gracefully attempt disconnects
                 if (this.audioState.masterGain) this.audioState.masterGain.disconnect();
                 if (this.audioState.analyser) this.audioState.analyser.disconnect();
                 if (this.audioState.delayNode) this.audioState.delayNode.disconnect();
                 if (this.audioState.delayFeedback) this.audioState.delayFeedback.disconnect();
                 if (this.audioState.reverbNode) this.audioState.reverbNode.disconnect();
                 if (this.audioState.reverbGain) this.audioState.reverbGain.disconnect();
                 // Ensure any remaining synth nodes are cleaned
                 this._cleanupCurrentNoteNodes();
             } catch(e) { console.warn("SoundModule: Error during node disconnection:", e); }

             // Close the AudioContext
             if (ac.state !== 'closed') {
                ac.close().then(() => {
                    console.log("SoundModule: AudioContext closed.");
                }).catch(e => console.error("SoundModule: Error closing AudioContext:", e));
             }
        }
        this.audioState = null; // Help GC by nullifying the state object
        this.initPromise = null; // Clear promise related state
        this.resolveInit = null;
        console.log("SoundModule: Disposed.");
    }
}