import {ENTITY_FLAGS} from '../../ENTITY_FLAGS.js';
import {RENDER_PASSES} from '../../RENDER_PASSES.js';

import {math} from "../../../../../math/math.js";
import {RenderState} from "../../../../../webgl/RenderState.js";
import {ArrayBuf} from "../../../../../webgl/ArrayBuf.js";
import {geometryCompressionUtils} from "../../../../../math/geometryCompressionUtils.js";
import {getBatchingRenderers} from "./TrianglesBatchingRenderers.js";
import {TrianglesBatchingBuffer} from "./TrianglesBatchingBuffer.js";
import {quantizePositions, transformAndOctEncodeNormals} from "../../compression.js";

const tempMat4 = math.mat4();
const tempMat4b = math.mat4();
const tempVec4a = math.vec4([0, 0, 0, 1]);
const tempVec4b = math.vec4([0, 0, 0, 1]);
const tempVec4c = math.vec4([0, 0, 0, 1]);
const tempOBB3 = math.OBB3();

const tempVec3a = math.vec3();
const tempVec3b = math.vec3();
const tempVec3c = math.vec3();
const tempVec3d = math.vec3();
const tempVec3e = math.vec3();
const tempVec3f = math.vec3();
const tempVec3g = math.vec3();

/**
 * @private
 */
class TrianglesBatchingLayer {

    /**
     * @param model
     * @param cfg.model
     * @param cfg.autoNormals
     * @param cfg.layerIndex
     * @param cfg.positionsDecodeMatrix
     * @param cfg.uvDecodeMatrix
     * @param cfg.maxGeometryBatchSize
     * @param cfg.origin
     * @param cfg.scratchMemory
     * @param cfg.textureSet
     * @param cfg.solid
     */
    constructor(cfg) {

        /**
         * Owner model
         * @type {VBOSceneModel}
         */
        this.model = cfg.model;

        /**
         * State sorting key.
         * @type {string}
         */
        this.sortId = "TrianglesBatchingLayer"
            + (cfg.solid ? "-solid" : "-surface")
            + (cfg.autoNormals ? "-autonormals" : "-normals")

            // TODO: These two parts need to be IDs (ie. unique):

            + (cfg.textureSet && cfg.textureSet.colorTexture ? "-colorTexture" : "")
            + (cfg.textureSet && cfg.textureSet.metallicRoughnessTexture ? "-metallicRoughnessTexture" : "");

        /**
         * Index of this TrianglesBatchingLayer in {@link VBOSceneModel#_layerList}.
         * @type {Number}
         */
        this.layerIndex = cfg.layerIndex;

        this._batchingRenderers = getBatchingRenderers(cfg.model.scene);
        this._buffer = new TrianglesBatchingBuffer(cfg.maxGeometryBatchSize);
        this._scratchMemory = cfg.scratchMemory;

        this._state = new RenderState({
            origin: math.vec3(),
            positionsBuf: null,
            offsetsBuf: null,
            normalsBuf: null,
            colorsBuf: null,
            uvBuf: null,
            metallicRoughnessBuf: null,
            flagsBuf: null,
            flags2Buf: null,
            indicesBuf: null,
            edgeIndicesBuf: null,
            positionsDecodeMatrix: math.mat4(),
            uvDecodeMatrix: null,
            textureSet: cfg.textureSet,
            pbrSupported: false // Set in #finalize if we have enough to support quality rendering
        });

        // These counts are used to avoid unnecessary render passes
        this._numPortions = 0;
        this._numVisibleLayerPortions = 0;
        this._numTransparentLayerPortions = 0;
        this._numXRayedLayerPortions = 0;
        this._numSelectedLayerPortions = 0;
        this._numHighlightedLayerPortions = 0;
        this._numClippableLayerPortions = 0;
        this._numEdgesLayerPortions = 0;
        this._numPickableLayerPortions = 0;
        this._numCulledLayerPortions = 0;

        this._modelAABB = math.collapseAABB3(); // Model-space AABB
        this._portions = [];

        this._numVerts = 0;

        this._finalized = false;

        if (cfg.positionsDecodeMatrix) {
            this._state.positionsDecodeMatrix.set(cfg.positionsDecodeMatrix);
            this._preCompressedPositionsExpected = true;
        } else {
            this._preCompressedPositionsExpected = false;
        }

        if (cfg.uvDecodeMatrix) {
            this._state.uvDecodeMatrix = math.mat3(cfg.uvDecodeMatrix);
            this._preCompressedNormalsExpected = true;
        } else {
            this._preCompressedNormalsExpected = false;
        }

        if (cfg.origin) {
            this._state.origin.set(cfg.origin);
        }

        /**
         * The axis-aligned World-space boundary of this TrianglesBatchingLayer's positions.
         * @type {*|Float64Array}
         */
        this.aabb = math.collapseAABB3();

        /**
         * When true, this layer contains solid triangle meshes, otherwise this layer contains surface triangle meshes
         * @type {boolean}
         */
        this.solid = !!cfg.solid;
    }

    /**
     * Tests if there is room for another portion in this TrianglesBatchingLayer.
     *
     * @param lenPositions Number of positions we'd like to create in the portion.
     * @param lenIndices Number of indices we'd like to create in this portion.
     * @returns {boolean} True if OK to create another portion.
     */
    canCreatePortion(lenPositions, lenIndices) {
        if (this._finalized) {
            throw "Already finalized";
        }
        return ((this._buffer.positions.length + lenPositions) < (this._buffer.maxVerts * 3) && (this._buffer.indices.length + lenIndices) < (this._buffer.maxIndices));
    }

