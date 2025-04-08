/* core/HypercubeCore.js */

/**
 * Main WebGL rendering engine for the Maleficarum's visualization.
 * Manages the unified canvas, WebGL context, shader programs (via ShaderManager),
 * rendering loop, and visual state parameters driven by audio.
 */
import ShaderManager from './ShaderManager.js';

// Define default state values for clarity and easier management
const DEFAULT_STATE = {
    // Core GL / Timing
    startTime: 0,
    lastUpdateTime: 0,
    deltaTime: 0,
    time: 0.0,                  // u_time
    resolution: [0, 0],         // u_resolution
    mouse: [0.5, 0.5],          // u_mouse (can be used for subtle interaction if desired)

    // Visual Parameters (Matches shader uniforms - driven by mapSoundToVisuals)
    geometryType: 'hypercube',      // String name (e.g., 'hypercube', 'hypersphere')
    projectionMethod: 'perspective',// String name (e.g., 'perspective', 'orthographic')
    dimensions: 4.0,            // u_dimension
    morphFactor: 0.5,           // u_morphFactor
    rotationSpeed: 0.3,         // u_rotationSpeed
    universeModifier: 1.0,      // u_universeModifier
    patternIntensity: 1.0,      // u_patternIntensity (General intensity/brightness)
    gridDensity: 8.0,           // u_gridDensity (Base density, can be modulated)

    // Effects Parameters (Driven by mapSoundToVisuals)
    glitchIntensity: 0.0,       // u_glitchIntensity
    plasmaSpeed: 0.5,           // u_plasmaSpeed
    plasmaScale: 1.0,           // u_plasmaScale
    moireIntensity: 0.0,        // u_moireIntensity
    moireScale: 5.0,            // u_moireScale
    currentNoteFrequency: 440.0,// u_currentNoteFreq (Default A4)

    // Audio Levels (Updated externally via audio analysis loop)
    audioLevels: { bass: 0, mid: 0, high: 0 }, // For u_audioBass, u_audioMid, u_audioHigh

    // Color Scheme (Can be dynamically updated)
    colorScheme: {
        // Colors defined as [R, G, B] arrays (0.0-1.0)
        primary: [1.0, 0.2, 0.8],    // u_primaryColor (Magenta-ish)
        secondary: [0.2, 1.0, 1.0],  // u_secondaryColor (Cyan-ish)
        background: [0.05, 0.0, 0.2, 1.0] // u_backgroundColor (vec3), Alpha for gl.clearColor
    },

    // Performance / State Tracking
    needsShaderUpdate: false, // Flag to trigger shader recompilation on geom/proj change
    _dirtyUniforms: new Set(), // Tracks which uniforms need GPU update
    isRendering: false,
    animationFrameId: null,

    // Shader Program Control
    shaderProgramName: 'maleficarumViz', // Default program name

    // Callbacks
    callbacks: {
        onRender: null, // (state) => {}
        onError: null   // (error) => {}
    }
};


class HypercubeCore {
    /**
     * Creates an instance of HypercubeCore.
     * @param {HTMLCanvasElement} canvas - The canvas element to render on.
     * @param {ShaderManager} shaderManager - An instance of ShaderManager for this context.
     * @param {object} [options={}] - Initial configuration options, merged with defaults.
     */
    constructor(canvas, shaderManager, options = {}) {
        if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
            throw new Error("HypercubeCore requires a valid HTMLCanvasElement.");
        }
        if (!shaderManager || !(shaderManager instanceof ShaderManager)) {
             throw new Error("HypercubeCore requires a valid ShaderManager instance.");
        }

        this.canvas = canvas;
        this.gl = shaderManager.gl; // Get GL context from ShaderManager
        this.shaderManager = shaderManager;
        this.quadBuffer = null;
        this.aPositionLoc = -1; // Cache attribute location

