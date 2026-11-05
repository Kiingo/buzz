// Generated from the Kiingo surface renderer packages at f7dffff48426f852528f24ecb4cb04fb5bc2d5b2; do not edit here.
import { asNumber, isObject } from "./json";
import { isDocumentFileId } from "./document";
import { plainText } from "./text";

// Model3D (GENUI-SPATIAL, 2026-11-05): the shared reading of its props, and
// the GLB reader the web draws from (79 ruling S3 on proposal-v1). The Swift
// kit's `UiModel3D` and `UiGLB` match.
//
// A GLB is read only from the bytes Kiingo served behind the scan gate. Every
// accessor, bufferView and count is checked against the real chunk lengths,
// in safe-integer arithmetic, before anything is allocated, so an allocation
// never exceeds what the bytes hold. A buffer or image with any `uri`
// (another file, a web address or a data: URI) refuses the whole file and
// nothing is fetched. Textures are only embedded PNG or JPEG, checked by
// their first bytes; the renderer decodes them with createImageBitmap on a
// Blob, never a blob: URL. Anything this reader can't read whole is a
// refusal with a sentence, never a partial model.

export const MODEL3D_GLB_TYPE = "model/gltf-binary";
export const MODEL3D_USDZ_TYPE = "model/vnd.usdz+zip";

export type Model3DFile = {
  /** A Kiingo file id (a UUID); anything else shows the name only. */
  fileId?: string;
  name?: string;
  contentType?: string;
  agentId?: string;
};

export type Model3DModel = {
  model: Model3DFile;
  poster?: Model3DFile;
  alt: string;
  title?: string;
  ar: boolean;
  height: "sm" | "md" | "lg";
};

const fileOf = (value: unknown): Model3DFile | undefined => {
  if (!isObject(value)) {
    return undefined;
  }
  const raw = plainText(value.artifactId, 200);
  const name = plainText(value.name, 300);
  if (!raw && !name) {
    return undefined;
  }
  const contentType = plainText(value.contentType, 200)?.toLowerCase();
  const agentId = plainText(value.agentId, 200)?.toLowerCase();
  return {
    ...(raw && isDocumentFileId(raw) ? { fileId: raw.toLowerCase() } : {}),
    ...(name ? { name } : {}),
    ...(contentType ? { contentType } : {}),
    ...(agentId ? { agentId } : {}),
  };
};

/** The props as one model; undefined without a model file ref. */
export const model3dModelOf = (props: {
  model: unknown;
  poster: unknown;
  alt: unknown;
  title: unknown;
  ar: unknown;
  height: unknown;
}): Model3DModel | undefined => {
  const model = fileOf(props.model);
  if (!model) {
    return undefined;
  }
  const poster = fileOf(props.poster);
  const title = plainText(props.title, 200);
  const height =
    props.height === "sm" || props.height === "lg" ? props.height : "md";
  return {
    model,
    ...(poster ? { poster } : {}),
    alt: plainText(props.alt, 500) ?? "A 3D model.",
    ...(title ? { title } : {}),
    ar: props.ar !== false,
    height,
  };
};

/** "glTF" little-endian. */
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Whether the bytes start like a GLB ("glTF", version 2). */
export const isGlbBytes = (bytes: Uint8Array): boolean =>
  bytes.length >= 12 &&
  new DataView(bytes.buffer, bytes.byteOffset, 12).getUint32(0, true) ===
    GLB_MAGIC &&
  new DataView(bytes.buffer, bytes.byteOffset, 12).getUint32(4, true) === 2;

/**
 * Whether the bytes start like a USDZ: a zip whose first entry is stored
 * (method 0, as USDZ requires) and is a .usdc, .usda or .usd layer. The
 * Swift `SafeFilePreview` sniff is the same rule.
 */
