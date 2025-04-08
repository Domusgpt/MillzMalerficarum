/* core/GeometryManager.js */

/**
 * Manages different types of geometric structures (e.g., Hypercube, Hypersphere)
 * and provides GLSL code snippets representing them for use in shaders.
 */

// --- Base Geometry Class ---

/**
 * @abstract
 * Base class for all geometry providers. Defines the interface.
 */
class BaseGeometry {
    constructor() {}

    /**
     * Returns the GLSL code snippet for calculating the geometry's appearance.
     * This code MUST define a function: `float calculateLattice(vec3 p)`
     * which takes a 3D point `p` in the sampling space and returns a float
     * value (ideally 0.0-1.0) representing the geometry's density/intensity at that point.
     *
     * The function can use uniforms like u_dimension, u_time, u_morphFactor,
     * u_gridDensity, u_universeModifier, audio uniforms, rotation matrices,
     * and the projection function `project4Dto3D(vec4 p)`.
     *
     * @abstract
     * @returns {string} GLSL code snippet.
     * @throws {Error} If not implemented by subclass.
     */
    getShaderCode() {
        throw new Error(`getShaderCode() must be implemented by geometry subclass.`);
    }
}

// --- Hypercube Geometry ---

/**
 * Represents a Tesseract (4D Hypercube) geometry, visualized as a 3D lattice
 * that folds through the 4th dimension based on various parameters.
 */
class HypercubeGeometry extends BaseGeometry {
    constructor() { super(); }

    getShaderCode() {
        // Provides: float calculateLattice(vec3 p);
        return `
            // --- Hypercube Lattice Calculation ---
            float calculateLattice(vec3 p) {
                // Grid density modulated by audio for pulsing effect
                float dynamicGridDensity = max(0.1, u_gridDensity * (1.0 + u_audioBass * 0.5)); // Increased bass effect

                // Base 3D lattice calculation
                vec3 p_grid3D = fract(p * dynamicGridDensity * 0.5); // Wrap coords
                vec3 dist3D = abs(p_grid3D - 0.5); // Distance from cell center
                float box3D = max(dist3D.x, max(dist3D.y, dist3D.z)); // Box distance (cube shape)
                float lineThickness = 0.05; // Base thickness
                float lattice3D = smoothstep(0.5, 0.5 - lineThickness, box3D); // Inverted smoothstep for lines

                // --- 4D Calculation & Projection (blend if u_dimension > 3.0) ---
                float finalLattice = lattice3D;
                float dim_factor = smoothstep(3.0, 3.8, u_dimension); // Factor 0-1 as dimension goes 3 -> 3.8+

                if (dim_factor > 0.01) { // Only compute 4D part if significantly > 3D
                    // Create a 4D point. 'w' coordinate influenced by position, time, morph, audio.
                    float w_coord = sin(p.x*1.3 - p.y*0.8 + p.z*1.6 + u_time * 0.2)
                                  * cos(length(p) * 1.2 - u_time * 0.3 + u_audioMid * 1.8)
                                  * dim_factor // Scale effect intensity by how "4D" we are
                                  * (0.35 + u_morphFactor * 0.6 + u_audioHigh * 0.4); // Mix factors influence amplitude

                    vec4 p4d = vec4(p, w_coord);

                    // Apply multiple 4D rotations based on time, rotationSpeed, audio, morph
                    float baseSpeed = u_rotationSpeed * 1.0; // Use rotationSpeed directly
                    float time_rot1 = u_time * 0.33 * baseSpeed + u_audioHigh * 0.15 + u_morphFactor * 0.4;
                    float time_rot2 = u_time * 0.28 * baseSpeed - u_audioMid * 0.2;
                    float time_rot3 = u_time * 0.25 * baseSpeed + u_audioBass * 0.25;

                    // Combine rotations (order matters) - Apply projection *before* final lattice calc
                    p4d = rotXW(time_rot1) * rotYZ(time_rot2 * 1.15) * rotZW(time_rot3 * 0.95) * p4d;
                    p4d = rotYW(u_time * -0.21 * baseSpeed) * p4d; // Add another complex rotation

                    // Project the rotated 4D point back to 3D using the injected projection function
                    vec3 projectedP = project4Dto3D(p4d);

                    // Calculate lattice for the projected 3D position
                    vec3 p_grid4D_proj = fract(projectedP * dynamicGridDensity * 0.5);
                    vec3 dist4D_proj = abs(p_grid4D_proj - 0.5);
                    float box4D_proj = max(dist4D_proj.x, max(dist4D_proj.y, dist4D_proj.z));
                    float lattice4D_proj = smoothstep(0.5, 0.5 - lineThickness, box4D_proj);

                    // Blend between the base 3D lattice and the projected 4D lattice based on morphFactor
                    float morphT = smoothstep(0.0, 1.0, u_morphFactor);
                    finalLattice = mix(lattice3D, lattice4D_proj, morphT);
                }

                // Apply universe modifier (compresses/expands space) - affects perceived thickness/density
                // Use pow for contrast. Ensure modifier is positive.
                // Modifier > 1 expands space (finer lattice), < 1 compresses (thicker lattice).
                return pow(finalLattice, 1.0 / max(0.1, u_universeModifier));
            }
        `;
    }
}

