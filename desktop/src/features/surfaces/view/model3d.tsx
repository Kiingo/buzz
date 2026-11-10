// Generated from the Kiingo surface renderer packages at 1055d96f74fb6ac27bf0ebcd3c7fa12aee50be9c; do not edit here.
import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  isGlbBytes,
  isUsdzBytes,
  MODEL3D_TURN_STEP,
  MODEL3D_ZOOM_STEP,
  model3dClampZoom,
  model3dIsUsdz,
  model3dModelOf,
  model3dSizeLine,
  readGlb,
  type CompareSide,
  type GlbModel,
  type Model3DFile,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { usePicture } from "./markup";
import { QuotedText, SurfaceButton } from "./ui";

// Model3D (GENUI-SPATIAL, 2026-11-05; 79 ruling S3 on proposal-v1). A GLB
// from a Kiingo file the viewer may read, through the host's
// `readFileModel` (the viewer's own session, behind the scan gate), read by
// surface-core's checked `readGlb` and drawn here with WebGL 2: no 3D
// library, nothing fetched but the file itself. Textures are decoded with
// createImageBitmap on a Blob (no blob: URL). A USDZ is never parsed on the
// web: the poster, the alt and the app's viewer. Any failure shows the
// poster, the sentence and Open (the app's viewer, which has Download).
// Drawing happens only when something changes, never on a loop.

/** While a file is being scanned, ask again this often (contract §4: "every few seconds"). */
const CHECK_AGAIN_MS = 5_000;

const HEIGHTS: Record<string, string> = {
  sm: "h-56",
  md: "h-80",
  lg: "h-[32rem]",
};

type Loaded =
  | { kind: "loading" }
  | { kind: "checking" }
  | { kind: "ready"; model: GlbModel }
  | { kind: "usdz" }
  | { kind: "failed"; message: string };

const posterSide = (file: Model3DFile | undefined, alt: string): CompareSide =>
  file
    ? {
        ...(file.fileId ? { fileId: file.fileId } : {}),
        ...(file.name ? { name: file.name } : {}),
        ...(file.contentType ? { contentType: file.contentType } : {}),
        ...(file.agentId ? { agentId: file.agentId } : {}),
        page: 1,
        label: "",
        alt,
      }
    : { page: 1, label: "", alt };

const useModelFile = (file: Model3DFile): Loaded => {
  const context = useNodeContext();
  const readFileModel = context.host.readFileModel;
  const surfaceId = context.surface.id;
  const agentId = file.agentId ?? context.surface.agentId;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!file.fileId || !readFileModel) {
      setLoaded({
        kind: "failed",
        message: model3dIsUsdz(file.contentType)
          ? "Turn it and place it in the Kiingo app on iPhone or Mac."
          : "Turn it in the Kiingo app.",
      });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    if (attempt === 0) {
      setLoaded({ kind: "loading" });
    }
    readFileModel(
      { fileId: file.fileId, ...(agentId ? { agentId } : {}), surfaceId },
      abort.signal,
    )
      .then((answer) => {
        if (cancelled) {
          return;
        }
        if (answer.kind === "model") {
          const bytes = new Uint8Array(answer.bytes);
          if (answer.format === "usdz") {
            setLoaded(
              isUsdzBytes(bytes)
                ? { kind: "usdz" }
                : { kind: "failed", message: "This file isn’t a USDZ model." },
            );
            return;
          }
          if (!isGlbBytes(bytes)) {
            setLoaded({
              kind: "failed",
              message: "This file isn’t a GLB model.",
            });
            return;
          }
          const read = readGlb(bytes);
          setLoaded(
            read.ok
              ? { kind: "ready", model: read.model }
              : { kind: "failed", message: read.message },
          );
        } else if (answer.kind === "checking") {
          setLoaded({ kind: "checking" });
          timer = setTimeout(() => setAttempt((at) => at + 1), CHECK_AGAIN_MS);
        } else if (answer.kind === "closed") {
          setLoaded({ kind: "failed", message: answer.message });
        } else if (answer.kind === "missing") {
          setLoaded({
            kind: "failed",
            message: "This model isn’t there, or isn’t yours to open.",
          });
        } else {
          setLoaded({
            kind: "failed",
            message:
              answer.message ?? "The model didn’t load. Try again later.",
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded({
            kind: "failed",
            message: "The model didn’t load. Try again later.",
          });
        }
      });
    return () => {
      cancelled = true;
      abort.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [
    file.fileId,
    file.contentType,
    agentId,
    surfaceId,
    readFileModel,
    attempt,
  ]);
  return loaded;
};

// --- 4×4 column-major matrices ---------------------------------------------

type Mat4 = Float32Array;

const mul = (a: Mat4, b: Mat4): Mat4 => {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + r]! * b[c * 4 + k]!;
      }
      out[c * 4 + r] = sum;
    }
  }
  return out;
};