export const isUsdzBytes = (bytes: Uint8Array): boolean => {
  if (bytes.length < 30) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (view.getUint32(0, true) !== 0x04034b50 || view.getUint16(8, true) !== 0) {
    return false;
  }
  const nameLength = view.getUint16(26, true);
  if (nameLength === 0 || 30 + nameLength > bytes.length) {
    return false;
  }
  let name = "";
  for (let at = 30; at < 30 + nameLength; at += 1) {
    name += String.fromCharCode(bytes[at]!);
  }
  return /\.usd[ac]?$/iu.test(name);
};

export type GlbTexture = {
  bytes: Uint8Array;
  type: "image/png" | "image/jpeg";
};

export type GlbPrimitive = {
  /**
   * The shape this draws. Every node that uses the same mesh draws the same
   * part, with the same arrays (read once), so a renderer builds one set of
   * buffers per part and draws it once per node.
   */
  part: number;
  /** x, y, z per vertex, in the mesh's own space. */
  positions: Float32Array;
  /** Per vertex; computed from the triangles when the file has none. */
  normals: Float32Array;
  /** u, v per vertex, when the material has a texture. */
  uvs?: Float32Array;
  /** Triangles, three vertex indices each (every index checked). */
  indices: Uint32Array;
  /** Column-major 4×4, the node's world matrix. */
  matrix: Float32Array;
  color: [number, number, number, number];
  /** An index into `textures`. */
  texture?: number;
  doubleSided: boolean;
};

export type GlbModel = {
  primitives: GlbPrimitive[];
  textures: GlbTexture[];
  /** World-space bounds over every primitive. */
  min: [number, number, number];
  max: [number, number, number];
  triangles: number;
};

export type GlbRead =
  | { ok: true; model: GlbModel }
  | { ok: false; message: string };

const NOT_GLB = "This file isn’t a GLB model.";
const BROKEN = "This model file is damaged, so it can’t be shown.";
const OUTSIDE =
  "This model asks for other files or web addresses, so it can’t be shown here.";

class GlbRefusal extends Error {}

const refuse = (message: string): never => {
  throw new GlbRefusal(message);
};

const COMPONENT_BYTES: Readonly<Record<number, number>> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const TYPE_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

/** A non-negative safe integer, or the default when absent. */
const count = (value: unknown, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : refuse(BROKEN);
};

const arrayOf = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : refuse(BROKEN);

const entry = (list: unknown[], index: unknown): Record<string, unknown> => {
  const at = count(index);
  const item = list[at];
  return isObject(item) ? item : refuse(BROKEN);
};

type Slice = { view: DataView; offset: number; stride: number };

type Reader = {
  json: Record<string, unknown>;
  bin: DataView | null;
  accessors: unknown[];
  bufferViews: unknown[];
  /**
   * Each accessor is read once: its type with its values, and an index list
   * with its largest index, checked again for every mesh using it.
   */
  floats: Map<number, { type: string; values: Float32Array }>;
  indices: Map<number, { values: Uint32Array; top: number }>;
  /**
   * The bytes read out of accessors so far. Accessors may overlap the same
   * bytes, so their total is held to the BIN chunk's length: a file never
   * decodes more than it stores (79 SHOULD-3 on fe2d574b3a).
   */
  decoded: number;
};

/** Counts `bytes` more against the BIN chunk's length, before they're allocated. */
const spend = (reader: Reader, bytes: number) => {
  const next = reader.decoded + bytes;
  if (!reader.bin || next > reader.bin.byteLength) {
    refuse(BROKEN);
  }
  reader.decoded = next;
};

/** The bytes a bufferView names, checked against the BIN chunk. */
const bufferViewOf = (reader: Reader, index: unknown) => {
  const view = entry(reader.bufferViews, index);
  if (count(view.buffer) !== 0 || !reader.bin) {
    return refuse(BROKEN);
  }
  const offset = count(view.byteOffset, 0);
  const length = count(view.byteLength);
  if (offset + length > reader.bin.byteLength) {
    return refuse(BROKEN);
  }
  const stride = view.byteStride === undefined ? 0 : count(view.byteStride);
  if (stride !== 0 && (stride < 4 || stride > 252 || stride % 4 !== 0)) {
    return refuse(BROKEN);
  }
  return {
    bytes: new DataView(
      reader.bin.buffer,
      reader.bin.byteOffset + offset,
      length,
    ),
    stride,
  };
};

