import { BufferAttribute, BufferGeometry } from "three";
import * as wasm from "@voxeltoy/mesher";
import type { Vec3 } from "@voxeltoy/core/types";

export const MESH_NO_SHADE = wasm.MESH_NO_SHADE.value;
export const MESH_NO_AO = wasm.MESH_NO_AO.value;

const BYTES_PER_QUAD = wasm.BYTES_PER_QUAD.value;

/** A reusable block of wasm memory that grows on demand. */
class WasmBuffer {
  ptr = 0;
  size = 0;

  ensure(size: number) {
    if (size <= this.size) return this.ptr;
    if (this.ptr) wasm.free(this.ptr);
    this.size = Math.max(size, this.size * 2, 1024);
    this.ptr = wasm.alloc(this.size);
    return this.ptr;
  }
}

/** Builds three.js geometry from a voxel volume via the greedy wasm mesher. */
export class Mesher {
  private voxels = new WasmBuffer();
  private palette = new WasmBuffer();
  private out = new WasmBuffer();
  private capacity = 0;
  private indexPattern = new Uint32Array(0);

  build(volume: Uint8Array, size: Vec3, palette: readonly number[], flags = 0): BufferGeometry {
    // The wasm reads size[0] * size[1] * size[2] cells: a shorter volume would read past it.
    if (volume.length !== size[0] * size[1] * size[2]) throw new Error(`Mesher: a ${size.join("×")} volume needs ${size[0] * size[1] * size[2]} cells, got ${volume.length}`);
    const voxelPtr = this.voxels.ensure(volume.length);
    const palettePtr = this.palette.ensure(1024);
    new Uint8Array(wasm.memory.buffer, voxelPtr, volume.length).set(volume);
    const pal = new Uint8Array(wasm.memory.buffer, palettePtr, 1024);
    for (let i = 0; i < 256; i++) {
      const c = palette[i] ?? 0;
      pal[i * 4] = (c >> 16) & 255;
      pal[i * 4 + 1] = (c >> 8) & 255;
      pal[i * 4 + 2] = c & 255;
    }

    let count = this.run(voxelPtr, size, palettePtr, flags);
    if (count > this.capacity) {
      this.capacity = Math.ceil(count * 1.25);
      count = this.run(voxelPtr, size, palettePtr, flags);
    }

    // views must be taken after the call: memory may have grown
    const outPtr = this.out.ptr;
    const positions = new Float32Array(wasm.memory.buffer, outPtr, count * 12).slice();
    const colors = new Uint8Array(wasm.memory.buffer, outPtr + this.capacity * 48, count * 12).slice();

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("color", new BufferAttribute(colors, 3, true));
    geometry.setIndex(new BufferAttribute(this.indices(count), 1));
    geometry.computeBoundingSphere();
    return geometry;
  }

  private run(voxelPtr: number, size: Vec3, palettePtr: number, flags: number) {
    const outPtr = this.out.ensure(Math.max(1, this.capacity) * BYTES_PER_QUAD);
    // Re-derive the capacity from the allocation so the color region offset matches.
    this.capacity = Math.floor(this.out.size / BYTES_PER_QUAD);
    return wasm.mesh(voxelPtr, size[0], size[1], size[2], palettePtr, outPtr, this.capacity, flags);
  }

  /** Two triangles (0, 1, 2) (0, 2, 3) per quad. */
  private indices(quads: number) {
    if (this.indexPattern.length < quads * 6) {
      const n = Math.max(quads, 1024) * 2;
      const pattern = new Uint32Array(n * 6);
      for (let q = 0; q < n; q++) {
        const v = q * 4;
        pattern.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
      }
      this.indexPattern = pattern;
    }
    return this.indexPattern.slice(0, quads * 6);
  }
}
