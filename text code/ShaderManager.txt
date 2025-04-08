/* core/ShaderManager.js */

/**
 * Manages WebGL shader compilation, linking, and dynamic assembly
 * based on selected geometry and projection methods. Caches compiled
 * shaders and linked programs for efficiency. Handles injecting GLSL code.
 * V1.1 - Adapted fragment shader to use user-provided "original" visual logic.
 */

class ShaderManager {
    // Constructor and other methods (_mergeDefaults, _initShaderTemplates, _registerShaderSource,
    // _compileShader, _logShaderSourceWithError, _createProgram, createDynamicProgram,
    // useProgram, getUniformLocation, getAttributeLocation, dispose) remain the SAME as in the previous version.
    // ... (Keep all methods from the previous ShaderManager.js version here) ...

    /**
     * Creates a new ShaderManager instance.
     * @param {WebGLRenderingContext} gl - The WebGL rendering context.
     * @param {import('./GeometryManager.js').GeometryManager} geometryManager - Instance of GeometryManager.
     * @param {import('./ProjectionManager.js').ProjectionManager} projectionManager - Instance of ProjectionManager.
     * @param {object} [options={}] - Configuration options.
     */
    constructor(gl, geometryManager, projectionManager, options = {}) {
        if (!gl) throw new Error("ShaderManager requires a WebGL context.");
        if (!geometryManager) throw new Error("ShaderManager requires a GeometryManager instance.");
        if (!projectionManager) throw new Error("ShaderManager requires a ProjectionManager instance.");

        this.gl = gl;
        this.geometryManager = geometryManager; // Still needed if projection uses geometry info? Unlikely. Kept for consistency.
        this.projectionManager = projectionManager; // Needed for projection code injection
        this.options = this._mergeDefaults(options);

        // Caches
        this.shaderSources = {};       // { name: { source, type } }
        this.compiledShaders = {};     // { uniqueShaderName: WebGLShader }
        this.programs = {};            // { programName: WebGLProgram }
        this.uniformLocations = {};    // { programName: { uniformName: WebGLUniformLocation | null } }
        this.attributeLocations = {};  // { programName: { attribName: number | null } }

        this.currentProgramName = null; // Tracks the program last activated via useProgram

        this._initShaderTemplates();
    }

    /** Merges provided options with defaults. */
    _mergeDefaults(options) {
        return {
            baseVertexShaderName: 'base-vertex',
            baseFragmentShaderName: 'base-fragment',
            ...options
        };
    }

    /** Loads the base shader templates. */
    _initShaderTemplates() {
        this._registerShaderSource(this.options.baseVertexShaderName, this._getBaseVertexShaderSource(), this.gl.VERTEX_SHADER);
        this._registerShaderSource(this.options.baseFragmentShaderName, this._getAdaptedFragmentShaderSource(), this.gl.FRAGMENT_SHADER); // Use adapted shader
    }

    /** Stores shader source code. */
    _registerShaderSource(name, source, type) {
        this.shaderSources[name] = { source, type };
    }

     /**
      * Compiles a shader from source, utilizing a cache.
      * @param {string} shaderIdentifier - A unique name for this specific shader source.
      * @param {string} source - The GLSL source code.
      * @param {GLenum} type - this.gl.VERTEX_SHADER or this.gl.FRAGMENT_SHADER.
      * @returns {WebGLShader | null} The compiled shader or null on failure.
      * @private
      */
     _compileShader(shaderIdentifier, source, type) {
         // Check cache first
         if (this.compiledShaders[shaderIdentifier]) {
             // console.log(`ShaderManager: Using cached compiled shader: ${shaderIdentifier}`);
             return this.compiledShaders[shaderIdentifier];
         }

         const shader = this.gl.createShader(type);
         if (!shader) {
              console.error(`ShaderManager: Failed to create shader object for '${shaderIdentifier}'.`);
              return null;
          }
         this.gl.shaderSource(shader, source);
         this.gl.compileShader(shader);

         if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
             const errorLog = this.gl.getShaderInfoLog(shader);
             console.error(`ShaderManager: Error compiling shader '${shaderIdentifier}':\n${errorLog}`);
             this._logShaderSourceWithError(source, errorLog); // Log source with error indication
             this.gl.deleteShader(shader);
             return null;
         }