/** One accessor, bounds-checked: where its elements are and how to read them. */
const accessorSlice = (
  reader: Reader,
  index: number,
  types: readonly string[],
  componentTypes: readonly number[],
): {
  slice: Slice;
  count: number;
  components: number;
  componentType: number;
  normalized: boolean;
} => {
  const accessor = entry(reader.accessors, index);
  if (accessor.sparse !== undefined || accessor.bufferView === undefined) {
    // Sparse or all-zero accessors aren't read here.
    return refuse(BROKEN);
  }
  const type = typeof accessor.type === "string" ? accessor.type : "";
  const componentType = count(accessor.componentType);
  if (!types.includes(type) || !componentTypes.includes(componentType)) {
    return refuse(BROKEN);
  }
  const components = TYPE_COMPONENTS[type]!;
  const size = COMPONENT_BYTES[componentType]! * components;
  const elements = count(accessor.count);
  if (elements < 1) {
    return refuse(BROKEN);
  }
  const { bytes, stride } = bufferViewOf(reader, accessor.bufferView);
  const step = stride || size;
  const offset = count(accessor.byteOffset, 0);
  if (step < size || offset % COMPONENT_BYTES[componentType]! !== 0) {
    return refuse(BROKEN);
  }
  // The last element ends inside the view. Every term is a safe integer
  // below 2^32 times 252, so the sum is exact.
  const end = offset + step * (elements - 1) + size;
  if (!Number.isSafeInteger(end) || end > bytes.byteLength) {
    return refuse(BROKEN);
  }
  return {
    slice: { view: bytes, offset, stride: step },
    count: elements,
    components,
    componentType,
    normalized: accessor.normalized === true,
  };
};

const readComponent = (
  view: DataView,
  at: number,
  componentType: number,
  normalized: boolean,
): number => {
  switch (componentType) {
    case 5126:
      return view.getFloat32(at, true);
    case 5121: {
      const value = view.getUint8(at);
      return normalized ? value / 255 : value;
    }
    case 5123: {
      const value = view.getUint16(at, true);
      return normalized ? value / 65535 : value;
    }
    case 5125:
      return view.getUint32(at, true);
    case 5120: {
      const value = view.getInt8(at);
      return normalized ? Math.max(value / 127, -1) : value;
    }
    default: {
      const value = view.getInt16(at, true);
      return normalized ? Math.max(value / 32767, -1) : value;
    }
  }
};

const readFloats = (
  reader: Reader,
  index: number,
  type: "VEC2" | "VEC3",
  componentTypes: readonly number[],
): Float32Array => {
  const cached = reader.floats.get(index);
  if (cached) {
    // One accessor has one type; a second use as another is damage.
    return cached.type === type ? cached.values : refuse(BROKEN);
  }
  const read = accessorSlice(reader, index, [type], componentTypes);
  if (read.componentType !== 5126 && !read.normalized) {
    return refuse(BROKEN);
  }
  const size = COMPONENT_BYTES[read.componentType]!;
  spend(reader, read.count * read.components * size);
  const out = new Float32Array(read.count * read.components);
  for (let element = 0; element < read.count; element += 1) {
    const base = read.slice.offset + element * read.slice.stride;
    for (let component = 0; component < read.components; component += 1) {
      const value = readComponent(
        read.slice.view,
        base + component * size,
        read.componentType,
        read.normalized,
      );
      if (!Number.isFinite(value)) {
        return refuse(BROKEN);
      }
      out[element * read.components + component] = value;
    }
  }
  reader.floats.set(index, { type, values: out });
  return out;
};