// --- Hypersphere Geometry ---

/**
 * Represents a Glome (4D Hypersphere) geometry, visualized as concentric 3D shells
 * warping through the 4th dimension.
 */
class HypersphereGeometry extends BaseGeometry {
    constructor() { super(); }

    getShaderCode() {
        // Provides: float calculateLattice(vec3 p);
        return `
            // --- Hypersphere Lattice Calculation ---
            float calculateLattice(vec3 p) {
                 // Calculate base radius in 3D space
                 float radius3D = length(p);
                 // Grid density affects shell frequency
                 float densityFactor = max(0.1, u_gridDensity * 0.8);
                 // Modulate shell width with audio bass
                 float shellWidth = 0.03 + u_audioBass * 0.05; // Adjust thickness range

                 // Spherical shells pattern in 3D using sine wave
                 // Modulate phase with time and mid frequencies
                 float phase = radius3D * densityFactor * 6.28318 - u_time * 0.6 + u_audioMid * 2.5;
                 float shells3D = 0.5 + 0.5 * sin(phase);
                 // Use smoothstep to create sharp shells from the sine wave peaks
                 shells3D = smoothstep(1.0 - shellWidth, 1.0, shells3D);

                // --- 4D Calculation & Projection ---
                float finalLattice = shells3D;
                 float dim_factor = smoothstep(3.0, 3.8, u_dimension); // Factor 0-1

                if (dim_factor > 0.01) {
                    // Define w-coordinate based on position, radius, time, morph, audio
                     float w_coord = cos(radius3D * 2.8 - u_time * 0.5)
                                   * sin(p.x*0.9 + p.y*1.2 - p.z*0.6 + u_time*0.18)
                                   * dim_factor // Scale effect by dimension factor
                                   * (0.45 + u_morphFactor * 0.55 + u_audioHigh * 0.35); // Amplitude mixing

                    vec4 p4d = vec4(p, w_coord);

                     // Apply 4D rotations influenced by audio, speed, morph
                     float baseSpeed = u_rotationSpeed * 0.8; // Slightly slower base for sphere
                     float time_rot1 = u_time * 0.38 * baseSpeed + u_audioHigh * 0.12;
                     float time_rot2 = u_time * 0.31 * baseSpeed + u_morphFactor * 0.5; // Morph affects rotation
                     float time_rot3 = u_time * -0.24 * baseSpeed + u_audioBass * 0.18;

                     p4d = rotXW(time_rot1 * 1.1) * rotYZ(time_rot2) * rotYW(time_rot3 * 0.9) * p4d;

                     // Project back to 3D using injected function
                     vec3 projectedP = project4Dto3D(p4d);

                     // Calculate radius and shell pattern in projected 3D space
                     float radius4D_proj = length(projectedP);
                     float phase4D = radius4D_proj * densityFactor * 6.28318 - u_time * 0.6 + u_audioMid * 2.5;
                     float shells4D_proj = 0.5 + 0.5 * sin(phase4D);
                     shells4D_proj = smoothstep(1.0 - shellWidth, 1.0, shells4D_proj);

                     // Blend 3D and projected 4D shells based on morphFactor
                     float morphT = smoothstep(0.0, 1.0, u_morphFactor);
                     finalLattice = mix(shells3D, shells4D_proj, morphT);
                 }

                // Apply universe modifier - affects perceived radius/density
                // Using pow affects the brightness/thickness of the shells.
                return pow(max(0.0, finalLattice), max(0.1, u_universeModifier));
            }
        `;
    }
}