        // --- State Initialization ---
        // Deep merge options with defaults (simple merge, assumes flat structure)
        this.state = {
            ...DEFAULT_STATE,
            ...options,
            // Deep copy nested objects to prevent shared references
            colorScheme: { ...DEFAULT_STATE.colorScheme, ...(options.colorScheme || {}) },
            audioLevels: { ...DEFAULT_STATE.audioLevels, ...(options.audioLevels || {}) },
            callbacks: { ...DEFAULT_STATE.callbacks, ...(options.callbacks || {}) },
            // Mark all uniforms dirty initially to ensure they are set on first frame
            _dirtyUniforms: new Set(Object.keys(DEFAULT_STATE)),
        };
         // Ensure derived uniform names are also marked dirty initially
        this.state._dirtyUniforms.add('u_resolution');
        this.state._dirtyUniforms.add('u_primaryColor');
        this.state._dirtyUniforms.add('u_secondaryColor');
        this.state._dirtyUniforms.add('u_backgroundColor');
        this.state._dirtyUniforms.add('u_audioBass');
        this.state._dirtyUniforms.add('u_audioMid');
        this.state._dirtyUniforms.add('u_audioHigh');
        // Explicitly add new/renamed uniforms if not direct state keys
        this.state._dirtyUniforms.add('u_dimension'); // Maps from state.dimensions
        this.state._dirtyUniforms.add('u_currentNoteFreq'); // Maps from state.currentNoteFrequency
        this.state._dirtyUniforms.add('u_plasmaSpeed');
        this.state._dirtyUniforms.add('u_plasmaScale');
        this.state._dirtyUniforms.add('u_moireIntensity');
        this.state._dirtyUniforms.add('u_moireScale');

        // Copy initial geometry/projection/shader from options to state if provided
        if (options.geometryType) this.state.geometryType = options.geometryType;
        if (options.projectionMethod) this.state.projectionMethod = options.projectionMethod;
        if (options.shaderProgramName) this.state.shaderProgramName = options.shaderProgramName;
        else this.state.shaderProgramName = 'maleficarumViz'; // Ensure default name