const readIndices = (
  reader: Reader,
  index: number,
  vertices: number,
): Uint32Array => {
  const cached = reader.indices.get(index);
  if (cached) {
    return cached.top < vertices ? cached.values : refuse(BROKEN);
  }
  const read = accessorSlice(reader, index, ["SCALAR"], [5121, 5123, 5125]);
  if (read.count % 3 !== 0) {
    return refuse(BROKEN);
  }
  spend(reader, read.count * COMPONENT_BYTES[read.componentType]!);
  let top = 0;
  const out = new Uint32Array(read.count);
  for (let element = 0; element < read.count; element += 1) {
    const value = readComponent(
      read.slice.view,
      read.slice.offset + element * read.slice.stride,
      read.componentType,
      false,
    );
    if (value >= vertices) {
      return refuse(BROKEN);
    }
    top = Math.max(top, value);
    out[element] = value;
  }
  reader.indices.set(index, { values: out, top });
  return out;
};

/** Smooth normals from the triangles, for a mesh that has none. */
const normalsOf = (positions: Float32Array, indices: Uint32Array) => {
  const normals = new Float32Array(positions.length);
  for (let at = 0; at < indices.length; at += 3) {
    const a = indices[at]! * 3;
    const b = indices[at + 1]! * 3;
    const c = indices[at + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const vertex of [a, b, c]) {
      normals[vertex] = normals[vertex]! + nx;
      normals[vertex + 1] = normals[vertex + 1]! + ny;
      normals[vertex + 2] = normals[vertex + 2]! + nz;
    }
  }
  for (let at = 0; at < normals.length; at += 3) {
    const length = Math.hypot(normals[at]!, normals[at + 1]!, normals[at + 2]!);
    if (length > 0) {
      normals[at] = normals[at]! / length;
      normals[at + 1] = normals[at + 1]! / length;
      normals[at + 2] = normals[at + 2]! / length;
    } else {
      normals[at + 1] = 1;
    }
  }
  return normals;
};

const multiply = (a: Float32Array, b: Float32Array): Float32Array => {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + row]! * b[column * 4 + k]!;
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
};

const numbers = (value: unknown, length: number): number[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    return refuse(BROKEN);
  }
  return value as number[];
};

const IDENTITY = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

/** A node's local matrix: its `matrix`, else translation × rotation × scale. */
const localMatrix = (node: Record<string, unknown>): Float32Array => {
  const matrix = numbers(node.matrix, 16);
  if (matrix) {
    return new Float32Array(matrix);
  }
  const [tx, ty, tz] = numbers(node.translation, 3) ?? [0, 0, 0];
  const [qx, qy, qz, qw] = numbers(node.rotation, 4) ?? [0, 0, 0, 1];
  const [sx, sy, sz] = numbers(node.scale, 3) ?? [1, 1, 1];
  return new Float32Array([
    (1 - 2 * (qy! * qy! + qz! * qz!)) * sx!,
    2 * (qx! * qy! + qz! * qw!) * sx!,
    2 * (qx! * qz! - qy! * qw!) * sx!,
    0,
    2 * (qx! * qy! - qz! * qw!) * sy!,
    (1 - 2 * (qx! * qx! + qz! * qz!)) * sy!,
    2 * (qy! * qz! + qx! * qw!) * sy!,
    0,
    2 * (qx! * qz! + qy! * qw!) * sz!,
    2 * (qy! * qz! - qx! * qw!) * sz!,
    (1 - 2 * (qx! * qx! + qy! * qy!)) * sz!,
    0,
    tx!,
    ty!,
    tz!,
    1,
  ]);
};

const sniffTexture = (bytes: Uint8Array): GlbTexture["type"] | undefined => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  return undefined;
};

/** What extensions a file may require and still be drawn right. */
const SUPPORTED_REQUIRED: ReadonlySet<string> = new Set([
  "KHR_materials_unlit",
]);