// --- Hypertetrahedron Geometry ---

/**
 * Represents a 5-Cell (4D Hypertetrahedron) geometry, visualized as a 3D
 * tetrahedral grid structure folding through the 4th dimension.
 * (Simplified representation focusing on planar structures).
 */
class HypertetrahedronGeometry extends BaseGeometry {
    constructor() { super(); }

    getShaderCode() {
        // Provides: float calculateLattice(vec3 p);
        return `
             // --- Hypertetrahedron Lattice Calculation (Simplified Planar Grid) ---
             float calculateLattice(vec3 p) {
                 // Density affects grid scale
                 float density = max(0.1, u_gridDensity * 0.7);
                 // Modulate line thickness with audio bass
                 float thickness = 0.04 + u_audioBass * 0.06;

                 // Define corners/normals of a base tetrahedron (normalized)
                 vec3 c1 = normalize(vec3( 1.0,  1.0,  1.0));
                 vec3 c2 = normalize(vec3(-1.0, -1.0,  1.0));
                 vec3 c3 = normalize(vec3(-1.0,  1.0, -1.0));
                 vec3 c4 = normalize(vec3( 1.0, -1.0, -1.0));

                 // --- 3D Calculation ---
                 // Calculate position within a repeating cell (centered at origin)
                 vec3 p_mod3D = fract(p * density * 0.5) - 0.5;
                 // Calculate signed distance to the 4 planes defining the tetrahedron cell
                 float d1 = dot(p_mod3D, c1); float d2 = dot(p_mod3D, c2);
                 float d3 = dot(p_mod3D, c3); float d4 = dot(p_mod3D, c4);
                 // Find the minimum distance to any plane (absolute value)
                 float minDistToPlane3D = min(min(abs(d1), abs(d2)), min(abs(d3), abs(d4)));
                 // Create lines/planes using smoothstep: bright near distance 0
                 float lattice3D = 1.0 - smoothstep(0.0, thickness, minDistToPlane3D);

                 // --- 4D Calculation & Projection ---
                 float finalLattice = lattice3D;
                 float dim_factor = smoothstep(3.0, 3.8, u_dimension); // Factor 0-1

                 if (dim_factor > 0.01) {
                     // Define w-coordinate influenced by audio, time, morph
                     float w_coord = cos(p.x*1.9 - p.y*1.4 + p.z*1.1 + u_time * 0.22)
                                   * sin(length(p)*1.5 + u_time*0.15 - u_audioMid*1.5)
                                   * dim_factor // Scale effect by dimension factor
                                   * (0.4 + u_morphFactor * 0.6 + u_audioHigh * 0.3); // Amplitude

                     vec4 p4d = vec4(p, w_coord);

                     // Apply 4D rotations
                     float baseSpeed = u_rotationSpeed * 1.1; // Faster base speed for tetra
                     float time_rot1 = u_time * 0.28 * baseSpeed + u_audioHigh * 0.18;
                     float time_rot2 = u_time * 0.36 * baseSpeed - u_audioBass * 0.15 + u_morphFactor * 0.35;
                     float time_rot3 = u_time * 0.32 * baseSpeed + u_audioMid * 0.1;

                     p4d = rotXW(time_rot1 * 0.9) * rotYW(time_rot2 * 1.1) * rotZW(time_rot3) * p4d;

                     // Project back to 3D
                     vec3 projectedP = project4Dto3D(p4d);

                     // Calculate similar tetrahedral pattern for the projected point
                     vec3 p_mod4D_proj = fract(projectedP * density * 0.5) - 0.5;
                     float dp1 = dot(p_mod4D_proj, c1); float dp2 = dot(p_mod4D_proj, c2);
                     float dp3 = dot(p_mod4D_proj, c3); float dp4 = dot(p_mod4D_proj, c4);
                     float minDistToPlane4D = min(min(abs(dp1), abs(dp2)), min(abs(dp3), abs(dp4)));
                     float lattice4D_proj = 1.0 - smoothstep(0.0, thickness, minDistToPlane4D);

                    // Blend based on morphFactor
                    float morphT = smoothstep(0.0, 1.0, u_morphFactor);
                    finalLattice = mix(lattice3D, lattice4D_proj, morphT);
                 }

                 // Apply universe modifier, e.g., sharpening/softening effect
                 return pow(max(0.0, finalLattice), max(0.1, u_universeModifier));
             }
         `;
    }
}


