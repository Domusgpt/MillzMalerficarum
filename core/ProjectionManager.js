/* core/ProjectionManager.js */

/**
 * Manages different methods for projecting 4-dimensional points into 3-dimensional space.
 * Provides GLSL code snippets defining the `project4Dto3D(vec4 p)` function for shaders.
 */

// --- Base Projection Class ---

/**
 * @abstract
 * Base class for all 4D-to-3D projection methods. Defines the interface.
 */
class BaseProjection {
    constructor() {}

    /**
     * Returns the GLSL code snippet defining the `project4Dto3D(vec4 p)` function.
     * This function takes a 4D vector `p` and returns the corresponding 3D vector.
     * The function can use uniforms like u_morphFactor, u_audioMid, etc., if needed
     * for dynamic effects within the projection itself.
     *
     * @abstract
     * @returns {string} GLSL code snippet defining `vec3 project4Dto3D(vec4 p)`.
     * @throws {Error} If not implemented by subclass.
     */
    getShaderCode() {
        throw new Error(`getShaderCode() must be implemented by projection subclass.`);
    }
}

// --- Perspective Projection ---

/**
 * Implements a perspective projection from 4D to 3D.
 * Points are projected towards a viewpoint; W coordinate affects scale.
 */
class PerspectiveProjection extends BaseProjection {
    /**
     * @param {number} [viewDistance=2.5] - Base distance of the viewpoint along the W axis.
     */
    constructor(viewDistance = 2.5) {
        super();
        this.viewDistance = Math.max(0.1, viewDistance);
    }

    /** Allows changing the base view distance after initialization (less relevant now). */
    // setViewDistance(distance) { this.viewDistance = Math.max(0.1, distance); }

    getShaderCode() {
        // Provides: vec3 project4Dto3D(vec4 p);
        return `
            // --- Perspective Projection (4D to 3D) ---
            // Projects onto w=0 hyperplane from a viewpoint on the W axis.
            vec3 project4Dto3D(vec4 p) {
                 // Base distance from the viewpoint to the projection hyperplane (w=0)
                 float baseDistance = ${this.viewDistance.toFixed(2)};

                 // Modulate the effective view distance dynamically based on parameters
                 // u_morphFactor can strengthen/weaken perspective, audio can pulse it.
                 float dynamicDistance = baseDistance * (1.0 + u_morphFactor * 0.4 - u_audioMid * 0.3);
                 dynamicDistance = max(0.2, dynamicDistance); // Ensure positive distance > near plane

                 // Perspective division factor (denominator depends on viewpoint convention)
                 // Assuming viewpoint at +dynamicDistance on W axis, projecting onto w=0:
                 // Factor = dynamicDistance / (dynamicDistance + p.w)
                 float denominator = dynamicDistance + p.w;

                 // Prevent extreme scaling / division by zero near the viewpoint's W coordinate.
                 // Clamp the denominator's minimum magnitude.
                 float w_factor = dynamicDistance / max(0.1, denominator);

                 // Scale the xyz coordinates by the perspective factor.
                 return p.xyz * w_factor;
            }
        `;
    }
}

// --- Orthographic Projection ---

/**
 * Implements an orthographic projection (discard W), but allows blending
 * towards perspective based on u_morphFactor and audio.
 */
class OrthographicProjection extends BaseProjection {
    constructor() { super(); }

    getShaderCode() {
         // Provides: vec3 project4Dto3D(vec4 p);
        return `
            // --- Orthographic Projection (4D to 3D) ---
            // Primarily drops the w coordinate, but allows blending towards perspective.
            vec3 project4Dto3D(vec4 p) {
                 // Pure orthographic projection takes xyz components.
                 vec3 orthoP = p.xyz;

                 // Define the perspective projection to blend towards
                 float basePerspectiveDistance = 2.5;
                 // Modulate perspective part with audio
                 float dynamicPerspectiveDistance = basePerspectiveDistance * (1.0 - u_audioMid * 0.4);
                 dynamicPerspectiveDistance = max(0.2, dynamicPerspectiveDistance);

                 float perspDenominator = dynamicPerspectiveDistance + p.w;
                 float persp_w_factor = dynamicPerspectiveDistance / max(0.1, perspDenominator);
                 vec3 perspP = p.xyz * persp_w_factor;

                 // Blend between orthographic and the dynamic perspective using morphFactor.
                 // Smoothstep provides a smoother transition than linear mix.
                 float morphT = smoothstep(0.0, 1.0, u_morphFactor);

                 // Mix(base, target, factor)
                 return mix(orthoP, perspP, morphT);
            }
        `;
    }
}

// --- Stereographic Projection ---

/**
 * Implements a stereographic projection from a 4-sphere onto a 3D hyperplane.
 * Preserves angles locally (conformal). Blends towards orthographic via morph.
 */