const readGlbJson = (bytes: Uint8Array): Reader => {
  if (!isGlbBytes(bytes)) {
    return refuse(NOT_GLB);
  }
  const all = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = all.getUint32(8, true);
  if (length > bytes.byteLength || length < 20) {
    return refuse(BROKEN);
  }
  const jsonLength = all.getUint32(12, true);
  if (all.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLength > length) {
    return refuse(BROKEN);
  }
  let json: unknown;
  try {
    json = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(20, 20 + jsonLength),
      ),
    );
  } catch {
    return refuse(BROKEN);
  }
  if (!isObject(json)) {
    return refuse(BROKEN);
  }
  let bin: DataView | null = null;
  // Chunks are 4-byte aligned; the BIN chunk, when present, comes next.
  const binAt = 20 + jsonLength + ((4 - (jsonLength % 4)) % 4);
  if (binAt + 8 <= length) {
    const binLength = all.getUint32(binAt, true);
    if (
      all.getUint32(binAt + 4, true) === CHUNK_BIN &&
      binAt + 8 + binLength <= length
    ) {
      bin = new DataView(bytes.buffer, bytes.byteOffset + binAt + 8, binLength);
    } else if (all.getUint32(binAt + 4, true) === CHUNK_BIN) {
      return refuse(BROKEN);
    }
  }
  const buffers = arrayOf(json.buffers);
  buffers.forEach((buffer, index) => {
    if (!isObject(buffer)) {
      refuse(BROKEN);
    }
    const item = buffer as Record<string, unknown>;
    if (item.uri !== undefined) {
      refuse(OUTSIDE);
    }
    if (index !== 0 || !bin || count(item.byteLength) > bin.byteLength) {
      refuse(BROKEN);
    }
  });
  for (const image of arrayOf(json.images)) {
    if (!isObject(image) || image.uri !== undefined) {
      refuse(isObject(image) ? OUTSIDE : BROKEN);
    }
  }
  for (const name of arrayOf(json.extensionsRequired)) {
    if (typeof name !== "string" || !SUPPORTED_REQUIRED.has(name)) {
      refuse(
        "This model uses a compression or extension Kiingo can’t draw yet. Download it to open it.",
      );
    }
  }
  return {
    json,
    bin,
    accessors: arrayOf(json.accessors),
    bufferViews: arrayOf(json.bufferViews),
    floats: new Map(),
    indices: new Map(),
    decoded: 0,
  };
};