const perspective = (
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 => {
  const f = 1 / Math.tan(fovY / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
};

const lookAt = (
  eye: readonly number[],
  at: readonly number[],
  up: readonly number[],
): Mat4 => {
  const zx = eye[0]! - at[0]!;
  const zy = eye[1]! - at[1]!;
  const zz = eye[2]! - at[2]!;
  const zl = Math.hypot(zx, zy, zz) || 1;
  const z = [zx / zl, zy / zl, zz / zl];
  const xx = up[1]! * z[2]! - up[2]! * z[1]!;
  const xy = up[2]! * z[0]! - up[0]! * z[2]!;
  const xz = up[0]! * z[1]! - up[1]! * z[0]!;
  const xl = Math.hypot(xx, xy, xz) || 1;
  const x = [xx / xl, xy / xl, xz / xl];
  const y = [
    z[1]! * x[2]! - z[2]! * x[1]!,
    z[2]! * x[0]! - z[0]! * x[2]!,
    z[0]! * x[1]! - z[1]! * x[0]!,
  ];
  const dot = (v: number[]) =>
    v[0]! * eye[0]! + v[1]! * eye[1]! + v[2]! * eye[2]!;
  return new Float32Array([
    x[0]!,
    y[0]!,
    z[0]!,
    0,
    x[1]!,
    y[1]!,
    z[1]!,
    0,
    x[2]!,
    y[2]!,
    z[2]!,
    0,
    -dot(x),
    -dot(y),
    -dot(z),
    1,
  ]);
};

/** The inverse transpose of the upper 3×3, for normals (identity when singular). */
const normalMatrix = (m: Mat4): Float32Array => {
  const a = m[0]!,
    b = m[1]!,
    c = m[2]!;
  const d = m[4]!,
    e = m[5]!,
    f = m[6]!;
  const g = m[8]!,
    h = m[9]!,
    i = m[10]!;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) {
    return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  }
  const s = 1 / det;
  // The inverse's transpose is the cofactor matrix over the determinant.
  return new Float32Array([
    A * s,
    B * s,
    C * s,
    -(b * i - c * h) * s,
    (a * i - c * g) * s,
    -(a * h - b * g) * s,
    (b * f - c * e) * s,
    -(a * f - c * d) * s,
    (a * e - b * d) * s,
  ]);
};

// --- WebGL 2 -----------------------------------------------------------------

const VERTEX = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
uniform mat4 uModel;
uniform mat4 uViewProjection;
uniform mat3 uNormal;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vNormal = normalize(uNormal * aNormal);
  vUv = aUv;
  gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUv;
uniform vec4 uColor;
uniform bool uTextured;
uniform sampler2D uTexture;
uniform vec3 uLight;
out vec4 outColor;
void main() {
  vec4 base = uColor;
  if (uTextured) {
    base *= texture(uTexture, vUv);
  }
  vec3 n = normalize(gl_FrontFacing ? vNormal : -vNormal);
  float key = max(dot(n, normalize(uLight)), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.6, 0.3, -0.5))), 0.0) * 0.35;
  float light = 0.35 + 0.65 * key + fill;
  outColor = vec4(base.rgb * light, base.a);
}`;

/** One part's buffers, shared by every node that draws it. */
type Shape = { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[] };

type Drawn = {
  vao: WebGLVertexArrayObject;
  count: number;
  matrix: Mat4;
  normal: Float32Array;
  color: [number, number, number, number];
  texture?: number;
};

type Scene = {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  shapes: Shape[];
  drawn: Drawn[];
  textures: (WebGLTexture | null)[];
  uniforms: Record<string, WebGLUniformLocation | null>;
};

const compile = (gl: WebGL2RenderingContext): WebGLProgram | null => {
  const shader = (type: number, source: string) => {
    const made = gl.createShader(type);
    if (!made) {
      return null;
    }
    gl.shaderSource(made, source);
    gl.compileShader(made);
    return gl.getShaderParameter(made, gl.COMPILE_STATUS) ? made : null;
  };
  const vertex = shader(gl.VERTEX_SHADER, VERTEX);
  const fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) {
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
};

const buildScene = (
  gl: WebGL2RenderingContext,
  model: GlbModel,
): Scene | null => {
  const program = compile(gl);
  if (!program) {
    return null;
  }
  const drawn: Drawn[] = [];
  const shapes: Shape[] = [];
  // One set of buffers per part: every node using the same mesh shares it.
  const byPart = new Map<number, Shape>();
  for (const primitive of model.primitives) {
    const known = byPart.get(primitive.part);
    if (known) {
      drawn.push({
        vao: known.vao,
        count: primitive.indices.length,
        matrix: primitive.matrix,
        normal: normalMatrix(primitive.matrix),
        color: primitive.color,
        ...(primitive.texture !== undefined
          ? { texture: primitive.texture }
          : {}),
      });
      continue;
    }
    const vao = gl.createVertexArray();
    if (!vao) {
      return null;
    }
    gl.bindVertexArray(vao);
    const buffers: WebGLBuffer[] = [];
    const attribute = (location: number, data: Float32Array, size: number) => {
      const buffer = gl.createBuffer();
      if (!buffer) {
        return;
      }
      buffers.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    };
    attribute(0, primitive.positions, 3);
    attribute(1, primitive.normals, 3);
    if (primitive.uvs) {
      attribute(2, primitive.uvs, 2);
    } else {
      gl.disableVertexAttribArray(2);
      gl.vertexAttrib2f(2, 0, 0);
    }
    const index = gl.createBuffer();
    if (index) {
      buffers.push(index);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, primitive.indices, gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);
    const shape = { vao, buffers };
    shapes.push(shape);
    byPart.set(primitive.part, shape);
    drawn.push({
      vao,
      count: primitive.indices.length,
      matrix: primitive.matrix,
      normal: normalMatrix(primitive.matrix),
      color: primitive.color,
      ...(primitive.texture !== undefined
        ? { texture: primitive.texture }
        : {}),
    });
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of [
    "uModel",
    "uViewProjection",
    "uNormal",
    "uColor",
    "uTextured",
    "uTexture",
    "uLight",
  ]) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return {
    gl,
    program,
    shapes,
    drawn,
    textures: model.textures.map(() => null),
    uniforms,
  };
};

/** Decodes each embedded PNG or JPEG from a Blob (never a blob: URL) into a texture. */
const loadTextures = async (
  scene: Scene,
  model: GlbModel,
  isLive: () => boolean,
) => {
  const { gl } = scene;
  await Promise.all(
    model.textures.map(async (texture, index) => {
      try {
        const bitmap = await createImageBitmap(
          new Blob([texture.bytes as BlobPart], { type: texture.type }),
        );
        if (!isLive() || gl.isContextLost()) {
          bitmap.close();
          return;
        }
        const made = gl.createTexture();
        if (!made) {
          bitmap.close();
          return;
        }
        gl.bindTexture(gl.TEXTURE_2D, made);
        // glTF's UV origin is the top left, like the image's: no flip.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          bitmap,
        );
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.LINEAR_MIPMAP_LINEAR,
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        bitmap.close();
        scene.textures[index] = made;
      } catch {
        // An image that won't decode draws its material colour.
      }
    }),
  );
};

const disposeScene = (scene: Scene) => {
  const { gl } = scene;
  for (const shape of scene.shapes) {
    gl.deleteVertexArray(shape.vao);
    for (const buffer of shape.buffers) {
      gl.deleteBuffer(buffer);
    }
  }
  for (const texture of scene.textures) {
    if (texture) {
      gl.deleteTexture(texture);
    }
  }
  gl.deleteProgram(scene.program);
};

type View = { yaw: number; pitch: number; zoom: number };

const START: View = { yaw: Math.PI / 6, pitch: -Math.PI / 10, zoom: 1 };

const draw = (
  scene: Scene,
  model: GlbModel,
  view: View,
  width: number,
  height: number,
) => {
  const { gl, uniforms } = scene;
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(scene.program);
  const center = [0, 1, 2].map(
    (axis) => (model.min[axis]! + model.max[axis]!) / 2,
  );
  const radius =
    Math.hypot(
      model.max[0] - model.min[0],
      model.max[1] - model.min[1],
      model.max[2] - model.min[2],
    ) / 2 || 1;
  const fov = Math.PI / 4;
  const distance = radius / Math.sin(fov / 2) / view.zoom;
  const eye = [
    center[0]! + distance * Math.cos(view.pitch) * Math.sin(view.yaw),
    center[1]! - distance * Math.sin(view.pitch),
    center[2]! + distance * Math.cos(view.pitch) * Math.cos(view.yaw),
  ];
  const projection = perspective(
    fov,
    width / Math.max(1, height),
    Math.max(distance - radius * 2, distance / 1000),
    distance + radius * 2,
  );
  const viewProjection = mul(projection, lookAt(eye, center, [0, 1, 0]));
  gl.uniformMatrix4fv(uniforms.uViewProjection!, false, viewProjection);
  gl.uniform3f(
    uniforms.uLight!,
    eye[0]! - center[0]! + radius,
    eye[1]! - center[1]! + radius * 2,
    eye[2]! - center[2]!,
  );
  gl.uniform1i(uniforms.uTexture!, 0);
  for (const item of scene.drawn) {
    gl.uniformMatrix4fv(uniforms.uModel!, false, item.matrix);
    gl.uniformMatrix3fv(uniforms.uNormal!, false, item.normal);
    gl.uniform4fv(uniforms.uColor!, item.color);
    const texture =
      item.texture !== undefined ? scene.textures[item.texture] : null;
    gl.uniform1i(uniforms.uTextured!, texture ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture ?? null);
    gl.bindVertexArray(item.vao);
    gl.drawElements(gl.TRIANGLES, item.count, gl.UNSIGNED_INT, 0);
  }
  gl.bindVertexArray(null);
};

const ModelCanvas = ({
  model,
  alt,
  height,
  onFail,
}: {
  model: GlbModel;
  alt: string;
  height: string;
  onFail: (message: string) => void;
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const viewRef = useRef<View>({ ...START });
  const frameRef = useRef<number | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<number | null>(null);
  const [spoken, setSpoken] = useState("");
  const modelRef = useRef(model);
  modelRef.current = model;

  const requestDraw = () => {
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const canvas = canvasRef.current;
      const scene = sceneRef.current;
      if (!canvas || !scene || scene.gl.isContextLost()) {
        return;
      }
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const heightPx = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== heightPx) {
        canvas.width = width;
        canvas.height = heightPx;
      }
      draw(scene, modelRef.current, viewRef.current, width, heightPx);
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
    if (!gl) {
      onFail("This browser can’t draw 3D. Open it in the Kiingo app.");
      return;
    }
    const scene = buildScene(gl, model);
    if (!scene) {
      onFail("The model couldn’t be drawn here. Open it in the Kiingo app.");
      return;
    }
    sceneRef.current = scene;
    let live = true;
    void loadTextures(scene, model, () => live).then(() => {
      if (live) {
        requestDraw();
      }
    });
    const lost = (event: Event) => {
      event.preventDefault();
      onFail("The 3D view stopped. Reload the page to see it again.");
    };
    canvas.addEventListener("webglcontextlost", lost);
    const resize = new ResizeObserver(() => requestDraw());
    resize.observe(canvas);
    requestDraw();
    return () => {
      live = false;
      resize.disconnect();
      canvas.removeEventListener("webglcontextlost", lost);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (!gl.isContextLost()) {
        disposeScene(scene);
      }
      sceneRef.current = null;
    };
    // The model is read once per file; onFail is the parent's setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  const turn = (yaw: number, pitch: number) => {
    const view = viewRef.current;
    view.yaw += yaw;
    view.pitch = Math.max(-1.5, Math.min(1.5, view.pitch + pitch));
    requestDraw();
  };
  const zoomBy = (factor: number) => {
    const view = viewRef.current;
    view.zoom = model3dClampZoom(view.zoom * factor);
    requestDraw();
  };
  const reset = () => {
    viewRef.current = { ...START };
    setSpoken("View reset.");
    requestDraw();
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    pinchRef.current = null;
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const last = pointers.current.get(event.pointerId);
    if (!last) {
      return;
    }
    const next = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, next);
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const span = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinchRef.current && span > 0) {
        zoomBy(span / pinchRef.current);
      }
      pinchRef.current = span;
      return;
    }
    turn(-(next.x - last.x) * 0.01, (next.y - last.y) * 0.01);
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(event.pointerId);
    pinchRef.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => turn(-MODEL3D_TURN_STEP, 0),
      ArrowRight: () => turn(MODEL3D_TURN_STEP, 0),
      ArrowUp: () => turn(0, -MODEL3D_TURN_STEP),
      ArrowDown: () => turn(0, MODEL3D_TURN_STEP),
      "+": () => zoomBy(MODEL3D_ZOOM_STEP),
      "=": () => zoomBy(MODEL3D_ZOOM_STEP),
      "-": () => zoomBy(1 / MODEL3D_ZOOM_STEP),
      "0": reset,
    };
    const act = keys[event.key];
    if (act) {
      event.preventDefault();
      act();
    }
  };

  // Zoom on the wheel without scrolling the page (a passive React listener can't).
  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomRef.current(Math.exp(-event.deltaY * 0.002));
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <canvas
        ref={canvasRef}
        role="img"
        tabIndex={0}
        aria-label={`${alt} Drag or use the arrow keys to turn it; plus and minus zoom; 0 resets.`}
        className={cn(
          "w-full touch-none rounded-md bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          height,
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      />
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <SurfaceButton
          size="sm"
          aria-label="Turn left"
          onClick={() => turn(-MODEL3D_TURN_STEP, 0)}
        >
          ↺
        </SurfaceButton>
        <SurfaceButton
          size="sm"
          aria-label="Turn right"
          onClick={() => turn(MODEL3D_TURN_STEP, 0)}
        >
          ↻
        </SurfaceButton>
        <SurfaceButton
          size="sm"
          aria-label="Zoom in"
          onClick={() => zoomBy(MODEL3D_ZOOM_STEP)}
        >
          +
        </SurfaceButton>
        <SurfaceButton
          size="sm"
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / MODEL3D_ZOOM_STEP)}
        >
          −
        </SurfaceButton>
        <SurfaceButton size="sm" onClick={reset}>
          Reset view
        </SurfaceButton>
        <span className="text-muted-foreground">{model3dSizeLine(model)}</span>
        <span className="sr-only" aria-live="polite">
          {spoken}
        </span>
      </div>
    </div>
  );
};

export const Model3DView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const model = model3dModelOf({
    model: context.value(component, "model", scope),
    poster: context.value(component, "poster", scope),
    alt: component.props.alt,
    title: component.props.title,
    ar: component.props.ar,
    height: component.props.height,
  });
  const empty: Model3DFile = {};
  const loaded = useModelFile(model?.model ?? empty);
  const side = useMemo(
    () => posterSide(model?.poster, model?.alt ?? ""),
    [model?.poster, model?.alt],
  );
  const poster = usePicture(side);
  const [drawFailure, setDrawFailure] = useState<string | null>(null);
  useEffect(() => setDrawFailure(null), [loaded]);
  if (!model) {
    return <p className="text-xs text-muted-foreground">No model.</p>;
  }
  const outside = context.isUntrusted(component, "model", scope);
  const height = HEIGHTS[model.height] ?? HEIGHTS.md!;
  const fileId = model.model.fileId;
  const open =
    fileId && context.host.openFile ? (
      // The app's viewer: full size and Download.
      <SurfaceButton
        size="sm"
        onClick={() =>
          context.host.openFile?.({
            files: [
              {
                fileId,
                name: model.model.name ?? model.title ?? "3D model",
                contentType:
                  model.model.contentType ?? "application/octet-stream",
              },
            ],
            index: 0,
            surfaceId: context.surface.id,
            ...((model.model.agentId ?? context.surface.agentId)
              ? { agentId: model.model.agentId ?? context.surface.agentId }
              : {}),
          })
        }
      >
        Open
      </SurfaceButton>
    ) : null;
  const status =
    drawFailure ??
    (loaded.kind === "loading"
      ? "Loading the model…"
      : loaded.kind === "checking"
        ? "Checking…"
        : loaded.kind === "usdz"
          ? "Turn it and place it in the Kiingo app on iPhone or Mac."
          : loaded.kind === "failed"
            ? loaded.message
            : "");
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate font-medium">
          {model.title ??
            (outside ? (
              <QuotedText text={model.model.name ?? "3D model"} />
            ) : (
              (model.model.name ?? "3D model")
            ))}
        </span>
        <span className="flex shrink-0 items-center gap-1">{open}</span>
      </figcaption>
      {loaded.kind === "ready" && !drawFailure ? (
        <ModelCanvas
          model={loaded.model}
          alt={model.alt}
          height={height}
          onFail={setDrawFailure}
        />
      ) : (
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-md bg-muted/40 p-3 text-center text-xs text-muted-foreground",
            poster.kind === "image" ? undefined : height,
          )}
        >
          {poster.kind === "image" ? (
            <img
              src={poster.src}
              alt={model.alt}
              draggable={false}
              referrerPolicy="no-referrer"
              className={cn("block w-full rounded-md object-contain", height)}
            />
          ) : (
            <span>{model.alt}</span>
          )}
          <span role="status">{status}</span>
        </div>
      )}
    </figure>
  );
};
