import {ENTITY_FLAGS} from '../../ENTITY_FLAGS.js';
import {RENDER_PASSES} from '../../RENDER_PASSES.js';

import {math} from "../../../../../math/math.js";
import {RenderState} from "../../../../../webgl/RenderState.js";
import {ArrayBuf} from "../../../../../webgl/ArrayBuf.js";
import {geometryCompressionUtils} from "../../../../../math/geometryCompressionUtils.js";
import {getBatchingRenderers} from "./LinesBatchingRenderers.js";
import {LinesBatchingBuffer} from "./LinesBatchingBuffer.js";
import {quantizePositions} from "../../compression.js";

const tempVec4a = math.vec4([0, 0, 0, 1]);
const tempVec4b = math.vec4([0, 0, 0, 1]);
const tempVec4c = math.vec4([0, 0, 0, 1]);
const tempOBB3 = math.OBB3();

/**
 * @private
 */
class LinesBatchingLayer {

    /**
     * @param model
     * @param cfg
     * @param cfg.layerIndex
     * @param cfg.positionsDecodeMatrix
     * @param cfg.maxGeometryBatchSize
     * @param cfg.origin
     * @param cfg.scratchMemory
     */
    constructor(cfg) {

        /**
         * Index of this LinesBatchingLayer in {@link VBOSceneModel#_layerList}.
         * @type {Number}
         */
        this.layerIndex = cfg.layerIndex;

        this._batchingRenderers = getBatchingRenderers(cfg.model.scene);
        this.model = cfg.model;
        this._buffer = new LinesBatchingBuffer(cfg.maxGeometryBatchSize);
        this._scratchMemory = cfg.scratchMemory;

        this._state = new RenderState({
            positionsBuf: null,
            offsetsBuf: null,
            colorsBuf: null,
            flagsBuf: null,
            flags2Buf: null,
            indicesBuf: null,
            positionsDecodeMatrix: math.mat4(),
            origin: null
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

        if (cfg.origin) {
            this._state.origin = math.vec3(cfg.origin);
        }

        /**
         * The axis-aligned World-space boundary of this LinesBatchingLayer's positions.
         * @type {*|Float64Array}
         */
        this.aabb = math.collapseAABB3();
    }

    /**
     * Tests if there is room for another portion in this LinesBatchingLayer.
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
     * Creates a new portion within this LinesBatchingLayer, returns the new portion ID.
     *
     * Gives the portion the specified geometry, color and matrix.
     *
     * @param cfg.positions Flat float Local-space positions array.
     * @param cfg.positionsCompressed Flat quantized positions array - decompressed with TrianglesBatchingLayer positionsDecodeMatrix
     * @param cfg.indices  Flat int indices array.
     * @param cfg.color Quantized RGB color [0..255,0..255,0..255,0..255]
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
        const indices = cfg.indices;
        const color = cfg.color;
        const opacity = cfg.opacity;
        const meshMatrix = cfg.meshMatrix;
        const worldMatrix = cfg.worldMatrix;
        const worldAABB = cfg.worldAABB;
        const pickColor = cfg.pickColor;

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

        if (color) {

            const r = color[0]; // Color is pre-quantized by VBOSceneModel
            const g = color[1];
            const b = color[2];
            const a = opacity;

            for (let i = 0; i < numVerts; i++) {
                buffer.colors.push(r);
                buffer.colors.push(g);
                buffer.colors.push(b);
                buffer.colors.push(a);
            }
        }

        if (indices) {
            for (let i = 0, len = indices.length; i < len; i++) {
                buffer.indices.push(indices[i] + vertsIndex);
            }
        }

        if (this.model.scene.entityOffsetsEnabled) {
            for (let i = 0; i < numVerts; i++) {
                buffer.offsets.push(0);
                buffer.offsets.push(0);
                buffer.offsets.push(0);
            }
        }

        const portionId = this._portions.length / 2;

        this._portions.push(vertsIndex);
        this._portions.push(numVerts);

        this._numPortions++;
        this.model.numPortions++;

        this._numVerts += numVerts;

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
            if (this._preCompressedPositionsExpected) {
                const positions = new Uint16Array(buffer.positions);
                state.positionsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, positions, buffer.positions.length, 3, gl.STATIC_DRAW);
            } else {
                const positions = new Float32Array(buffer.positions);
                const quantizedPositions = quantizePositions(positions, this._modelAABB, state.positionsDecodeMatrix);
                state.positionsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, quantizedPositions, buffer.positions.length, 3, gl.STATIC_DRAW);
            }
        }

        if (buffer.colors.length > 0) {
            const colors = new Uint8Array(buffer.colors);
            let normalized = false;
            state.colorsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, colors, buffer.colors.length, 4, gl.DYNAMIC_DRAW, normalized);
        }

        if (buffer.colors.length > 0) { // Because we build flags arrays here, get their length from the colors array
            const flagsLength = buffer.colors.length;
            const flags = new Uint8Array(flagsLength);
            const flags2 = new Uint8Array(flagsLength);
            let notNormalized = false;
            let normalized = true;
            state.flagsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, flags, flags.length, 4, gl.DYNAMIC_DRAW, notNormalized);
            state.flags2Buf = new ArrayBuf(gl, gl.ARRAY_BUFFER, flags2, flags2.length, 4, gl.DYNAMIC_DRAW, normalized);
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

        this._buffer = null;
        this._finalized = true;
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
        const portionsIdx = portionId * 2;
        const vertexBase = this._portions[portionsIdx];
        const numVerts = this._portions[portionsIdx + 1];
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
        this._state.colorsBuf.setData(tempArray, firstColor, lenColor);
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

        const portionsIdx = portionId * 2;
        const vertexBase = this._portions[portionsIdx];
        const numVerts = this._portions[portionsIdx + 1];
        const firstFlag = vertexBase * 4;
        const lenFlags = numVerts * 4;
        const tempArray = this._scratchMemory.getUInt8Array(lenFlags);

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

        // Pick

        let f3 = (visible && !culled && pickable) ? RENDER_PASSES.PICK : RENDER_PASSES.NOT_RENDERED;
        if (deferred) {
            if (!this._deferredFlagValues) {
                this._deferredFlagValues = new Uint8Array(this._numVerts * 4);
            }
            for (let i = firstFlag, len = (firstFlag + lenFlags); i < len; i += 4) {
                this._deferredFlagValues[i + 0] = f0;
                this._deferredFlagValues[i + 1] = f1;
                this._deferredFlagValues[i + 2] = 0;
                this._deferredFlagValues[i + 3] = f3;
            }
        } else if (this._state.flagsBuf) {
            const tempArray = this._scratchMemory.getUInt8Array(lenFlags);
            for (let i = 0; i < lenFlags; i += 4) {
                tempArray[i + 0] = f0; // x - color
                tempArray[i + 1] = f1; // y - silhouette - select/highlight/xray
                tempArray[i + 2] = 0; // z - edges
                tempArray[i + 3] = f3; // w - pickable
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
        const portionsIdx = portionId * 2;
        const vertexBase = this._portions[portionsIdx];
        const numVerts = this._portions[portionsIdx + 1];
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
        } else {
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
        const portionsIdx = portionId * 2;
        const vertexBase = this._portions[portionsIdx];
        const numVerts = this._portions[portionsIdx + 1];
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
        this._state.offsetsBuf.setData(tempArray, firstOffset, lenOffsets);
    }

    //-- RENDERING ----------------------------------------------------------------------------------------------

    drawColorOpaque(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numTransparentLayerPortions === this._numPortions || this._numXRayedLayerPortions === this._numPortions) {
            return;
        }
        if (this._batchingRenderers.colorRenderer) {
            this._batchingRenderers.colorRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_OPAQUE);
        }
    }

    drawColorTransparent(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numTransparentLayerPortions === 0 || this._numXRayedLayerPortions === this._numPortions) {
            return;
        }
        if (this._batchingRenderers.colorRenderer) {
            this._batchingRenderers.colorRenderer.drawLayer(frameCtx, this, RENDER_PASSES.COLOR_TRANSPARENT);
        }
    }

    drawDepth(renderFlags, frameCtx) {
    }

    drawNormals(renderFlags, frameCtx) {
    }

    drawSilhouetteXRayed(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numXRayedLayerPortions === 0) {
            return;
        }
        if (this._batchingRenderers.silhouetteRenderer) {
            this._batchingRenderers.silhouetteRenderer.drawLayer(frameCtx, this, RENDER_PASSES.SILHOUETTE_XRAYED);
        }
    }

    drawSilhouetteHighlighted(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numHighlightedLayerPortions === 0) {
            return;
        }
        if (this._batchingRenderers.silhouetteRenderer) {
            this._batchingRenderers.silhouetteRenderer.drawLayer(frameCtx, this, RENDER_PASSES.SILHOUETTE_HIGHLIGHTED);
        }
    }

    drawSilhouetteSelected(renderFlags, frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numSelectedLayerPortions === 0) {
            return;
        }
        if (this._batchingRenderers.silhouetteRenderer) {
            this._batchingRenderers.silhouetteRenderer.drawLayer(frameCtx, this, RENDER_PASSES.SILHOUETTE_SELECTED);
        }
    }

    drawEdgesColorOpaque(renderFlags, frameCtx) {
    }

    drawEdgesColorTransparent(renderFlags, frameCtx) {
    }

    drawEdgesHighlighted(renderFlags, frameCtx) {
    }

    drawEdgesSelected(renderFlags, frameCtx) {
    }

    drawEdgesXRayed(renderFlags, frameCtx) {
    }

    drawPickMesh(frameCtx) {
    }

    drawPickDepths(frameCtx) {
    }

    drawPickNormals(frameCtx) {
    }

    drawOcclusion(frameCtx) {
    }

    drawShadow(frameCtx) {
    }

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
        if (state.colorsBuf) {
            state.colorsBuf.destroy();
            state.colorsBuf = null;
        }
        if (state.flagsBuf) {
            state.flagsBuf.destroy();
            state.flagsBuf = null;
        }
        if (state.flags2Buf) {
            state.flags2Buf.destroy();
            state.flags2Buf = null;
        }
        if (state.indicesBuf) {
            state.indicesBuf.destroy();
            state.indicessBuf = null;
        }
        state.destroy();
    }
}

export {LinesBatchingLayer};