/** Reads a GLB into what a renderer draws, or refuses it with a sentence. */
export const readGlb = (bytes: Uint8Array): GlbRead => {
  try {
    const reader = readGlbJson(bytes);
    const { json } = reader;
    const nodes = arrayOf(json.nodes);
    const meshes = arrayOf(json.meshes);
    const materials = arrayOf(json.materials);
    const textures = arrayOf(json.textures);
    const images = arrayOf(json.images);
    const textureIndex = new Map<number, number>();
    const outTextures: GlbTexture[] = [];
    const textureOf = (index: unknown): number | undefined => {
      const texture = entry(textures, index);
      if (texture.source === undefined) {
        return undefined;
      }
      const source = count(texture.source);
      const known = textureIndex.get(source);
      if (known !== undefined) {
        return known;
      }
      const image = entry(images, source);
      if (image.bufferView === undefined) {
        return refuse(BROKEN);
      }
      const { bytes: view } = bufferViewOf(reader, image.bufferView);
      const data = new Uint8Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
      );
      const type = sniffTexture(data);
      if (!type) {
        // Only PNG and JPEG are decoded (KTX2, WebP and others aren't).
        return undefined;
      }
      outTextures.push({ bytes: data, type });
      textureIndex.set(source, outTextures.length - 1);
      return outTextures.length - 1;
    };

    const primitives: GlbPrimitive[] = [];
    let triangles = 0;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

    /** One mesh primitive, read once however many nodes use the mesh. */
    type Part = Omit<GlbPrimitive, "matrix"> & {
      /** Bounds in the mesh's own space. */
      low: [number, number, number];
      high: [number, number, number];
    };
    const meshParts = new Map<number, Part[]>();
    let partCount = 0;

    const partsOf = (meshIndex: number): Part[] => {
      const known = meshParts.get(meshIndex);
      if (known) {
        return known;
      }
      const mesh = entry(meshes, meshIndex);
      const out: Part[] = [];
      for (const raw of arrayOf(mesh.primitives)) {
        if (!isObject(raw)) {
          refuse(BROKEN);
        }
        const primitive = raw as Record<string, unknown>;
        // Triangles only (mode 4, the default); points and lines are skipped.
        if (count(primitive.mode, 4) !== 4) {
          continue;
        }
        const attributes = isObject(primitive.attributes)
          ? primitive.attributes
          : refuse(BROKEN);
        if (attributes.POSITION === undefined) {
          continue;
        }
        const positions = readFloats(
          reader,
          count(attributes.POSITION),
          "VEC3",
          [5126],
        );
        const vertices = positions.length / 3;
        let indices: Uint32Array;
        if (primitive.indices !== undefined) {
          indices = readIndices(reader, count(primitive.indices), vertices);
        } else {
          if (vertices % 3 !== 0) {
            refuse(BROKEN);
          }
          indices = new Uint32Array(vertices);
          for (let at = 0; at < vertices; at += 1) {
            indices[at] = at;
          }
        }
        const normals =
          attributes.NORMAL !== undefined
            ? readFloats(reader, count(attributes.NORMAL), "VEC3", [5126])
            : normalsOf(positions, indices);
        if (normals.length !== positions.length) {
          refuse(BROKEN);
        }
        let color: [number, number, number, number] = [0.8, 0.8, 0.8, 1];
        let texture: number | undefined;
        let doubleSided = false;
        if (primitive.material !== undefined) {
          const material = entry(materials, primitive.material);
          doubleSided = material.doubleSided === true;
          const pbr = isObject(material.pbrMetallicRoughness)
            ? material.pbrMetallicRoughness
            : {};
          const factor = numbers(pbr.baseColorFactor, 4);
          if (factor) {
            color = factor.map((value) => Math.min(1, Math.max(0, value))) as [
              number,
              number,
              number,
              number,
            ];
          }
          if (isObject(pbr.baseColorTexture)) {
            const set = count(pbr.baseColorTexture.texCoord, 0);
            texture =
              set === 0 ? textureOf(pbr.baseColorTexture.index) : undefined;
          }
        }
        let uvs: Float32Array | undefined;
        if (texture !== undefined) {
          if (attributes.TEXCOORD_0 === undefined) {
            texture = undefined;
          } else {
            uvs = readFloats(
              reader,
              count(attributes.TEXCOORD_0),
              "VEC2",
              [5126, 5121, 5123],
            );
            if (uvs.length !== vertices * 2) {
              refuse(BROKEN);
            }
          }
        }
        const low: [number, number, number] = [Infinity, Infinity, Infinity];
        const high: [number, number, number] = [
          -Infinity,
          -Infinity,
          -Infinity,
        ];
        for (let at = 0; at < positions.length; at += 3) {
          for (let axis = 0; axis < 3; axis += 1) {
            low[axis] = Math.min(low[axis]!, positions[at + axis]!);
            high[axis] = Math.max(high[axis]!, positions[at + axis]!);
          }
        }
        out.push({
          part: partCount,
          positions,
          normals,
          ...(uvs ? { uvs } : {}),
          indices,
          color,
          ...(texture !== undefined ? { texture } : {}),
          doubleSided,
          low,
          high,
        });
        partCount += 1;
      }
      meshParts.set(meshIndex, out);
      return out;
    };

    const addMesh = (meshIndex: unknown, matrix: Float32Array) => {
      for (const { low, high, ...part } of partsOf(count(meshIndex))) {
        // World bounds from the part's own box: its eight corners.
        for (let corner = 0; corner < 8; corner += 1) {
          const x = corner & 1 ? high[0] : low[0];
          const y = corner & 2 ? high[1] : low[1];
          const z = corner & 4 ? high[2] : low[2];
          for (let axis = 0; axis < 3; axis += 1) {
            const value =
              matrix[axis]! * x +
              matrix[4 + axis]! * y +
              matrix[8 + axis]! * z +
              matrix[12 + axis]!;
            min[axis] = Math.min(min[axis]!, value);
            max[axis] = Math.max(max[axis]!, value);
          }
        }
        triangles += part.indices.length / 3;
        primitives.push({ ...part, matrix });
      }
    };

    // The node graph must be a tree (79 on SHOULD-3): no node has two
    // parents and none is its own ancestor, and each is visited once, so the
    // nodes drawn are at most the JSON's own node list. Walked with a stack,
    // never recursion, so a deep chain can't run out of stack.
    const parentOf = new Map<number, number>();
    nodes.forEach((raw, index) => {
      const node = isObject(raw) ? raw : refuse(BROKEN);
      for (const child of arrayOf(node.children)) {
        const at = count(child);
        if (at >= nodes.length || parentOf.has(at)) {
          refuse(BROKEN);
        }
        parentOf.set(at, index);
      }
    });
    const parentless = nodes
      .map((_, index) => index)
      .filter((index) => !parentOf.has(index));
    // Every node is reached from a node with no parent; one that isn't is in
    // (or under) a cycle.
    let reached = 0;
    const pending = [...parentless];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      reached += 1;
      for (const child of arrayOf(entry(nodes, at).children)) {
        pending.push(count(child));
      }
    }
    if (reached !== nodes.length) {
      refuse(BROKEN);
    }
    const scenes = arrayOf(json.scenes);
    let roots = parentless;
    if (scenes.length > 0) {
      const scene = entry(scenes, json.scene ?? 0);
      roots = arrayOf(scene.nodes).map((root) => count(root));
      // A scene lists roots only.
      if (roots.some((root) => root >= nodes.length || parentOf.has(root))) {
        refuse(BROKEN);
      }
    }
    const visited = new Set<number>();
    const stack: [number, Float32Array][] = roots
      .slice()
      .reverse()
      .map((root): [number, Float32Array] => [root, IDENTITY]);
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
      const [at, parent] = item;
      if (visited.has(at)) {
        refuse(BROKEN);
      }
      visited.add(at);
      const node = entry(nodes, at);
      const world = multiply(parent, localMatrix(node));
      if (node.mesh !== undefined) {
        addMesh(node.mesh, world);
      }
      const children = arrayOf(node.children);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push([count(children[index]), world]);
      }
    }
    if (primitives.length === 0 || !Number.isFinite(min[0])) {
      return { ok: false, message: "This model has nothing to draw." };
    }
    return {
      ok: true,
      model: { primitives, textures: outTextures, min, max, triangles },
    };
  } catch (error) {
    if (error instanceof GlbRefusal) {
      return { ok: false, message: error.message };
    }
    // A DataView read past its end or anything unexpected: still a refusal.
    return { ok: false, message: BROKEN };
  }
};

/** "1,204 triangles" for the model's description line. */
export const model3dSizeLine = (model: GlbModel): string =>
  `${model.triangles.toLocaleString("en-US")} ${model.triangles === 1 ? "triangle" : "triangles"}`;

export const model3dIsGlb = (contentType: string | undefined): boolean =>
  (contentType ?? "").split(";")[0]!.trim() === MODEL3D_GLB_TYPE;

export const model3dIsUsdz = (contentType: string | undefined): boolean =>
  (contentType ?? "").split(";")[0]!.trim() === MODEL3D_USDZ_TYPE;

/** Rotate and zoom steps from the keyboard and VoiceOver. */
export const MODEL3D_TURN_STEP = Math.PI / 12;
export const MODEL3D_ZOOM_STEP = 1.25;

export const model3dClampZoom = (zoom: number): number =>
  Math.min(8, Math.max(0.25, asNumber(zoom) ?? 1));