class StereographicProjection extends BaseProjection {
    /**
     * @param {number} [projectionPoleW=-1.5] - Base W-coordinate of the projection pole.
     */
    constructor(projectionPoleW = -1.5) {
        super();
        this.baseProjectionPoleW = Math.abs(projectionPoleW) < 0.01 ? -1.0 : projectionPoleW;
    }

    /** Allows changing the base projection pole W-coordinate (less relevant now). */
    // setProjectionPoleW(poleW) { this.baseProjectionPoleW = Math.abs(poleW) < 0.01 ? -1.0 : poleW; }

    getShaderCode() {
        // Provides: vec3 project4Dto3D(vec4 p);
        return `
             // --- Stereographic Projection (4D to 3D) ---
             // Projects from a point (the 'pole') onto the w=0 hyperplane.
             vec3 project4Dto3D(vec4 p) {
                 // Base W-coordinate of the projection pole.
                 float basePoleW = ${this.baseProjectionPoleW.toFixed(2)};
                 // Modulate pole position slightly with audio for subtle warping
                 float dynamicPoleW = basePoleW + u_audioHigh * 0.3 * sign(basePoleW);
                 dynamicPoleW = sign(dynamicPoleW) * max(0.1, abs(dynamicPoleW)); // Keep sign, prevent zero

                 // Scaling factor derived from similar triangles.
                 // scale = (-poleW) / (p.w - poleW)
                 float denominator = p.w - dynamicPoleW;

                 // Avoid division by zero or near-zero. Clamp denominator magnitude.
                 float epsilon = 0.01;
                 vec3 projectedP;

                 if (abs(denominator) < epsilon) {
                      // Point is near the projection pole, return point far away.
                      projectedP = normalize(p.xyz) * 1000.0; // Simulate infinity
                 } else {
                    // Standard stereographic scaling
                    float scale = (-dynamicPoleW) / denominator;
                    projectedP = p.xyz * scale;
                 }

                 // Blend towards orthographic (p.xyz) using morph factor to soften extremes.
                 float morphT = smoothstep(0.0, 1.0, u_morphFactor * 0.8); // Limit morph effect range
                 vec3 orthoP = p.xyz;

                 return mix(projectedP, orthoP, morphT);
             }
         `;
    }
}


// --- Projection Manager Class ---

/**
 * Manages the registration and retrieval of different 4D-to-3D projection methods.
 */
class ProjectionManager {
    /**
     * Creates a new ProjectionManager instance.
     * @param {object} [options={}] - Configuration options.
     * @param {string} [options.defaultProjection='perspective'] - Default projection name.
     */
    constructor(options = {}) {
        this.options = this._mergeDefaults(options);
        /** @type {Object.<string, BaseProjection>} */
        this.projections = {};
        this._initProjections();
    }

    _mergeDefaults(options) {
        return {
            defaultProjection: 'perspective',
            ...options
        };
    }

    /** Initializes and registers the default set of projections. */
    _initProjections() {
        this.registerProjection('perspective', new PerspectiveProjection());
        this.registerProjection('orthographic', new OrthographicProjection());
        this.registerProjection('stereographic', new StereographicProjection());
        // Add registration for new projections here
    }

    /**
     * Registers a projection provider instance with a given name.
     * @param {string} name - The name to register the projection under. Lowercased internally.
     * @param {BaseProjection} projectionInstance - An instance extending BaseProjection.
     */
    registerProjection(name, projectionInstance) {
         const lowerCaseName = name.toLowerCase();
         if (!(projectionInstance instanceof BaseProjection)) {
            console.error(`ProjectionManager: Attempted to register invalid projection object for '${lowerCaseName}'. Must inherit from BaseProjection.`);
            return;
        }
         if (this.projections[lowerCaseName]) {
             console.warn(`ProjectionManager: Overwriting existing projection registration for '${lowerCaseName}'.`);
         }
        this.projections[lowerCaseName] = projectionInstance;
    }

    /**
     * Retrieves a registered projection provider by name. Falls back to default.
     * @param {string} name - The name of the projection to retrieve. Case-insensitive.
     * @returns {BaseProjection} The requested or default projection provider instance.
     */
    getProjection(name) {
        const lowerCaseName = name ? name.toLowerCase() : this.options.defaultProjection;
        const projection = this.projections[lowerCaseName];
        if (!projection) {
            console.warn(`ProjectionManager: Projection type '${name}' not found. Using default '${this.options.defaultProjection}'.`);
            return this.projections[this.options.defaultProjection.toLowerCase()];
        }
        return projection;
    }

    /** Returns an array of names of all registered projection types. */
    getProjectionTypes() {
        return Object.keys(this.projections);
    }
}

// Export necessary classes
export { ProjectionManager, BaseProjection, PerspectiveProjection, OrthographicProjection, StereographicProjection };
export default ProjectionManager;