         // console.log(`ShaderManager: Compiled shader: ${shaderIdentifier}`);
         this.compiledShaders[shaderIdentifier] = shader; // Cache compiled shader
         return shader;
     }

     /** Helper to log shader source with error markers. */
     _logShaderSourceWithError(source, errorLog) {
         const lines = source.split('\n');
         // Try to extract line number like "ERROR: 0:15:"
         const match = errorLog.match(/ERROR:\s*\d+:(\d+):/);
         let errorLineNum = -1;
         if (match && match[1]) {
             errorLineNum = parseInt(match[1], 10); // 1-based line number
         }

         console.error("--- Shader Source Start ---");
         lines.forEach((line, index) => {
             const lineNum = index + 1;
             const prefix = (lineNum === errorLineNum) ? `>> ${lineNum}: ` : `   ${lineNum}: `;
             console.error(prefix + line);
         });
         console.error("--- Shader Source End ---");
     }

      /**
       * Links vertex and fragment shaders into a WebGL program.
       * Replaces existing program and clears its caches if programName exists.
       * @param {string} programName - The name to identify this program.
       * @param {WebGLShader} vertexShader - Compiled vertex shader.
       * @param {WebGLShader} fragmentShader - Compiled fragment shader.
       * @returns {WebGLProgram | null} The linked program or null on failure.
       * @private
       */
      _createProgram(programName, vertexShader, fragmentShader) {
          // Clear previous program/caches if rebuilding THIS specific program
          if (this.programs[programName]) {
              console.log(`ShaderManager: Rebuilding program: ${programName}...`);
               const oldProgram = this.programs[programName];
               try {
                  const attachedShaders = this.gl.getAttachedShaders(oldProgram);
                  if(attachedShaders) {
                      attachedShaders.forEach(shader => this.gl.detachShader(oldProgram, shader));
                  }
                  this.gl.deleteProgram(oldProgram);
               } catch (e) { console.warn(`ShaderManager: Error cleaning up old program '${programName}':`, e); }
              delete this.programs[programName];
              delete this.uniformLocations[programName]; // Clear location caches
              delete this.attributeLocations[programName];
          }

          const program = this.gl.createProgram();
           if (!program) {
               console.error(`ShaderManager: Failed to create program object for '${programName}'.`);
               return null;
           }
          this.gl.attachShader(program, vertexShader);
          this.gl.attachShader(program, fragmentShader);
          this.gl.linkProgram(program);

          if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
              const errorLog = this.gl.getProgramInfoLog(program);
              console.error(`ShaderManager: Error linking program '${programName}':\n${errorLog}`);
              // Detach shaders before deleting the failed program
               try { this.gl.detachShader(program, vertexShader); } catch(e) {}
               try { this.gl.detachShader(program, fragmentShader); } catch(e) {}
              this.gl.deleteProgram(program);
              return null;
          }

          this.programs[programName] = program; // Cache linked program
          this.uniformLocations[programName] = {}; // Initialize caches for this new program
          this.attributeLocations[programName] = {};
          console.log(`ShaderManager: Program '${programName}' created and linked successfully.`);
          return program;
      }

       /**
        * Creates or updates a shader program by injecting ONLY projection GLSL code
        * into the adapted base fragment shader template and linking with the base vertex shader.
        * Geometry is now handled *within* the adapted fragment shader.
        *
        * @param {string} programName - A unique name for this program configuration (e.g., 'mainViz').
        * @param {string} geometryTypeName - Name of the geometry type (IGNORED, logic is in shader).
        * @param {string} projectionMethodName - Name of the projection method (e.g., 'perspective').
        * @returns {WebGLProgram | null} The linked WebGLProgram or null on failure.
        */
       createDynamicProgram(programName, geometryTypeName, projectionMethodName) { // geometryTypeName is now ignored here
           // --- Get Base Vertex Shader ---
           const vertexShaderTemplateName = this.options.baseVertexShaderName;
           const vertexShaderSourceInfo = this.shaderSources[vertexShaderTemplateName];
           if (!vertexShaderSourceInfo) {
                console.error(`ShaderManager: Base vertex shader source '${vertexShaderTemplateName}' not found.`);
                return null;
           }
            const vertexShader = this._compileShader(vertexShaderTemplateName, vertexShaderSourceInfo.source, vertexShaderSourceInfo.type);
            if (!vertexShader) return null;


           // --- Get Dynamic Code Snippets (Only Projection) ---
           // const geometry = this.geometryManager.getGeometry(geometryTypeName); // No longer needed for injection
           const projection = this.projectionManager.getProjection(projectionMethodName);
            // if (!geometry) { /* ... error */ }
            if (!projection) {
                console.error(`ShaderManager: Failed to get projection provider for '${projectionMethodName}'.`);
                return null;
            }

           // const geometryGLSL = geometry.getShaderCode(); // No longer needed for injection
           const projectionGLSL = projection.getShaderCode();
            if (/*typeof geometryGLSL !== 'string' ||*/ typeof projectionGLSL !== 'string') {
               console.error(`ShaderManager: Invalid GLSL code returned by projection provider.`);
               return null;
            }

           // --- Inject Code into Fragment Shader Template ---
           const fragmentShaderTemplateName = this.options.baseFragmentShaderName;
           const fragmentShaderSourceInfo = this.shaderSources[fragmentShaderTemplateName];
            if (!fragmentShaderSourceInfo) {
                console.error(`ShaderManager: Base fragment shader source '${fragmentShaderTemplateName}' not found.`);
                return null;
            }
           let fragmentSource = fragmentShaderSourceInfo.source;
           // Inject ONLY projection code
           fragmentSource = fragmentSource.replace('//__PROJECTION_CODE_INJECTION_POINT__', projectionGLSL);
           // REMOVE geometry injection point from the template string itself if present, or ensure the template doesn't have it.
           // The template provided below (_getAdaptedFragmentShaderSource) does NOT have the geometry injection point.

           // --- Compile Combined Fragment Shader ---
           // Identifier should reflect that geometry logic is baked in, but projection changes
           const dynamicFragmentShaderIdentifier = `fragment-adapted-base-${projectionMethodName}`;
           const fragmentShader = this._compileShader(dynamicFragmentShaderIdentifier, fragmentSource, fragmentShaderSourceInfo.type);
           if (!fragmentShader) return null; // Compilation failed


           // --- Create and Link Program ---
           const program = this._createProgram(programName, vertexShader, fragmentShader);

           // --- Handle Current Program State ---
           if (this.currentProgramName === programName && !program) {
               this.currentProgramName = null; // Clear if rebuild failed
           } else if (program && this.currentProgramName === programName) {
                // If we successfully rebuilt the currently active program, re-activate it implicitly
                this.gl.useProgram(program); // Re-bind the new program
                console.log(`ShaderManager: Re-activated rebuilt program '${programName}'. Caches cleared.`);
           }


           return program;
       }

        /** Activates the specified shader program for use. */
       useProgram(programName) {
           if (programName === null) {
               if (this.currentProgramName !== null) {
                   this.gl.useProgram(null);
                   this.currentProgramName = null;
               }
               return;
           }

           const program = this.programs[programName];
           if (program) {
               // Avoid redundant gl.useProgram calls if already active
                if (this.gl.getParameter(this.gl.CURRENT_PROGRAM) !== program) {
                    this.gl.useProgram(program);
                }
                // Always update the tracker, even if GL call was skipped
                this.currentProgramName = programName;
            } else {
                console.warn(`ShaderManager: Program '${programName}' not found or not compiled yet. Cannot use.`);
                 // Ensure currentProgramName is cleared if the requested program is invalid
                if (this.currentProgramName === programName) {
                    this.currentProgramName = null;
                }
            }
       }

       /**
        * Gets the location of a uniform variable for the *currently active* program.
        * Caches the result.
        * @param {string} name - The name of the uniform.
        * @returns {WebGLUniformLocation | null} The location or null if not found or no program active.
        */
       getUniformLocation(name) {
           if (!this.currentProgramName) {
               // console.warn(`ShaderManager: Cannot get uniform '${name}': No program is currently active via useProgram().`);
               return null;
           }
           const program = this.programs[this.currentProgramName];
           if (!program) {
                console.warn(`ShaderManager: Cannot get uniform '${name}': Current program '${this.currentProgramName}' is invalid.`);
                return null;
            }

           const cache = this.uniformLocations[this.currentProgramName];
           if (!(name in cache)) {
               const location = this.gl.getUniformLocation(program, name);
               cache[name] = location; // Cache the result (including null if not found)
               // if (location === null) console.warn(`Uniform '${name}' not found in program '${this.currentProgramName}'`);
           }
           return cache[name];
       }

       /**
        * Gets the location of an attribute variable for the *currently active* program.
        * Caches the result. Returns null if not found (WebGL returns -1).
        * @param {string} name - The name of the attribute.
        * @returns {number | null} The attribute location (>= 0) or null if not found or no program active.
        */
       getAttributeLocation(name) {
            if (!this.currentProgramName) {
               // console.warn(`ShaderManager: Cannot get attribute '${name}': No program is currently active via useProgram().`);
                return null;
            }
            const program = this.programs[this.currentProgramName];
            if (!program) {
                console.warn(`ShaderManager: Cannot get attribute '${name}': Current program '${this.currentProgramName}' is invalid.`);
                return null;
            }

            const cache = this.attributeLocations[this.currentProgramName];
            if (!(name in cache)) {
                const location = this.gl.getAttribLocation(program, name);
                cache[name] = (location === -1) ? null : location; // Store null if not found (-1)
                // if (location === -1) console.warn(`Attribute '${name}' not found in program '${this.currentProgramName}'`);
            }
            return cache[name];
       }


    // --- Shader Source Templates ---

    _getBaseVertexShaderSource() {
        // Standard pass-through vertex shader - UNCHANGED
        return `
            attribute vec2 a_position; // Input: Clip space (-1 to 1)
            varying vec2 v_uv;       // Output: UV coordinates (0 to 1)

            void main() {
                v_uv = a_position * 0.5 + 0.5;
                gl_Position = vec4(a_position, 0.0, 1.0);
            }
        `;
    }

    _getAdaptedFragmentShaderSource() {
        // This is the fragment shader GLSL adapted from the user's example
        // It uses the v1.1 uniform names where applicable.
        return `
            precision highp float;

            // Uniforms expected by this shader (names match v1.1 HypercubeCore state)
            // Values for these are determined by ui-interactions.js -> mapSoundToVisuals
            uniform vec2 u_resolution;
            uniform float u_time;
            uniform vec2 u_mouse;          // Direct mouse input (can be kept or replaced by audio mapping)
            uniform float u_morphFactor;   // Value controlled by audio mapping
            uniform float u_glitchIntensity; // Value controlled by audio mapping
            uniform float u_rotationSpeed; // Value controlled by audio mapping
            uniform float u_dimension;     // Value controlled by audio mapping
            uniform float u_gridDensity;   // Value controlled by audio mapping

            // Uniforms available from v1.1 spec, but potentially unused by this specific shader logic:
            uniform float u_universeModifier; // Currently unused by this shader
            uniform float u_patternIntensity; // Currently unused by this shader
            uniform float u_currentNoteFreq; // Currently unused by this shader for color
            uniform float u_plasmaSpeed;     // Currently unused by this shader
            uniform float u_plasmaScale;     // Currently unused by this shader
            uniform float u_moireIntensity;  // Currently unused by this shader
            uniform float u_moireScale;      // Currently unused by this shader
            uniform float u_xyPadActive;    // Currently unused by this shader
            uniform vec3 u_primaryColor;    // Theme color (unused currently)
            uniform vec3 u_secondaryColor;  // Theme color (unused currently)
            uniform vec3 u_backgroundColor; // Theme color (unused currently)
            uniform float u_audioBass;     // Audio level (unused currently)
            uniform float u_audioMid;      // Audio level (unused currently)
            uniform float u_audioHigh;     // Audio level (unused currently)

            // Varyings
            varying vec2 v_uv; // Tex coords from vertex shader (0-1 range)


            // --- Helper Functions from Original Shader ---
            mat4 rotateXY(float theta) { float c=cos(theta),s=sin(theta);return mat4(c,-s,0,0,s,c,0,0,0,0,1,0,0,0,0,1); }
            mat4 rotateXZ(float theta) { float c=cos(theta),s=sin(theta);return mat4(c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1); }
            mat4 rotateXW(float theta) { float c=cos(theta),s=sin(theta);return mat4(c,0,0,-s,0,1,0,0,0,0,1,0,s,0,0,c); }
            mat4 rotateYZ(float theta) { float c=cos(theta),s=sin(theta);return mat4(1,0,0,0,0,c,-s,0,0,s,c,0,0,0,0,1); }
            mat4 rotateYW(float theta) { float c=cos(theta),s=sin(theta);return mat4(1,0,0,0,0,c,0,-s,0,0,1,0,0,s,0,c); }
            mat4 rotateZW(float theta) { float c=cos(theta),s=sin(theta);return mat4(1,0,0,0,0,1,0,0,0,0,c,-s,0,0,s,c); }

            // Projection function: vec3 project4Dto3D(vec4 p);
            // This needs to be injected by the ProjectionManager still.
            //__PROJECTION_CODE_INJECTION_POINT__


            // --- Lattice Functions from Original Shader ---
             // Distance to nearest edge in 3D lattice
             float latticeEdges(vec3 p, float gridSize, float lineWidth) {
               vec3 grid = fract(p * gridSize + 0.5); // Shifted fract
               vec3 dist = abs(grid - 0.5);
               float d = max(max(dist.x, dist.y), dist.z); // Box distance
               return 1.0 - smoothstep(0.5 - lineWidth, 0.5, d); // Lines are bright
             }

             // Distance to nearest vertex in 3D lattice
             float latticeVertices(vec3 p, float gridSize, float vertexSize) {
               vec3 gridPos = floor(p * gridSize + 0.5) / gridSize;
               float distToVertex = length(p - gridPos);
               return 1.0 - smoothstep(0.0, vertexSize, distToVertex); // Vertices are bright
             }

             // Combined Hypercube Lattice (Handles morphing and 4D projection internally)
             // NOTE: This function is now part of the base shader, NOT injected by GeometryManager
             float hypercubeLattice(vec3 p, float morphFactor, float gridSize) {
               float baseEdges = latticeEdges(p, gridSize, 0.02); // Thinner lines
               float baseVertices = latticeVertices(p, gridSize, 0.03); // Smaller vertices

               // Create a 4D point - w coord depends on dimension uniform
               // Let w oscillate based on position and time when dimension > 3
               float w = 0.0;
               if (u_dimension > 3.01) {
                   // Use dimension uniform to control w oscillation amplitude
                   w = sin(length(p) * 2.5 + u_time * 0.4 * u_rotationSpeed) * smoothstep(3.0, 4.0, u_dimension);
               }
               vec4 p4d = vec4(p, w);

               // Apply 4D rotations based on time and rotationSpeed uniform
               float t = u_time * 0.25 * u_rotationSpeed; // Base rotation time
               p4d = rotateXW(t * 0.9) * rotateYZ(t * 1.1) * rotateZW(t * 1.3) * p4d;

               // Project back to 3D using the injected projection function
               vec3 projectedP = project4Dto3D(p4d);

               // Calculate lattice for the projected position
               float projectedEdges = latticeEdges(projectedP, gridSize, 0.02);
               float projectedVertices = latticeVertices(projectedP, gridSize, 0.03);

               // Blend between base 3D lattice and projected 4D lattice using morphFactor uniform
               float finalEdges = mix(baseEdges, projectedEdges, u_morphFactor);
               float finalVertices = mix(baseVertices, projectedVertices, u_morphFactor);

               return max(finalEdges, finalVertices); // Combine edges and vertices
             }


            // --- Main Function (Adapted from Original Shader) ---
            void main() {
              // Calculate UV coordinates centered and aspect-corrected
              vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

              // Use mouse uniform directly for centering for now
              // This could be replaced/modulated by audio input later in mapSoundToVisuals
              vec2 centerOffset = (u_mouse - 0.5) * 2.0;
              centerOffset.x *= u_resolution.x / u_resolution.y; // Correct mouse aspect

              // Create 3D ray position (simple perspective)
              vec3 p = vec3(uv - centerOffset * 0.5, 1.0); // Apply mouse offset

              // Apply 3D rotation based on time and rotationSpeed uniform
              float timeRotation = u_time * 0.15 * u_rotationSpeed;
              mat2 rot = mat2(cos(timeRotation), -sin(timeRotation), sin(timeRotation), cos(timeRotation));
              p.xy = rot * p.xy;
              p.xz = rot * p.xz; // Rotate around Y axis as well

              // --- Calculate Lattice Value ---
              // Use the internal hypercubeLattice function, passing uniforms
              // Values for morphFactor, gridSize, dimension, rotationSpeed come from HypercubeCore state
              float lattice = hypercubeLattice(p * 0.8, u_morphFactor, u_gridDensity); // Scale input position slightly

              // --- RGB Splitting / Glitch Effect ---
              // Calculate offsets based on glitchIntensity uniform
              float glitch = u_glitchIntensity * 0.015; // Scale intensity effect
              vec2 offsetR = vec2(cos(u_time * 2.5), sin(u_time * 1.8)) * glitch;
              vec2 offsetB = vec2(sin(u_time * 3.2), cos(u_time * 2.1)) * glitch;

              // Recalculate lattice at offset positions for R and B channels
              float latticeR = hypercubeLattice((p + vec3(offsetR, 0.0)) * 0.8, u_morphFactor, u_gridDensity);
              float latticeB = hypercubeLattice((p + vec3(offsetB, 0.0)) * 0.8, u_morphFactor, u_gridDensity);

              // Combine channels - use the lattice value directly for brightness
              vec3 color = vec3(latticeR, lattice, latticeB); // R, G (original), B

              // Add subtle bloom/glow based on lattice intensity
              color += pow(lattice, 5.0) * vec3(0.8, 0.9, 1.0) * 0.3; // Cool bloom

              // Add simple background gradient (can be replaced by u_backgroundColor if needed)
              vec3 bgGradient = mix(vec3(0.05, 0.02, 0.15), vec3(0.0, 0.1, 0.15), v_uv.y);
              // Mix color with background based on brightness (acts like alpha blending)
              color = mix(bgGradient, color, smoothstep(0.0, 0.1, length(color)));


              gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
            }
        `;
    }

     /** Cleans up all managed WebGL resources (shaders, programs). */
     dispose() {
         console.log("ShaderManager: Disposing resources...");
         try {
             // Ensure GL context is available before using it
             if (this.gl && typeof this.gl.useProgram === 'function') {
                this.gl.useProgram(null); // Deactivate any active program
             }
         } catch(e) { console.warn("ShaderManager: Error calling useProgram(null) during dispose:", e); }

         // Delete all linked programs
         for (const name in this.programs) {
             if (this.programs[name] && this.gl) {
                  const program = this.programs[name];
                  try {
                      const attachedShaders = this.gl.getAttachedShaders(program);
                      if(attachedShaders) {
                          attachedShaders.forEach(shader => {
                             try { this.gl.detachShader(program, shader); } catch(e) {/* ignore */}
                          });
                      }
                      this.gl.deleteProgram(program);
                  } catch (e) { console.warn(`ShaderManager: Error deleting program '${name}':`, e); }
             }
         }

         // Delete all separately compiled shaders (templates, combined fragments)
         for (const name in this.compiledShaders) {
             if (this.compiledShaders[name] && this.gl) {
                 try { this.gl.deleteShader(this.compiledShaders[name]); } catch(e) { console.warn(`ShaderManager: Error deleting shader '${name}':`, e); }
             }
         }

         // Clear all caches and references
         this.programs = {};
         this.compiledShaders = {};
         this.shaderSources = {};
         this.uniformLocations = {};
         this.attributeLocations = {};
         this.currentProgramName = null;
         this.geometryManager = null; // Release references
         this.projectionManager = null;
         // Do not nullify GL context here if owned by HypercubeCore
         // this.gl = null;

         console.log("ShaderManager: Disposed.");
     }

}

export default ShaderManager; // Use default export