        try {
            // GL context setup is now implicitly handled by ShaderManager's creation
            this._setupWebGLState();
            this._initBuffers();
            // Trigger initial shader creation based on final state
            this.state.needsShaderUpdate = true;
            this._updateShaderIfNeeded();

        } catch (error) {
            console.error("HypercubeCore Initialization Error:", error);
            if (this.state.callbacks.onError) {
                this.state.callbacks.onError(error);
            }
            // Prevent starting if initialization failed
            return;
        }
    }

    /**
     * Sets initial WebGL state parameters.
     * @private
     */
    _setupWebGLState() {
        const gl = this.gl;
        // Set initial clear color from state
        const bg = this.state.colorScheme.background;
        gl.clearColor(bg[0], bg[1], bg[2], bg[3] ?? 1.0); // Use alpha if present
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        gl.disable(gl.DEPTH_TEST); // Not needed for 2D quad rendering
        // Standard alpha blending
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MIN_SRC_ALPHA);
    }

    /**
     * Initializes the vertex buffer for the full-screen quad.
     * @private
     */
    _initBuffers() {
        const gl = this.gl;
        // Simple quad covering the screen (Clip Space Coordinates)
        const positions = new Float32Array([
            -1.0, -1.0,  1.0, -1.0, -1.0,  1.0,  1.0,  1.0,
        ]);

        this.quadBuffer = gl.createBuffer();
        if (!this.quadBuffer) {
            throw new Error("Failed to create WebGL buffer.");
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null); // Unbind
    }

    /**
     * Updates shader program if geometry or projection changed.
     * @private
     * @returns {boolean} True if shader is ready, false otherwise.
     */
     _updateShaderIfNeeded() {
        if (!this.state.needsShaderUpdate) return true; // No update needed

        const programName = this.state.shaderProgramName;
        const geomName = this.state.geometryType;
        const projName = this.state.projectionMethod;

        console.log(`HypercubeCore: Updating shader program '${programName}' -> Geom: ${geomName}, Proj: ${projName}`);

        // Use ShaderManager to create/update the program
        const program = this.shaderManager.createDynamicProgram(programName, geomName, projName);

        if (!program) {
            console.error(`HypercubeCore: Failed to create/update shader program '${programName}'. Halting rendering.`);
             if (this.state.callbacks.onError) {
                this.state.callbacks.onError(new Error(`Failed to update shader for ${geomName}/${projName}`));
            }
            this.stop(); // Stop rendering if shader fails
            return false; // Indicate failure
        }

        // Shader updated successfully
        this.state.needsShaderUpdate = false;
        this.shaderManager.useProgram(programName); // Activate the new program

        // --- Re-cache attribute location ---
        this.aPositionLoc = this.shaderManager.getAttributeLocation('a_position');
        if (this.aPositionLoc === null || this.aPositionLoc < 0) {
            console.warn(`HypercubeCore: Attribute 'a_position' not found in program '${programName}'.`);
            // Attempt to enable anyway, might work if location becomes valid later
            try { this.gl.enableVertexAttribArray(this.aPositionLoc ?? 0); } catch(e){}
        } else {
            this.gl.enableVertexAttribArray(this.aPositionLoc);
        }

        // Mark all uniforms as dirty after shader change, as locations might be invalid
        this.state._dirtyUniforms = new Set(Object.keys(DEFAULT_STATE));
        // Add derived/renamed uniforms explicitly again
        this.state._dirtyUniforms.add('u_resolution');
        this.state._dirtyUniforms.add('u_primaryColor');
        this.state._dirtyUniforms.add('u_secondaryColor');
        this.state._dirtyUniforms.add('u_backgroundColor');
        this.state._dirtyUniforms.add('u_audioBass');
        this.state._dirtyUniforms.add('u_audioMid');
        this.state._dirtyUniforms.add('u_audioHigh');
        this.state._dirtyUniforms.add('u_dimension');
        this.state._dirtyUniforms.add('u_currentNoteFreq');
        this.state._dirtyUniforms.add('u_plasmaSpeed');
        this.state._dirtyUniforms.add('u_plasmaScale');
        this.state._dirtyUniforms.add('u_moireIntensity');
        this.state._dirtyUniforms.add('u_moireScale');

        console.log(`HypercubeCore: Shader program '${programName}' updated successfully.`);
        return true; // Indicate success
    }

    /**
     * Updates visual state parameters. Called by ui-interactions based on sound mapping.
     * @param {object} newParams - An object containing parameters to update (e.g., { geometryType: 'hypersphere', rotationSpeed: 0.8, ... }).
     */
    updateParameters(newParams) {
        let shaderNeedsUpdate = false;
        for (const key in newParams) {
            if (Object.hasOwnProperty.call(this.state, key)) {
                // Special handling for nested objects (check for actual changes)
                if (key === 'colorScheme' || key === 'audioLevels') {
                    if (typeof newParams[key] === 'object' && newParams[key] !== null) {
                        for (const subKey in newParams[key]) {
                            if (Object.hasOwnProperty.call(this.state[key], subKey)) {
                                // Simple comparison for primitive values or arrays
                                if (JSON.stringify(this.state[key][subKey]) !== JSON.stringify(newParams[key][subKey])) {
                                    this.state[key][subKey] = newParams[key][subKey];
                                    // Mark related uniforms dirty
                                    if (key === 'colorScheme') {
                                        if (subKey === 'primary') this.state._dirtyUniforms.add('u_primaryColor');
                                        if (subKey === 'secondary') this.state._dirtyUniforms.add('u_secondaryColor');
                                        if (subKey === 'background') this.state._dirtyUniforms.add('u_backgroundColor');
                                    } else if (key === 'audioLevels') {
                                        if (subKey === 'bass') this.state._dirtyUniforms.add('u_audioBass');
                                        if (subKey === 'mid') this.state._dirtyUniforms.add('u_audioMid');
                                        if (subKey === 'high') this.state._dirtyUniforms.add('u_audioHigh');
                                    }
                                }
                            }
                        }
                    }
                } else if (this.state[key] !== newParams[key]) {
                    // Handle direct state changes
                    this.state[key] = newParams[key];

                    // Map state key to uniform name and mark dirty
                    let uniformName = `u_${key}`;
                    if (key === 'dimensions') uniformName = 'u_dimension';
                    if (key === 'currentNoteFrequency') uniformName = 'u_currentNoteFreq';
                    // Add mappings for other renamed/derived uniforms here if needed

                    // Check if the key corresponds to a known uniform pattern
                    if (key.startsWith('plasma') || key.startsWith('moire') || key.startsWith('glitch') || key.startsWith('rotation') || key.startsWith('morph') || key.startsWith('grid') || key.startsWith('universe') || key.startsWith('pattern')) {
                       this.state._dirtyUniforms.add(uniformName);
                    } else if (key === 'dimensions' || key === 'currentNoteFrequency') {
                        this.state._dirtyUniforms.add(uniformName); // Handle explicitly mapped ones
                    }
                    // Other state keys like time, resolution are handled separately

                    // Check if geometry or projection changed - requires shader rebuild
                    if (key === 'geometryType' || key === 'projectionMethod') {
                        shaderNeedsUpdate = true;
                    }
                }
            } else {
                 // console.warn(`HypercubeCore: Attempted to update unknown parameter '${key}'`);
            }
        }
        if (shaderNeedsUpdate) {
            this.state.needsShaderUpdate = true;
        }
    }


    /**
     * Checks if the canvas needs resizing and updates the viewport/resolution uniform.
     * @returns {boolean} True if the canvas was resized, false otherwise.
     * @private
     */
    _checkResize() {
        const gl = this.gl;
        const canvas = this.canvas;
        const displayWidth = canvas.clientWidth;
        const displayHeight = canvas.clientHeight;

        // Check if canvas buffer size matches display size
        if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
            canvas.width = displayWidth;
            canvas.height = displayHeight;
            gl.viewport(0, 0, canvas.width, canvas.height);
            this.state.resolution = [canvas.width, canvas.height];
            this.state._dirtyUniforms.add('u_resolution'); // Mark resolution uniform dirty
            console.log(`HypercubeCore (${this.state.shaderProgramName}): Resized canvas to ${canvas.width}x${canvas.height}`);
            return true;
        }
        return false;
    }

    /**
     * Sets all tracked dirty uniforms on the GPU for the current shader program.
     * @private
     */
    _setUniforms() {
        const gl = this.gl;
        const dirty = this.state._dirtyUniforms;
        const programName = this.state.shaderProgramName;

        // Ensure the correct program is active before setting uniforms
        // This is crucial especially after a shader rebuild
        this.shaderManager.useProgram(programName);

        // Always update time uniform
        const timeLoc = this.shaderManager.getUniformLocation('u_time');
        if (timeLoc) gl.uniform1f(timeLoc, this.state.time);
        else dirty.add('u_time'); // Keep trying if not found yet

        // Update other dirty uniforms
        dirty.forEach(uniformName => {
             if (uniformName === 'u_time') return; // Already handled

            const location = this.shaderManager.getUniformLocation(uniformName);
            if (location !== null) {
                try {
                    // --- Map state properties to uniform calls ---
                    switch (uniformName) {
                        // Core
                        case 'u_resolution': gl.uniform2fv(location, this.state.resolution); break;
                        case 'u_mouse': gl.uniform2fv(location, this.state.mouse); break;
                        // Visual Params
                        case 'u_dimension': gl.uniform1f(location, this.state.dimensions); break;
                        case 'u_morphFactor': gl.uniform1f(location, this.state.morphFactor); break;
                        case 'u_rotationSpeed': gl.uniform1f(location, this.state.rotationSpeed); break;
                        case 'u_universeModifier': gl.uniform1f(location, this.state.universeModifier); break;
                        case 'u_patternIntensity': gl.uniform1f(location, this.state.patternIntensity); break;
                        case 'u_gridDensity': gl.uniform1f(location, this.state.gridDensity); break;
                        // Effects
                        case 'u_glitchIntensity': gl.uniform1f(location, this.state.glitchIntensity); break;
                        case 'u_plasmaSpeed': gl.uniform1f(location, this.state.plasmaSpeed); break;
                        case 'u_plasmaScale': gl.uniform1f(location, this.state.plasmaScale); break;
                        case 'u_moireIntensity': gl.uniform1f(location, this.state.moireIntensity); break;
                        case 'u_moireScale': gl.uniform1f(location, this.state.moireScale); break;
                        case 'u_currentNoteFreq': gl.uniform1f(location, this.state.currentNoteFrequency); break;
                        // Colors (send vec3 for shader)
                        case 'u_primaryColor': gl.uniform3fv(location, this.state.colorScheme.primary); break;
                        case 'u_secondaryColor': gl.uniform3fv(location, this.state.colorScheme.secondary); break;
                        case 'u_backgroundColor': gl.uniform3fv(location, this.state.colorScheme.background.slice(0, 3)); break;
                        // Audio Levels
                        case 'u_audioBass': gl.uniform1f(location, this.state.audioLevels.bass); break;
                        case 'u_audioMid': gl.uniform1f(location, this.state.audioLevels.mid); break;
                        case 'u_audioHigh': gl.uniform1f(location, this.state.audioLevels.high); break;
                        // Default case for uniforms directly mapped from state keys (handled by initial switch)
                        // or uniforms derived during the update loop but not explicitly listed here.
                        default:
                            // Attempt to find corresponding state value if uniform name matches 'u_' + stateKey
                            const stateKey = uniformName.substring(2); // Remove 'u_'
                             if (Object.hasOwnProperty.call(this.state, stateKey) && typeof this.state[stateKey] === 'number') {
                                 gl.uniform1f(location, this.state[stateKey]);
                             } else {
                                // console.warn(`HypercubeCore: No specific update logic for dirty uniform '${uniformName}'`);
                                dirty.delete(uniformName); // Remove if unhandled
                                return; // Skip delete below for this iteration
                             }
                            break;
                    }
                    // If update was successful (no error and not default warning), remove from dirty set
                    dirty.delete(uniformName);

                } catch (e) {
                    console.error(`HypercubeCore: Error setting uniform '${uniformName}' for program '${programName}':`, e);
                    dirty.delete(uniformName); // Remove to prevent spamming errors
                }
            } else {
                // Location not found - Keep uniform marked as dirty.
                // It might become available after a shader recompile. Avoid spamming console.
                // console.warn(`HypercubeCore: Location not found for uniform '${uniformName}'. Will retry.`);
            }
        });
    }

    /**
     * The main rendering loop.
     * @param {DOMHighResTimeStamp} timestamp - The current time provided by requestAnimationFrame.
     * @private
     */
    _render(timestamp) {
        if (!this.state.isRendering) return; // Check if rendering is stopped

        const gl = this.gl;
        if (!gl || gl.isContextLost()) {
             console.error(`HypercubeCore (${this.state.shaderProgramName}): GL context lost or unavailable. Stopping render loop.`);
             this.stop();
             if (this.state.callbacks.onError) {
                this.state.callbacks.onError(new Error("WebGL context lost"));
             }
             return;
        }

        // --- Update Time ---
        if (!this.state.startTime) this.state.startTime = timestamp;
        const currentTime = (timestamp - this.state.startTime) * 0.001; // Time in seconds
        this.state.deltaTime = currentTime - this.state.time;
        this.state.time = currentTime;
        this.state.lastUpdateTime = timestamp;

        // --- Check for Updates ---
        this._checkResize(); // Check for canvas resize first

        // Update shader program ONLY if needed (triggered by state changes)
         if (this.state.needsShaderUpdate) {
            if (!this._updateShaderIfNeeded()) {
                 // Shader update failed, loop already stopped by _updateShaderIfNeeded
                 return;
             }
             // _updateShaderIfNeeded marks all uniforms dirty, so _setUniforms below handles them
         }

        // Set all necessary uniforms (including time)
        this._setUniforms(); // Calls useProgram internally, updates dirty uniforms

        // --- Prepare for Drawing ---
        // Set clear color (might change if u_backgroundColor updated)
        const bg = this.state.colorScheme.background;
        gl.clearColor(bg[0], bg[1], bg[2], bg[3] ?? 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // --- Draw Call ---
        if (this.quadBuffer && this.aPositionLoc !== null && this.aPositionLoc >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
            // Re-enable attribute just in case (paranoid check for context state issues)
            gl.enableVertexAttribArray(this.aPositionLoc);
            gl.vertexAttribPointer(
                this.aPositionLoc, 2, gl.FLOAT, false, 0, 0
            );
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); // Draw the quad

        } else {
             if(!this.quadBuffer) console.warn(`HypercubeCore (${this.state.shaderProgramName}): Quad buffer not available.`);
             // Check location again in case it became invalid
             if(this.aPositionLoc === null || this.aPositionLoc < 0) {
                this.aPositionLoc = this.shaderManager.getAttributeLocation('a_position'); // Try re-caching
                if(this.aPositionLoc === null || this.aPositionLoc < 0) {
                    console.warn(`HypercubeCore (${this.state.shaderProgramName}): a_position attribute location invalid, cannot draw.`);
                }
             }
        }

        // --- Callback & Next Frame ---
        if (this.state.callbacks.onRender) {
            try {
                this.state.callbacks.onRender(this.state); // Pass current state
            } catch (e) {
                console.error(`HypercubeCore (${this.state.shaderProgramName}): Error in onRender callback:`, e);
            }
        }

        // Request the next frame
        this.state.animationFrameId = requestAnimationFrame(this._render.bind(this));
    }

    /** Starts the rendering loop. */
    start() {
        if (this.state.isRendering) return;
        if (!this.gl || this.gl.isContextLost()) {
             console.error(`HypercubeCore (${this.state.shaderProgramName}): Cannot start rendering, WebGL context invalid.`);
             return;
        }

        console.log(`HypercubeCore (${this.state.shaderProgramName}): Starting render loop.`);
        this.state.isRendering = true;
        this.state.startTime = performance.now();
        this.state.time = 0;
        this.state.lastUpdateTime = this.state.startTime;

        // Ensure all uniforms are marked dirty on first start or restart
        this.state._dirtyUniforms = new Set(Object.keys(DEFAULT_STATE));
        // Add derived/renamed uniforms explicitly again
        this.state._dirtyUniforms.add('u_resolution');
        this.state._dirtyUniforms.add('u_primaryColor');
        this.state._dirtyUniforms.add('u_secondaryColor');
        this.state._dirtyUniforms.add('u_backgroundColor');
        this.state._dirtyUniforms.add('u_audioBass');
        this.state._dirtyUniforms.add('u_audioMid');
        this.state._dirtyUniforms.add('u_audioHigh');
        this.state._dirtyUniforms.add('u_dimension');
        this.state._dirtyUniforms.add('u_currentNoteFreq');
        this.state._dirtyUniforms.add('u_plasmaSpeed');
        this.state._dirtyUniforms.add('u_plasmaScale');
        this.state._dirtyUniforms.add('u_moireIntensity');
        this.state._dirtyUniforms.add('u_moireScale');

        this.state.animationFrameId = requestAnimationFrame(this._render.bind(this));
    }

    /** Stops the rendering loop. */
    stop() {
        if (!this.state.isRendering) return;
        console.log(`HypercubeCore (${this.state.shaderProgramName}): Stopping render loop.`);
        if (this.state.animationFrameId) {
            cancelAnimationFrame(this.state.animationFrameId);
        }
        this.state.isRendering = false;
        this.state.animationFrameId = null;
    }

    /** Cleans up WebGL resources. */
    dispose() {
        const name = this.state?.shaderProgramName || 'Unknown';
        console.log(`HypercubeCore (${name}): Disposing resources...`);
        this.stop();
        if (this.gl) {
            if (this.quadBuffer) {
                try { this.gl.deleteBuffer(this.quadBuffer); } catch(e){}
            }
            // ShaderManager associated with this core should be disposed externally
            // if it's shared, or here if it's exclusive. Assuming external for now.
             // If ShaderManager is exclusive, uncomment:
             if (this.shaderManager && typeof this.shaderManager.dispose === 'function') {
                  console.log(`HypercubeCore (${name}): Disposing associated ShaderManager.`);
                  this.shaderManager.dispose();
             }

             // Attempt to lose context gracefully
             const loseContextExt = this.gl.getExtension('WEBGL_lose_context');
             if (loseContextExt) {
                 try { loseContextExt.loseContext(); } catch(e) {}
             }
        }
        this.quadBuffer = null;
        this.gl = null;
        this.canvas = null; // Release reference
        this.shaderManager = null; // Release reference
        this.state = {}; // Clear state
         console.log(`HypercubeCore (${name}): Disposed.`);
    }
}
export default HypercubeCore;