    /**
     * Creates a new portion within this TrianglesBatchingLayer, returns the new portion ID.
     *
     * Gives the portion the specified geometry, color and matrix.
     *
     * @param cfg.positions Flat float Local-space positions array.
     * @param cfg.positionsCompressed Flat quantized positions array - decompressed with TrianglesBatchingLayer positionsDecodeMatrix
     * @param [cfg.normals] Flat float normals array.
     * @param [cfg.uv] Flat UVs array.
     * @param [cfg.uvCompressed]
     * @param [cfg.colors] Flat float colors array.
     * @param [cfg.colorsCompressed]
     * @param cfg.indices  Flat int indices array.
     * @param [cfg.edgeIndices] Flat int edges indices array.
     * @param cfg.color Quantized RGB color [0..255,0..255,0..255,0..255]
     * @param cfg.metallic Metalness factor [0..255]
     * @param cfg.roughness Roughness factor [0..255]
     * @param cfg.opacity Opacity [0..255]
     * @param [cfg.meshMatrix] Flat float 4x4 matrix
     * @param [cfg.worldMatrix] Flat float 4x4 matrix
     * @param cfg.worldAABB Flat float AABB World-space AABB
     * @param cfg.pickColor Quantized pick color
     * @returns {number} Portion ID
     */
    createPortion(cfg) {

        if (this._finalized) {
            throw "Already finalized";
        }

        const positions = cfg.positions;
        const positionsCompressed = cfg.positionsCompressed;
        const normals = cfg.normals;
        const normalsCompressed = cfg.normalsCompressed;
        const uv = cfg.uv;
        const uvCompressed = cfg.uvCompressed;
        const colors = cfg.colors;
        const colorsCompressed = cfg.colorsCompressed;
        const indices = cfg.indices;
        const edgeIndices = cfg.edgeIndices;
        const color = cfg.color;
        const metallic = cfg.metallic;
        const roughness = cfg.roughness;
        const opacity = cfg.opacity;
        const meshMatrix = cfg.meshMatrix;
        const worldMatrix = cfg.worldMatrix;
        const worldAABB = cfg.worldAABB;
        const pickColor = cfg.pickColor;

        const scene = this.model.scene;
        const buffer = this._buffer;
        const positionsIndex = buffer.positions.length;
        const vertsIndex = positionsIndex / 3;

        let numVerts;


        if (this._preCompressedPositionsExpected) {

            if (!positionsCompressed) {
                throw "positionsCompressed expected";
            }

            numVerts = positionsCompressed.length / 3;

            for (let i = 0, len = positionsCompressed.length; i < len; i++) {
                buffer.positions.push(positionsCompressed[i]);
            }

            const bounds = geometryCompressionUtils.getPositionsBounds(positionsCompressed);

            const min = geometryCompressionUtils.decompressPosition(bounds.min, this._state.positionsDecodeMatrix, []);
            const max = geometryCompressionUtils.decompressPosition(bounds.max, this._state.positionsDecodeMatrix, []);

            worldAABB[0] = min[0];
            worldAABB[1] = min[1];
            worldAABB[2] = min[2];
            worldAABB[3] = max[0];
            worldAABB[4] = max[1];
            worldAABB[5] = max[2];

            if (worldMatrix) {
                math.AABB3ToOBB3(worldAABB, tempOBB3);
                math.transformOBB3(worldMatrix, tempOBB3);
                math.OBB3ToAABB3(tempOBB3, worldAABB);
            }

        } else {

            if (!positions) {
                throw "positions expected";
            }

            numVerts = positions.length / 3;

            const lenPositions = positions.length;

            const positionsBase = buffer.positions.length;

            for (let i = 0, len = positions.length; i < len; i++) {
                buffer.positions.push(positions[i]);
            }

            if (meshMatrix) {

                for (let i = positionsBase, len = positionsBase + lenPositions; i < len; i += 3) {

                    tempVec4a[0] = buffer.positions[i + 0];
                    tempVec4a[1] = buffer.positions[i + 1];
                    tempVec4a[2] = buffer.positions[i + 2];

                    math.transformPoint4(meshMatrix, tempVec4a, tempVec4b);

                    buffer.positions[i + 0] = tempVec4b[0];
                    buffer.positions[i + 1] = tempVec4b[1];
                    buffer.positions[i + 2] = tempVec4b[2];

                    math.expandAABB3Point3(this._modelAABB, tempVec4b);

                    if (worldMatrix) {
                        math.transformPoint4(worldMatrix, tempVec4b, tempVec4c);
                        math.expandAABB3Point3(worldAABB, tempVec4c);
                    } else {
                        math.expandAABB3Point3(worldAABB, tempVec4b);
                    }
                }

            } else {

                for (let i = positionsBase, len = positionsBase + lenPositions; i < len; i += 3) {

                    tempVec4a[0] = buffer.positions[i + 0];
                    tempVec4a[1] = buffer.positions[i + 1];
                    tempVec4a[2] = buffer.positions[i + 2];

                    math.expandAABB3Point3(this._modelAABB, tempVec4a);

                    if (worldMatrix) {
                        math.transformPoint4(worldMatrix, tempVec4a, tempVec4b);
                        math.expandAABB3Point3(worldAABB, tempVec4b);
                    } else {
                        math.expandAABB3Point3(worldAABB, tempVec4a);
                    }
                }
            }
        }

        if (this._state.origin) {
            const origin = this._state.origin;
            worldAABB[0] += origin[0];
            worldAABB[1] += origin[1];
            worldAABB[2] += origin[2];
            worldAABB[3] += origin[0];
            worldAABB[4] += origin[1];
            worldAABB[5] += origin[2];
        }

        math.expandAABB3(this.aabb, worldAABB);

        if (normalsCompressed && normalsCompressed.length > 0) {
            for (let i = 0, len = normalsCompressed.length; i < len; i++) {
                buffer.normals.push(normalsCompressed[i]);
            }
        } else if (normals && normals.length > 0) {
            const worldNormalMatrix = tempMat4;
            if (meshMatrix) {
                math.inverseMat4(math.transposeMat4(meshMatrix, tempMat4b), worldNormalMatrix); // Note: order of inverse and transpose doesn't matter
            } else {
                math.identityMat4(worldNormalMatrix, worldNormalMatrix);
            }
            transformAndOctEncodeNormals(worldNormalMatrix, normals, normals.length, buffer.normals, buffer.normals.length);
        }

        if (colors) {
            for (let i = 0, len = colors.length; i < len; i += 3) {
                buffer.colors.push(colors[i] * 255);
                buffer.colors.push(colors[i + 1] * 255);
                buffer.colors.push(colors[i + 2] * 255);
                buffer.colors.push(255);
            }
        } else if (colorsCompressed) {
            for (let i = 0, len = colors.length; i < len; i += 3) {
                buffer.colors.push(colors[i]);
                buffer.colors.push(colors[i + 1]);
                buffer.colors.push(colors[i + 2]);
                buffer.colors.push(255);
            }
        } else if (color) {
            const r = color[0]; // Color is pre-quantized by VBOSceneModel
            const g = color[1];
            const b = color[2];
            const a = opacity;
            const metallicValue = (metallic !== null && metallic !== undefined) ? metallic : 0;
            const roughnessValue = (roughness !== null && roughness !== undefined) ? roughness : 255;
            for (let i = 0; i < numVerts; i++) {
                buffer.colors.push(r);
                buffer.colors.push(g);
                buffer.colors.push(b);
                buffer.colors.push(a);
                buffer.metallicRoughness.push(metallicValue);
                buffer.metallicRoughness.push(roughnessValue);
            }
        }

        if (uv && uv.length > 0) {
            for (let i = 0, len = uv.length; i < len; i++) {
                buffer.uv.push(uv[i]);
            }
        } else if (uvCompressed && uvCompressed.length > 0) {
            for (let i = 0, len = uvCompressed.length; i < len; i++) {
                buffer.uv.push(uvCompressed[i]);
            }
        }

        if (indices) {
            for (let i = 0, len = indices.length; i < len; i++) {
                buffer.indices.push(indices[i] + vertsIndex);
            }
        }

        if (edgeIndices) {
            for (let i = 0, len = edgeIndices.length; i < len; i++) {
                buffer.edgeIndices.push(edgeIndices[i] + vertsIndex);
            }
        }

        {
            const pickColorsBase = buffer.pickColors.length;
            const lenPickColors = numVerts * 4;
            for (let i = pickColorsBase, len = pickColorsBase + lenPickColors; i < len; i += 4) {
                buffer.pickColors.push(pickColor[0]);
                buffer.pickColors.push(pickColor[1]);
                buffer.pickColors.push(pickColor[2]);
                buffer.pickColors.push(pickColor[3]);
            }
        }

        if (scene.entityOffsetsEnabled) {
            for (let i = 0; i < numVerts; i++) {
                buffer.offsets.push(0);
                buffer.offsets.push(0);
                buffer.offsets.push(0);
            }
        }

        const portionId = this._portions.length;

        const portion = {
            vertsBase: vertsIndex,
            numVerts: numVerts
        };

        if (scene.pickSurfacePrecisionEnabled) {
            // Quantized in-memory positions are initialized in finalize()
            if (indices) {
                portion.indices = indices;
            }
            if (scene.entityOffsetsEnabled) {
                portion.offset = new Float32Array(3);
            }
        }

        this._portions.push(portion);

        this._numPortions++;

        this.model.numPortions++;

        this._numVerts += portion.numVerts;

        return portionId;
    }