// --- Geometry Manager Class ---

/**
 * Manages the registration and retrieval of different geometry providers.
 */
class GeometryManager {
    /**
     * Creates a new GeometryManager instance.
     * @param {object} [options={}] - Configuration options.
     * @param {string} [options.defaultGeometry='hypercube'] - The name of the default geometry.
     */
    constructor(options = {}) {
        this.options = this._mergeDefaults(options);
        /** @type {Object.<string, BaseGeometry>} */
        this.geometries = {};
        this._initGeometries();
    }

    _mergeDefaults(options) {
        return {
            defaultGeometry: 'hypercube',
            ...options
        };
    }

    /** Initializes and registers the default set of geometries. */
    _initGeometries() {
        this.registerGeometry('hypercube', new HypercubeGeometry());
        this.registerGeometry('hypersphere', new HypersphereGeometry());
        this.registerGeometry('hypertetrahedron', new HypertetrahedronGeometry());
        // Add registration for new custom geometries here if needed
    }

    /**
     * Registers a geometry provider instance with a given name.
     * @param {string} name - The name to register the geometry under (e.g., 'hypercube'). Lowercased internally.
     * @param {BaseGeometry} geometryInstance - An instance extending BaseGeometry.
     */
    registerGeometry(name, geometryInstance) {
        const lowerCaseName = name.toLowerCase();
        if (!(geometryInstance instanceof BaseGeometry)) {
            console.error(`GeometryManager: Attempted to register invalid geometry object for '${lowerCaseName}'. Must inherit from BaseGeometry.`);
            return;
        }
        if (this.geometries[lowerCaseName]) {
             console.warn(`GeometryManager: Overwriting existing geometry registration for '${lowerCaseName}'.`);
        }
        this.geometries[lowerCaseName] = geometryInstance;
        // console.log(`GeometryManager: Registered geometry '${lowerCaseName}'`);
    }

    /**
     * Retrieves a registered geometry provider by name. Falls back to default.
     * @param {string} name - The name of the geometry to retrieve. Case-insensitive.
     * @returns {BaseGeometry} The requested or default geometry provider instance.
     */
    getGeometry(name) {
        const lowerCaseName = name ? name.toLowerCase() : this.options.defaultGeometry;
        const geometry = this.geometries[lowerCaseName];
        if (!geometry) {
            console.warn(`GeometryManager: Geometry type '${name}' not found. Using default '${this.options.defaultGeometry}'.`);
            return this.geometries[this.options.defaultGeometry.toLowerCase()];
        }
        return geometry;
    }

    /** Returns an array of names of all registered geometry types. */
    getGeometryTypes() {
        return Object.keys(this.geometries);
    }
}

// Export necessary classes
export { GeometryManager, BaseGeometry, HypercubeGeometry, HypersphereGeometry, HypertetrahedronGeometry };
export default GeometryManager;