    /**
     * Builds batch VBOs from appended geometries.
     * No more portions can then be created.
     */
    finalize() {

        if (this._finalized) {
            this.model.error("Already finalized");
            return;
        }

        const state = this._state;
        const gl = this.model.scene.canvas.gl;
        const buffer = this._buffer;

        if (buffer.positions.length > 0) {

            const quantizedPositions = (this._preCompressedPositionsExpected)
                ? new Uint16Array(buffer.positions)
                : quantizePositions(buffer.positions, this._modelAABB, state.positionsDecodeMatrix); // BOTTLENECK

            state.positionsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, quantizedPositions, quantizedPositions.length, 3, gl.STATIC_DRAW);

            if (this.model.scene.pickSurfacePrecisionEnabled) {
                for (let i = 0, numPortions = this._portions.length; i < numPortions; i++) {
                    const portion = this._portions[i];
                    const start = portion.vertsBase * 3;
                    const end = start + (portion.numVerts * 3);
                    portion.quantizedPositions = quantizedPositions.slice(start, end);
                }
            }
        }

        if (buffer.normals.length > 0) {
            const normals = new Int8Array(buffer.normals);
            let normalized = true; // For oct encoded UInts
            state.normalsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, normals, buffer.normals.length, 3, gl.STATIC_DRAW, normalized);
        }

        if (buffer.colors.length > 0) {
            const colors = new Uint8Array(buffer.colors);
            let normalized = false;
            state.colorsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, colors, buffer.colors.length, 4, gl.DYNAMIC_DRAW, normalized);
        }

        if (buffer.uv.length > 0) {
            if (!state.uvDecodeMatrix) {
                const bounds = geometryCompressionUtils.getUVBounds(buffer.uv);
                const result = geometryCompressionUtils.compressUVs(buffer.uv, bounds.min, bounds.max);
                const uv = result.quantized;
                let notNormalized = false;
                state.uvDecodeMatrix = math.mat3(result.decodeMatrix);
                state.uvBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, uv, uv.length, 2, gl.STATIC_DRAW, notNormalized);
            } else {
                let notNormalized = false;
                state.uvBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, buffer.uv, buffer.uv.length, 2, gl.STATIC_DRAW, notNormalized);
            }
        }

        if (buffer.metallicRoughness.length > 0) {
            const metallicRoughness = new Uint8Array(buffer.metallicRoughness);
            let normalized = false;
            state.metallicRoughnessBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, metallicRoughness, buffer.metallicRoughness.length, 2, gl.STATIC_DRAW, normalized);
        }

        if (buffer.positions.length > 0) { // Because we build flags arrays here, get their length from the positions array
            const flagsLength = (buffer.positions.length / 3) * 4;
            const flags = new Uint8Array(flagsLength);
            const flags2 = new Uint8Array(flagsLength);
            let notNormalized = false;
            let normalized = true;
            state.flagsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, flags, flags.length, 4, gl.DYNAMIC_DRAW, notNormalized);
            state.flags2Buf = new ArrayBuf(gl, gl.ARRAY_BUFFER, flags2, flags2.length, 4, gl.DYNAMIC_DRAW, normalized);
        }

        if (buffer.pickColors.length > 0) {
            const pickColors = new Uint8Array(buffer.pickColors);
            let normalized = false;
            state.pickColorsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, pickColors, buffer.pickColors.length, 4, gl.STATIC_DRAW, normalized);
        }

        if (this.model.scene.entityOffsetsEnabled) {
            if (buffer.offsets.length > 0) {
                const offsets = new Float32Array(buffer.offsets);
                state.offsetsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, offsets, buffer.offsets.length, 3, gl.DYNAMIC_DRAW);
            }
        }

        if (buffer.indices.length > 0) {
            const indices = new Uint32Array(buffer.indices);
            state.indicesBuf = new ArrayBuf(gl, gl.ELEMENT_ARRAY_BUFFER, indices, buffer.indices.length, 1, gl.STATIC_DRAW);
        }
        if (buffer.edgeIndices.length > 0) {
            const edgeIndices = new Uint32Array(buffer.edgeIndices);
            state.edgeIndicesBuf = new ArrayBuf(gl, gl.ELEMENT_ARRAY_BUFFER, edgeIndices, buffer.edgeIndices.length, 1, gl.STATIC_DRAW);
        }

        this._state.pbrSupported
            = !!state.metallicRoughnessBuf
            && !!state.uvBuf
            && !!state.normalsBuf
            && !!state.textureSet
            && !!state.textureSet.colorTexture
            && !!state.textureSet.metallicRoughnessTexture;

        this._state.colorTextureSupported
            = !!state.uvBuf
            && !!state.normalsBuf
            && !!state.textureSet
            && !!state.textureSet.colorTexture;

        this._buffer = null;
        this._finalized = true;
    }

    isEmpty() {
        return (!this._state.indicesBuf);
    }

    initFlags(portionId, flags, meshTransparent) {
        if (flags & ENTITY_FLAGS.VISIBLE) {
            this._numVisibleLayerPortions++;
            this.model.numVisibleLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.HIGHLIGHTED) {
            this._numHighlightedLayerPortions++;
            this.model.numHighlightedLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.XRAYED) {
            this._numXRayedLayerPortions++;
            this.model.numXRayedLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.SELECTED) {
            this._numSelectedLayerPortions++;
            this.model.numSelectedLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.CLIPPABLE) {
            this._numClippableLayerPortions++;
            this.model.numClippableLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.EDGES) {
            this._numEdgesLayerPortions++;
            this.model.numEdgesLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.PICKABLE) {
            this._numPickableLayerPortions++;
            this.model.numPickableLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.CULLED) {
            this._numCulledLayerPortions++;
            this.model.numCulledLayerPortions++;
        }
        if (meshTransparent) {
            this._numTransparentLayerPortions++;
            this.model.numTransparentLayerPortions++;
        }
        const deferred = true;
        this._setFlags(portionId, flags, meshTransparent, deferred);
        this._setFlags2(portionId, flags, deferred);
    }

    flushInitFlags() {
        this._setDeferredFlags();
        this._setDeferredFlags2();
    }

    setVisible(portionId, flags, transparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.VISIBLE) {
            this._numVisibleLayerPortions++;
            this.model.numVisibleLayerPortions++;
        } else {
            this._numVisibleLayerPortions--;
            this.model.numVisibleLayerPortions--;
        }
        this._setFlags(portionId, flags, transparent);
    }

    setHighlighted(portionId, flags, transparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.HIGHLIGHTED) {
            this._numHighlightedLayerPortions++;
            this.model.numHighlightedLayerPortions++;
        } else {
            this._numHighlightedLayerPortions--;
            this.model.numHighlightedLayerPortions--;
        }
        this._setFlags(portionId, flags, transparent);
    }

    setXRayed(portionId, flags, transparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.XRAYED) {
            this._numXRayedLayerPortions++;
            this.model.numXRayedLayerPortions++;
        } else {
            this._numXRayedLayerPortions--;
            this.model.numXRayedLayerPortions--;
        }
        this._setFlags(portionId, flags, transparent);
    }

    setSelected(portionId, flags, transparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.SELECTED) {
            this._numSelectedLayerPortions++;
            this.model.numSelectedLayerPortions++;
        } else {
            this._numSelectedLayerPortions--;
            this.model.numSelectedLayerPortions--;
        }
        this._setFlags(portionId, flags, transparent);
    }

    setEdges(portionId, flags, transparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.EDGES) {
            this._numEdgesLayerPortions++;
            this.model.numEdgesLayerPortions++;
        } else {
            this._numEdgesLayerPortions--;
            this.model.numEdgesLayerPortions--;
        }
        this._setFlags(portionId, flags, transparent);
    }

    setClippable(portionId, flags) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.CLIPPABLE) {
            this._numClippableLayerPortions++;
            this.model.numClippableLayerPortions++;
        } else {
            this._numClippableLayerPortions--;
            this.model.numClippableLayerPortions--;
        }
        this._setFlags2(portionId, flags);
    }

    setCulled(portionId, flags, transparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.CULLED) {
            this._numCulledLayerPortions++;
            this.model.numCulledLayerPortions++;
        } else {
            this._numCulledLayerPortions--;
            this.model.numCulledLayerPortions--;
        }
        this._setFlags(portionId, flags, transparent);
    }

    setCollidable(portionId, flags) {
        if (!this._finalized) {
            throw "Not finalized";
        }
    }

    setPickable(portionId, flags, transparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.PICKABLE) {
            this._numPickableLayerPortions++;
            this.model.numPickableLayerPortions++;
        } else {
            this._numPickableLayerPortions--;
            this.model.numPickableLayerPortions--;
        }
        this._setFlags(portionId, flags, transparent);
    }

    setColor(portionId, color) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        const portionsIdx = portionId;
        const portion = this._portions[portionsIdx];
        const vertexBase = portion.vertsBase;
        const numVerts = portion.numVerts;
        const firstColor = vertexBase * 4;
        const lenColor = numVerts * 4;
        const tempArray = this._scratchMemory.getUInt8Array(lenColor);
        const r = color[0];
        const g = color[1];
        const b = color[2];
        const a = color[3];
        for (let i = 0; i < lenColor; i += 4) {
            tempArray[i + 0] = r;
            tempArray[i + 1] = g;
            tempArray[i + 2] = b;
            tempArray[i + 3] = a;
        }
        if (this._state.colorsBuf) {
            this._state.colorsBuf.setData(tempArray, firstColor, lenColor);
        }
    }

    setTransparent(portionId, flags, transparent) {
        if (transparent) {
            this._numTransparentLayerPortions++;
            this.model.numTransparentLayerPortions++;
        } else {
            this._numTransparentLayerPortions--;
            this.model.numTransparentLayerPortions--;
        }
        this._setFlags(portionId, flags, transparent);
    }

    _setFlags(portionId, flags, transparent, deferred = false) {

        if (!this._finalized) {
            throw "Not finalized";
        }

        const portionsIdx = portionId;
        const portion = this._portions[portionsIdx];
        const vertexBase = portion.vertsBase;
        const numVerts = portion.numVerts;
        const firstFlag = vertexBase * 4;
        const lenFlags = numVerts * 4;

        const visible = !!(flags & ENTITY_FLAGS.VISIBLE);
        const xrayed = !!(flags & ENTITY_FLAGS.XRAYED);
        const highlighted = !!(flags & ENTITY_FLAGS.HIGHLIGHTED);
        const selected = !!(flags & ENTITY_FLAGS.SELECTED);
        const edges = !!(flags & ENTITY_FLAGS.EDGES);
        const pickable = !!(flags & ENTITY_FLAGS.PICKABLE);
        const culled = !!(flags & ENTITY_FLAGS.CULLED);

        // Color

        let f0;
        if (!visible || culled || xrayed
            || (highlighted && !this.model.scene.highlightMaterial.glowThrough)
            || (selected && !this.model.scene.selectedMaterial.glowThrough) ) {
            f0 = RENDER_PASSES.NOT_RENDERED;
        } else {
            if (transparent) {
                f0 = RENDER_PASSES.COLOR_TRANSPARENT;
            } else {
                f0 = RENDER_PASSES.COLOR_OPAQUE;
            }
        }

        // Silhouette

        let f1;
        if (!visible || culled) {
            f1 = RENDER_PASSES.NOT_RENDERED;
        } else if (selected) {
            f1 = RENDER_PASSES.SILHOUETTE_SELECTED;
        } else if (highlighted) {
            f1 = RENDER_PASSES.SILHOUETTE_HIGHLIGHTED;
        } else if (xrayed) {
            f1 = RENDER_PASSES.SILHOUETTE_XRAYED;
        } else {
            f1 = RENDER_PASSES.NOT_RENDERED;
        }

        // Edges

        let f2 = 0;
        if (!visible || culled) {
            f2 = RENDER_PASSES.NOT_RENDERED;
        } else if (selected) {
            f2 = RENDER_PASSES.EDGES_SELECTED;
        } else if (highlighted) {
            f2 = RENDER_PASSES.EDGES_HIGHLIGHTED;
        } else if (xrayed) {
            f2 = RENDER_PASSES.EDGES_XRAYED;
        } else if (edges) {
            if (transparent) {
                f2 = RENDER_PASSES.EDGES_COLOR_TRANSPARENT;
            } else {
                f2 = RENDER_PASSES.EDGES_COLOR_OPAQUE;
            }
        } else {
            f2 = RENDER_PASSES.NOT_RENDERED;
        }

        // Pick

        let f3 = (visible && !culled && pickable) ? RENDER_PASSES.PICK : RENDER_PASSES.NOT_RENDERED;

        if (deferred) {
            // Avoid zillions of individual WebGL bufferSubData calls - buffer them to apply in one shot
            if (!this._deferredFlagValues) {
                this._deferredFlagValues = new Uint8Array(this._numVerts * 4);
            }
            for (let i = firstFlag, len = (firstFlag + lenFlags); i < len; i += 4) {
                this._deferredFlagValues[i + 0] = f0;
                this._deferredFlagValues[i + 1] = f1;
                this._deferredFlagValues[i + 2] = f2;
                this._deferredFlagValues[i + 3] = f3;
            }
        } else if (this._state.flagsBuf) {
            const tempArray = this._scratchMemory.getUInt8Array(lenFlags);
            for (let i = 0; i < lenFlags; i += 4) {
                tempArray[i + 0] = f0; // x - normal fill
                tempArray[i + 1] = f1; // y - emphasis fill
                tempArray[i + 2] = f2; // z - edges
                tempArray[i + 3] = f3; // w - pick
            }
            this._state.flagsBuf.setData(tempArray, firstFlag, lenFlags);
        }
    }

    _setDeferredFlags() {
        if (this._deferredFlagValues) {
            this._state.flagsBuf.setData(this._deferredFlagValues);
            this._deferredFlagValues = null;
        }
    }

    _setFlags2(portionId, flags, deferred = false) {

        if (!this._finalized) {
            throw "Not finalized";
        }

        const portionsIdx = portionId;
        const portion = this._portions[portionsIdx];
        const vertexBase = portion.vertsBase;
        const numVerts = portion.numVerts;
        const firstFlag = vertexBase * 4;
        const lenFlags = numVerts * 4;
        const clippable = !!(flags & ENTITY_FLAGS.CLIPPABLE) ? 255 : 0;

        if (deferred) {
            if (!this._setDeferredFlag2Values) {
                this._setDeferredFlag2Values = new Uint8Array(this._numVerts * 4);
            }
            for (let i = firstFlag, len = (firstFlag + lenFlags); i < len; i += 4) {
                this._setDeferredFlag2Values[i] = clippable;
            }
        } else if (this._state.flags2Buf) {
            const tempArray = this._scratchMemory.getUInt8Array(lenFlags);
            for (let i = 0; i < lenFlags; i += 4) {
                tempArray[i + 0] = clippable;
            }
            this._state.flags2Buf.setData(tempArray, firstFlag, lenFlags);
        }
    }

    _setDeferredFlags2() {
        if (this._setDeferredFlag2Values) {
            this._state.flags2Buf.setData(this._setDeferredFlag2Values);
            this._setDeferredFlag2Values = null;
        }
    }

    setOffset(portionId, offset) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (!this.model.scene.entityOffsetsEnabled) {
            this.model.error("Entity#offset not enabled for this Viewer"); // See Viewer entityOffsetsEnabled
            return;
        }
        const portionsIdx = portionId;
        const portion = this._portions[portionsIdx];
        const vertexBase = portion.vertsBase;
        const numVerts = portion.numVerts;
        const firstOffset = vertexBase * 3;
        const lenOffsets = numVerts * 3;
        const tempArray = this._scratchMemory.getFloat32Array(lenOffsets);
        const x = offset[0];
        const y = offset[1];
        const z = offset[2];
        for (let i = 0; i < lenOffsets; i += 3) {
            tempArray[i + 0] = x;
            tempArray[i + 1] = y;
            tempArray[i + 2] = z;
        }
        if (this._state.offsetsBuf) {
            this._state.offsetsBuf.setData(tempArray, firstOffset, lenOffsets);
        }
        if (this.model.scene.pickSurfacePrecisionEnabled) {
            portion.offset[0] = offset[0];
            portion.offset[1] = offset[1];
            portion.offset[2] = offset[2];
        }
    }

    // ---------------------- COLOR RENDERING -----------------------------------

    drawColorOpaque(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numTransparentLayerPortions === this._numPortions || this._numXRayedLayerPortions === this._numPortions) {
            return;
        }
        this._updateBackfaceCull(renderFlags, frameCtx);
        if (frameCtx.withSAO && this.model.saoEnabled) {
            if (frameCtx.pbrEnabled && this.model.pbrEnabled && this._state.pbrSupported) {
                if (this._batchingRenderers.pbrRendererWithSAO) {
                    this._batchingRenderers.pbrRendererWithSAO.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE);
                }
            } else if (frameCtx.colorTextureEnabled && this.model.colorTextureEnabled && this._state.colorTextureSupported) {
                if (this._batchingRenderers.colorTextureRendererWithSAO) {
                    this._batchingRenderers.colorTextureRendererWithSAO.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE);
                }
            } else if (this._state.normalsBuf) {
                if (this._batchingRenderers.colorRendererWithSAO) {
                    this._batchingRenderers.colorRendererWithSAO.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE);
                }
            } else {
                if (this._batchingRenderers.flatColorRendererWithSAO) {
                    this._batchingRenderers.flatColorRendererWithSAO.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE);
                }
            }
        } else {
            if (frameCtx.pbrEnabled && this.model.pbrEnabled && this._state.pbrSupported) {
                if (this._batchingRenderers.pbrRenderer) {
                    this._batchingRenderers.pbrRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE);
                }
            } else if (frameCtx.colorTextureEnabled && this.model.colorTextureEnabled && this._state.colorTextureSupported) {
                if (this._batchingRenderers.colorTextureRenderer) {
                    this._batchingRenderers.colorTextureRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE);
                }
            } else if (this._state.normalsBuf) {
                if (this._batchingRenderers.colorRenderer) {
                    this._batchingRenderers.colorRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE);
                }
            } else {
                if (this._batchingRenderers.flatColorRenderer) {
                    this._batchingRenderers.flatColorRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE);
                }
            }
        }
    }

    _updateBackfaceCull(renderFlags, frameCtx) {
        const backfaces = this.model.backfaces || (!this.solid) || renderFlags.sectioned;
        if (frameCtx.backfaces !== backfaces) {
            const gl = frameCtx.gl;
            if (backfaces) {
                gl.disable(gl.CULL_FACE);
            } else {
                gl.enable(gl.CULL_FACE);
            }
            frameCtx.backfaces = backfaces;
        }
    }

    drawColorTransparent(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numTransparentLayerPortions === 0 || this._numXRayedLayerPortions === this._numPortions) {
            return;
        }
        this._updateBackfaceCull(renderFlags, frameCtx);
        if (frameCtx.pbrEnabled && this.model.pbrEnabled && this._state.pbrSupported) {
            if (this._batchingRenderers.pbrRenderer) {
                this._batchingRenderers.pbrRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_TRANSPARENT);
            }
        } else if (frameCtx.colorTextureEnabled && this.model.colorTextureEnabled && this._state.colorTextureSupported) {
            if (this._batchingRenderers.colorTextureRenderer) {
                this._batchingRenderers.colorTextureRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_TRANSPARENT);
            }
        } else if (this._state.normalsBuf) {
            if (this._batchingRenderers.colorRenderer) {
                this._batchingRenderers.colorRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_TRANSPARENT);
            }
        } else {
            if (this._batchingRenderers.flatColorRenderer) {
                this._batchingRenderers.flatColorRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_TRANSPARENT);
            }
        }
    }

    // ---------------------- RENDERING SAO POST EFFECT TARGETS --------------

    drawDepth(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numTransparentLayerPortions === this._numPortions || this._numXRayedLayerPortions === this._numPortions) {
            return;
        }
        this._updateBackfaceCull(renderFlags, frameCtx);
        if (this._batchingRenderers.depthRenderer) {
            this._batchingRenderers.depthRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE); // Assume whatever post-effect uses depth (eg SAO) does not apply to transparent objects
        }
    }

    drawNormals(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numTransparentLayerPortions === this._numPortions || this._numXRayedLayerPortions === this._numPortions) {
            return;
        }
        this._updateBackfaceCull(renderFlags, frameCtx);
        if (this._batchingRenderers.normalsRenderer) {
            this._batchingRenderers.normalsRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE);  // Assume whatever post-effect uses normals (eg SAO) does not apply to transparent objects
        }
    }

    // ---------------------- SILHOUETTE RENDERING -----------------------------------

    drawSilhouetteXRayed(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numXRayedLayerPortions === 0) {
            return;
        }
        this._updateBackfaceCull(renderFlags, frameCtx);
        if (this._batchingRenderers.silhouetteRenderer) {
            this._batchingRenderers.silhouetteRenderer.drawLayer(frameCtx, this, RENDER_PASSES.SILHOUETTE_XRAYED);
        }
    }

    drawSilhouetteHighlighted(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numHighlightedLayerPortions === 0) {
            return;
        }
        this._updateBackfaceCull(renderFlags, frameCtx);
        if (this._batchingRenderers.silhouetteRenderer) {
            this._batchingRenderers.silhouetteRenderer.drawLayer(frameCtx, this, RENDER_PASSES.SILHOUETTE_HIGHLIGHTED);
        }
    }

    drawSilhouetteSelected(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numSelectedLayerPortions === 0) {
            return;
        }
        this._updateBackfaceCull(renderFlags, frameCtx);
        if (this._batchingRenderers.silhouetteRenderer) {
            this._batchingRenderers.silhouetteRenderer.drawLayer(frameCtx, this, RENDER_PASSES.SILHOUETTE_SELECTED);
        }
    }

    // ---------------------- EDGES RENDERING -----------------------------------

    drawEdgesColorOpaque(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numEdgesLayerPortions === 0) {
            return;
        }
        if (this._batchingRenderers.edgesColorRenderer) {
            this._batchingRenderers.edgesColorRenderer.drawLayer(frameCtx, this, RENDER_PASSES.EDGES_COLOR_OPAQUE);
        }
    }

    drawEdgesColorTransparent(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numEdgesLayerPortions === 0 || this._numTransparentLayerPortions === 0) {
            return;
        }
        if (this._batchingRenderers.edgesColorRenderer) {
            this._batchingRenderers.edgesColorRenderer.drawLayer(frameCtx, this, RENDER_PASSES.EDGES_COLOR_TRANSPARENT);
        }
    }

    drawEdgesHighlighted(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numHighlightedLayerPortions === 0) {
            return;
        }
        if (this._batchingRenderers.edgesRenderer) {
            this._batchingRenderers.edgesRenderer.drawLayer(frameCtx, this, RENDER_PASSES.EDGES_HIGHLIGHTED);
        }
    }

    drawEdgesSelected(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numSelectedLayerPortions === 0) {
            return;
        }
        if (this._batchingRenderers.edgesRenderer) {
            this._batchingRenderers.edgesRenderer.drawLayer(frameCtx, this, RENDER_PASSES.EDGES_SELECTED);
        }
    }

    drawEdgesXRayed(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numXRayedLayerPortions === 0) {
            return;
        }
        if (this._batchingRenderers.edgesRenderer) {
            this._batchingRenderers.edgesRenderer.drawLayer(frameCtx, this, RENDER_PASSES.EDGES_XRAYED);
        }
    }

    // ---------------------- OCCLUSION CULL RENDERING -----------------------------------

    drawOcclusion(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0) {
            return;
        }
        this._updateBackfaceCull(renderFlags, frameCtx);
        if (this._batchingRenderers.occlusionRenderer) {
            this._batchingRenderers.occlusionRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE);
        }
    }

    // ---------------------- SHADOW BUFFER RENDERING -----------------------------------

    drawShadow(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0) {
            return;
        }
        this._updateBackfaceCull(renderFlags, frameCtx);
        if (this._batchingRenderers.shadowRenderer) {
            this._batchingRenderers.shadowRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE);
        }
    }

    //---- PICKING ----------------------------------------------------------------------------------------------------

    drawPickMesh(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0) {
            return;
        }
        this._updateBackfaceCull(renderFlags, frameCtx);
        if (this._batchingRenderers.pickMeshRenderer) {
            this._batchingRenderers.pickMeshRenderer.drawLayer(frameCtx, this, RENDER_PASSES.PICK);
        }
    }

    drawPickDepths(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0) {
            return;
        }
        this._updateBackfaceCull(renderFlags, frameCtx);
        if (this._batchingRenderers.pickDepthRenderer) {
            this._batchingRenderers.pickDepthRenderer.drawLayer(frameCtx, this, RENDER_PASSES.PICK);
        }
    }

    drawPickNormals(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0) {
            return;
        }
        this._updateBackfaceCull(renderFlags, frameCtx);

        ////////////////////////////////////////////////////////////////////////////////////////////////////
        // TODO
        // if (this._state.normalsBuf) {
        //     if (this._batchingRenderers.pickNormalsRenderer) {
        //         this._batchingRenderers.pickNormalsRenderer.drawLayer(frameCtx, this, RENDER_PASSES.PICK);
        //     }
        ////////////////////////////////////////////////////////////////////////////////////////////////////
        // } else {
            if (this._batchingRenderers.pickNormalsFlatRenderer) {
                this._batchingRenderers.pickNormalsFlatRenderer.drawLayer(frameCtx, this, RENDER_PASSES.PICK);
            }
       // }
    }

    //------------------------------------------------------------------------------------------------

    precisionRayPickSurface(portionId, worldRayOrigin, worldRayDir, worldSurfacePos, worldNormal) {

        if (!this.model.scene.pickSurfacePrecisionEnabled) {
            return false;
        }

        const state = this._state;
        const portion = this._portions[portionId];

        if (!portion) {
            this.model.error("portion not found: " + portionId);
            return false;
        }

        const positions = portion.quantizedPositions;
        const indices = portion.indices;
        const origin = state.origin;
        const offset = portion.offset;

        const rtcRayOrigin = tempVec3a;
        const rtcRayDir = tempVec3b;

        rtcRayOrigin.set(origin ? math.subVec3(worldRayOrigin, origin, tempVec3c) : worldRayOrigin);  // World -> RTC
        rtcRayDir.set(worldRayDir);

        if (offset) {
            math.subVec3(rtcRayOrigin, offset);
        }

        math.transformRay(this.model.worldNormalMatrix, rtcRayOrigin, rtcRayDir, rtcRayOrigin, rtcRayDir); // RTC -> local

        const a = tempVec3d;
        const b = tempVec3e;
        const c = tempVec3f;

        let gotIntersect = false;
        let closestDist = 0;
        const closestIntersectPos = tempVec3g;

        for (let i = 0, len = indices.length; i < len; i += 3) {

            const ia = indices[i] * 3;
            const ib = indices[i + 1] * 3;
            const ic = indices[i + 2] * 3;

            a[0] = positions[ia];
            a[1] = positions[ia + 1];
            a[2] = positions[ia + 2];

            b[0] = positions[ib];
            b[1] = positions[ib + 1];
            b[2] = positions[ib + 2];

            c[0] = positions[ic];
            c[1] = positions[ic + 1];
            c[2] = positions[ic + 2];

            math.decompressPosition(a, state.positionsDecodeMatrix);
            math.decompressPosition(b, state.positionsDecodeMatrix);
            math.decompressPosition(c, state.positionsDecodeMatrix);

            if (math.rayTriangleIntersect(rtcRayOrigin, rtcRayDir, a, b, c, closestIntersectPos)) {

                math.transformPoint3(this.model.worldMatrix, closestIntersectPos, closestIntersectPos);

                if (offset) {
                    math.addVec3(closestIntersectPos, offset);
                }

                if (origin) {
                    math.addVec3(closestIntersectPos, origin);
                }

                const dist = Math.abs(math.lenVec3(math.subVec3(closestIntersectPos, worldRayOrigin, [])));

                if (!gotIntersect || dist > closestDist) {
                    closestDist = dist;
                    worldSurfacePos.set(closestIntersectPos);
                    if (worldNormal) { // Not that wasteful to eagerly compute - unlikely to hit >2 surfaces on most geometry
                        math.triangleNormal(a, b, c, worldNormal);
                    }
                    gotIntersect = true;
                }
            }
        }

        if (gotIntersect && worldNormal) {
            math.transformVec3(this.model.worldNormalMatrix, worldNormal, worldNormal);
            math.normalizeVec3(worldNormal);
        }

        return gotIntersect;
    }

    // ---------

    destroy() {
        const state = this._state;
        if (state.positionsBuf) {
            state.positionsBuf.destroy();
            state.positionsBuf = null;
        }
        if (state.offsetsBuf) {
            state.offsetsBuf.destroy();
            state.offsetsBuf = null;
        }
        if (state.normalsBuf) {
            state.normalsBuf.destroy();
            state.normalsBuf = null;
        }
        if (state.colorsBuf) {
            state.colorsBuf.destroy();
            state.colorsBuf = null;
        }
        if (state.metallicRoughnessBuf) {
            state.metallicRoughnessBuf.destroy();
            state.metallicRoughnessBuf = null;
        }
        if (state.flagsBuf) {
            state.flagsBuf.destroy();
            state.flagsBuf = null;
        }
        if (state.flags2Buf) {
            state.flags2Buf.destroy();
            state.flags2Buf = null;
        }
        if (state.pickColorsBuf) {
            state.pickColorsBuf.destroy();
            state.pickColorsBuf = null;
        }
        if (state.indicesBuf) {
            state.indicesBuf.destroy();
            state.indicessBuf = null;
        }
        if (state.edgeIndicesBuf) {
            state.edgeIndicesBuf.destroy();
            state.edgeIndicessBuf = null;
        }
        state.destroy();
    }
}

export {TrianglesBatchingLayer};