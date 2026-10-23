// src/structures/engine.ts
var BLOCK_LIMIT = 30000000;
var MAX_SCAN = 16384;
var MAX_PIECES = 16384;
var decoder = new TextDecoder("utf-8", { fatal: true });
function integer(value, name, min, max) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}
function optionalInteger(value, fallback, name, min, max) {
  return value === undefined ? fallback : integer(value, name, min, max);
}
function optionalBoolean(value, name) {
  if (value === undefined)
    return false;
  if (typeof value !== "boolean")
    throw new TypeError(`${name} must be a boolean`);
  return value;
}

class StructureEngine {
  bridge;
  mc;
  configs = [];
  constructor(bridge) {
    this.bridge = bridge;
  }
  static async create(input) {
    const module = input instanceof WebAssembly.Module ? input : await WebAssembly.compile(input);
    let bridge;
    const view = () => {
      if (!bridge)
        throw new Error("WASI accessed memory before reactor instantiation");
      return new DataView(bridge.memory.buffer);
    };
    const wasi = {
      clock_time_get: (clockId, _precision, pointer) => {
        let nanoseconds;
        if (clockId === 0)
          nanoseconds = BigInt(Date.now()) * 1000000n;
        else if (clockId === 1) {
          if (typeof performance === "undefined")
            return 58;
          nanoseconds = BigInt(Math.floor(performance.now() * 1e6));
        } else
          return 28;
        view().setBigUint64(pointer, nanoseconds, true);
        return 0;
      },
      fd_write: (_fd, iovs, count, written) => {
        const data = view();
        let length = 0;
        for (let i = 0;i < count; i++)
          length += data.getUint32(iovs + i * 8 + 4, true);
        data.setUint32(written, length, true);
        return 0;
      },
      fd_close: () => 0,
      fd_seek: () => 70,
      fd_fdstat_get: (fd, pointer) => {
        if (fd < 0 || fd > 2)
          return 8;
        const data = view();
        for (let i = 0;i < 24; i++)
          data.setUint8(pointer + i, 0);
        data.setUint8(pointer, 2);
        return 0;
      },
      environ_sizes_get: (count, bytes) => {
        const data = view();
        data.setUint32(count, 0, true);
        data.setUint32(bytes, 0, true);
        return 0;
      },
      environ_get: () => 0,
      args_sizes_get: (count, bytes) => {
        const data = view();
        data.setUint32(count, 0, true);
        data.setUint32(bytes, 0, true);
        return 0;
      },
      args_get: () => 0,
      proc_exit: (code) => {
        throw new WebAssembly.RuntimeError(`Structure WASM exited with status ${code}`);
      }
    };
    for (const entry of WebAssembly.Module.imports(module)) {
      if (entry.kind !== "function" || entry.module !== "wasi_snapshot_preview1" || !(entry.name in wasi)) {
        throw new TypeError(`Unsupported structure WASM import ${entry.module}.${entry.name}`);
      }
    }
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
    const exports = instance.exports;
    if (!(exports.memory instanceof WebAssembly.Memory))
      throw new TypeError("Structure WASM must export memory");
    for (const name of ["sb_abi", "sb_set_world", "sb_run", "sb_result_ptr", "sb_result_len", "sb_error_ptr", "sb_destroy"]) {
      if (typeof exports[name] !== "function")
        throw new TypeError(`Structure WASM is missing ${name}`);
    }
    bridge = exports;
    bridge._initialize?.();
    if (bridge.sb_abi() !== 1)
      throw new TypeError("Unsupported structure WASM ABI");
    return new StructureEngine(bridge);
  }
  setWorld(mc, seed, largeBiomes) {
    const bridge = this.requireBridge();
    integer(mc, "mc", 3, 28);
    if (typeof seed !== "bigint" || seed < -(1n << 63n) || seed >= 1n << 63n)
      throw new RangeError("seed must be a signed 64-bit bigint");
    if (typeof largeBiomes !== "boolean")
      throw new TypeError("largeBiomes must be a boolean");
    if (largeBiomes && mc < 6)
      throw new RangeError("Large biomes require Minecraft 1.3 or newer");
    const bits = BigInt.asUintN(64, seed);
    if (bridge.sb_set_world(mc, Number(bits & 0xffffffffn), Number(bits >> 32n), largeBiomes ? 1 : 0))
      throw this.bridgeError();
    this.mc = mc;
    const catalog = this.run(0);
    this.configs = catalog.structures;
  }
  execute(request) {
    this.requireBridge();
    if (this.mc === undefined)
      throw new Error("Structure world is not initialized");
    if (!request || typeof request !== "object" || typeof request.op !== "string")
      throw new TypeError("Expected a structure request");
    let result;
    const type = () => integer("type" in request ? request.type : undefined, "type", 0, 24);
    const block = (value, name) => integer(value, name, -BLOCK_LIMIT, BLOCK_LIMIT);
    const chunk = (value, name) => integer(value, name, -1874999, 1874999);
    const region = (value, name, id, extent = 1) => {
      const coordinate = integer(value, name, -BLOCK_LIMIT, BLOCK_LIMIT);
      const config = this.configs[id];
      if (config.supported) {
        const span = config.regionSize * 16;
        if (coordinate * span < -BLOCK_LIMIT || (coordinate + extent) * span - 1 > BLOCK_LIMIT) {
          throw new RangeError(`${name} region bounds exceed the supported block-coordinate range`);
        }
      }
      return coordinate;
    };
    switch (request.op) {
      case "catalog":
        result = this.run(0);
        break;
      case "position": {
        const id = type();
        result = this.run(1, id, region(request.regionX, "regionX", id), region(request.regionZ, "regionZ", id));
        break;
      }
      case "scan": {
        const id = type();
        const width = integer(request.width, "width", 1, MAX_SCAN);
        const height = integer(request.height, "height", 1, MAX_SCAN);
        if (width * height > MAX_SCAN)
          throw new RangeError(`scan area must not exceed ${MAX_SCAN} regions`);
        const stage = request.stage === undefined ? "placement" : request.stage;
        if (stage !== "placement" && stage !== "biome" && stage !== "terrain")
          throw new TypeError("Unknown structure scan stage");
        result = this.run(2, id, region(request.regionX, "regionX", id, width), region(request.regionZ, "regionZ", id, height), width, height, stage === "placement" ? 0 : stage === "biome" ? 1 : 2, +optionalBoolean(request.includeRejected, "includeRejected"), optionalInteger(request.flags, 0, "flags", 0, 4294967295));
        break;
      }
      case "check":
        result = this.run(3, type(), block(request.x, "x"), block(request.z, "z"), optionalInteger(request.flags, 0, "flags", 0, 4294967295), +optionalBoolean(request.terrain, "terrain"));
        break;
      case "featureBiome":
        result = this.run(4, type(), integer(request.biome, "biome", 0, 255));
        break;
      case "variant": {
        const id = type();
        if (this.configs[id].variantRequiresBiome && request.biome === undefined)
          throw new TypeError("This structure variant requires an explicit biome");
        const biome = optionalInteger(request.biome, -1, "biome", -1, 255);
        if (this.configs[id].variantRequiresBiome && biome < 0)
          throw new RangeError("This structure variant requires a nonnegative biome");
        result = this.run(5, id, block(request.x, "x"), block(request.z, "z"), biome);
        break;
      }
      case "strongholds": {
        const total = this.mc >= 12 ? 128 : 3;
        const offset = optionalInteger(request.offset, 0, "offset", 0, total);
        const count = optionalInteger(request.count, total - offset, "count", 0, total - offset);
        result = this.run(6, 0, offset, count);
        break;
      }
      case "pieces": {
        const id = type();
        if (id !== 18 && id !== 20)
          throw new RangeError("pieces supports only Fortress (18) and End City (20)");
        result = this.run(7, id, chunk(request.chunkX, "chunkX"), chunk(request.chunkZ, "chunkZ"), optionalInteger(request.maxPieces, 4096, "maxPieces", 1, MAX_PIECES));
        break;
      }
      case "endIslands":
        result = this.run(8, 0, chunk(request.chunkX, "chunkX"), chunk(request.chunkZ, "chunkZ"));
        break;
      case "fixedGateways":
        result = this.run(9);
        break;
      case "linkedGateway": {
        const x = integer(request.x, "x", -46340, 46340), z = integer(request.z, "z", -46340, 46340);
        if (x === 0 && z === 0 || x * x + z * z > 2147483647)
          throw new RangeError("Gateway source must be nonzero with squared radius at most INT32_MAX");
        result = this.run(10, 0, x, z);
        break;
      }
      case "villageHouses":
        result = this.run(11, 0, chunk(request.chunkX, "chunkX"), chunk(request.chunkZ, "chunkZ"));
        break;
      case "endChunkEmpty":
        result = this.run(12, 0, chunk(request.chunkX, "chunkX"), chunk(request.chunkZ, "chunkZ"));
        break;
      default:
        throw new TypeError("Unknown structure operation");
    }
    return result;
  }
  destroy() {
    if (!this.bridge)
      return;
    this.bridge.sb_destroy();
    this.bridge = undefined;
    this.configs = [];
    this.mc = undefined;
  }
  requireBridge() {
    if (!this.bridge)
      throw new Error("Structure engine has been destroyed");
    return this.bridge;
  }
  bridgeError(status = -1) {
    const bridge = this.requireBridge();
    const bytes = new Uint8Array(bridge.memory.buffer);
    const start = bridge.sb_error_ptr() >>> 0;
    let end = start;
    while (end < bytes.length && bytes[end] !== 0 && end - start < 4096)
      end++;
    const message = decoder.decode(bytes.subarray(start, end)) || "Structure WASM operation failed";
    return status === -2 ? new RangeError(message) : new Error(message);
  }
  run(op, type = 0, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0) {
    const bridge = this.requireBridge();
    const status = bridge.sb_run(op, type, a, b, c, d, e, f, g, h);
    if (status)
      throw this.bridgeError(status);
    const start = bridge.sb_result_ptr() >>> 0, length = bridge.sb_result_len() >>> 0;
    if (length === 0 || length > 16 * 1024 * 1024 || start + length > bridge.memory.buffer.byteLength)
      throw new Error("Invalid structure WASM result bounds");
    return JSON.parse(decoder.decode(new Uint8Array(bridge.memory.buffer, start, length)));
  }
}

// src/core/bundle.ts
var CLIMATE_FIELDS = ["temperature", "vegetation", "continents", "erosion", "depth", "ridges"];
function qualify(id) {
  return id.includes(":") ? id : `minecraft:${id}`;
}
function validateBundle(value) {
  if (!value || typeof value !== "object")
    throw new Error("bundle: not an object");
  const b = value;
  if (b.format !== 1)
    throw new Error(`bundle: unsupported format ${String(b.format)}`);
  for (const key of ["noise", "density_function", "noise_settings", "biome_parameters", "dimensions"]) {
    if (!b[key] || typeof b[key] !== "object")
      throw new Error(`bundle: missing "${key}"`);
  }
  const bundle = value;
  for (const [name, dim] of Object.entries(bundle.dimensions)) {
    if (!bundle.noise_settings[dim.settings])
      throw new Error(`bundle: dimension ${name} references missing noise_settings ${dim.settings}`);
    if (dim.source.type === "multi_noise" && !bundle.biome_parameters[dim.source.parameters]) {
      throw new Error(`bundle: dimension ${name} references missing biome_parameters ${dim.source.parameters}`);
    }
  }
  return bundle;
}

// src/core/climate.ts
var quantize = (v) => Math.trunc(Math.fround(Math.fround(v) * 1e4));
var AXES = ["temperature", "humidity", "continentalness", "erosion", "depth", "weirdness"];
var DIMS = 7;
var FANOUT = 6;
var mid = (b, d) => Math.trunc((b[d * 2] + b[d * 2 + 1]) / 2);
function unionBox(nodes) {
  const u = new Int32Array(DIMS * 2);
  for (let d = 0;d < DIMS; d++) {
    let lo = Infinity, hi = -Infinity;
    for (const n of nodes) {
      lo = Math.min(lo, n.box[d * 2]);
      hi = Math.max(hi, n.box[d * 2 + 1]);
    }
    u[d * 2] = lo;
    u[d * 2 + 1] = hi;
  }
  return u;
}
var subTree = (children) => ({ box: unionBox(children), entry: -1, children });
function sortByAxis(nodes, dim, absolute) {
  nodes.sort((a, b) => {
    for (let i = 0;i < DIMS; i++) {
      const d = (dim + i) % DIMS;
      let ka = mid(a.box, d), kb = mid(b.box, d);
      if (absolute) {
        ka = Math.abs(ka);
        kb = Math.abs(kb);
      }
      if (ka !== kb)
        return ka - kb;
    }
    return 0;
  });
}
function bucketize(nodes) {
  const size = Math.pow(FANOUT, Math.floor(Math.log(nodes.length - 0.01) / Math.log(FANOUT)));
  const out = [];
  for (let i = 0;i < nodes.length; i += size)
    out.push(subTree(nodes.slice(i, i + size)));
  return out;
}
function extent(b) {
  let s = 0;
  for (let d = 0;d < DIMS; d++)
    s += Math.abs(b[d * 2 + 1] - b[d * 2]);
  return s;
}
function build(nodes) {
  if (nodes.length === 1)
    return nodes[0];
  if (nodes.length <= FANOUT) {
    const key = (n) => {
      let s = 0;
      for (let d = 0;d < DIMS; d++)
        s += Math.abs(mid(n.box, d));
      return s;
    };
    const sorted = [...nodes].sort((a, b) => key(a) - key(b));
    return subTree(sorted);
  }
  let bestCost = Infinity, bestDim = -1, bestBuckets = [];
  const work = [...nodes];
  for (let d = 0;d < DIMS; d++) {
    sortByAxis(work, d, false);
    const buckets = bucketize(work);
    let cost = 0;
    for (const b of buckets)
      cost += extent(b.box);
    if (bestCost > cost) {
      bestCost = cost;
      bestDim = d;
      bestBuckets = buckets;
    }
  }
  sortByAxis(bestBuckets, bestDim, true);
  return subTree(bestBuckets.map((b) => build(b.children)));
}
function paramRange(p) {
  return typeof p === "number" ? [quantize(p), quantize(p)] : [quantize(p[0]), quantize(p[1])];
}
function buildClimateIndex(entries) {
  if (entries.length === 0)
    throw new Error("biome parameter list is empty");
  const biomes = [];
  const biomeIdx = new Map;
  const entryBiome = new Int32Array(entries.length);
  const leaves = entries.map((e, i) => {
    let b = biomeIdx.get(e.biome);
    if (b === undefined) {
      b = biomes.length;
      biomes.push(e.biome);
      biomeIdx.set(e.biome, b);
    }
    entryBiome[i] = b;
    const p = e.parameters;
    const box = new Int32Array(DIMS * 2);
    AXES.forEach((a, d) => {
      const [lo, hi] = paramRange(p[a]);
      box[d * 2] = lo;
      box[d * 2 + 1] = hi;
    });
    const off = quantize(p.offset);
    box[12] = off;
    box[13] = off;
    return { box, entry: i, children: [] };
  });
  const root = build(leaves);
  const order = [root];
  const first = [];
  for (let q = 0;q < order.length; q++) {
    const n = order[q];
    first.push(n.children.length ? order.length : -1);
    for (const c of n.children)
      order.push(c);
  }
  const bounds = new Int32Array(order.length * DIMS * 2);
  const child = new Int32Array(order.length);
  const count = new Int32Array(order.length);
  const leafNode = new Int32Array(entries.length);
  order.forEach((n, i) => {
    bounds.set(n.box, i * DIMS * 2);
    if (n.children.length) {
      child[i] = first[i];
      count[i] = n.children.length;
    } else {
      child[i] = ~n.entry;
      leafNode[n.entry] = i;
    }
  });
  return { biomes, entryBiome, bounds, child, count, leafNode };
}
function boxDistance(bounds, node, t) {
  let s = 0;
  const o = node * DIMS * 2;
  for (let d = 0;d < DIMS; d++) {
    const v = t[d];
    const lo = bounds[o + d * 2], hi = bounds[o + d * 2 + 1];
    const e = v > hi ? v - hi : v < lo ? lo - v : 0;
    s += e * e;
  }
  return s;
}
function searchClimate(idx, target, candidate = -1) {
  const { bounds, child, count } = idx;
  let best = candidate >= 0 ? boxDistance(bounds, idx.leafNode[candidate], target) : Infinity;
  let res = candidate;
  if (child[0] < 0)
    return ~child[0];
  const stack = [];
  for (let i = count[0] - 1;i >= 0; i--)
    stack.push(child[0] + i);
  while (stack.length) {
    const n = stack.pop();
    const d = boxDistance(bounds, n, target);
    if (!(best > d))
      continue;
    const c = child[n];
    if (c < 0) {
      best = d;
      res = ~c;
      continue;
    }
    for (let i = count[n] - 1;i >= 0; i--)
      stack.push(c + i);
  }
  return res;
}

// src/core/density.ts
var PASSTHROUGH = new Set(["flat_cache", "cache_2d", "cache_once", "cache_all_in_cell", "interpolated", "blend_density"]);
var UNARY = new Set(["abs", "square", "cube", "half_negative", "quarter_negative", "squeeze", "invert"]);
var BINARY = new Set(["add", "mul", "min", "max"]);

class DensityCompileError extends Error {
}

class DensityProgram {
  bundle;
  nodes = [];
  noises = [];
  splineCount = 0;
  byKey = new Map;
  byRef = new Map;
  resolving = new Set;
  constructor(bundle) {
    this.bundle = bundle;
  }
  compile(json, path = "$") {
    if (typeof json === "number")
      return this.add({ op: "const", value: json });
    if (typeof json === "string")
      return this.ref(qualify(json), path);
    if (!json || typeof json !== "object" || typeof json.type !== "string") {
      throw new DensityCompileError(`${path}: expected number, id or object with "type"`);
    }
    const type = json.type.replace(/^minecraft:/, "");
    const arg = (k) => {
      if (!(k in json))
        throw new DensityCompileError(`${path}: ${type} missing "${k}"`);
      return this.compile(json[k], `${path}.${k}`);
    };
    const num = (k, fallback) => {
      const v = json[k] ?? fallback;
      if (typeof v !== "number")
        throw new DensityCompileError(`${path}: ${type}.${k} must be a number`);
      return v;
    };
    const noiseId = (k) => {
      const v = json[k];
      if (typeof v !== "string")
        throw new DensityCompileError(`${path}: ${type}.${k} must be a noise id (inline noise is unsupported)`);
      const id = qualify(v);
      if (!this.bundle.noise[id])
        throw new DensityCompileError(`${path}: unknown noise ${id}`);
      if (!this.noises.includes(id))
        this.noises.push(id);
      return id;
    };
    if (PASSTHROUGH.has(type))
      return arg("argument");
    if (UNARY.has(type))
      return this.add({ op: "unary", fn: type, a: arg("argument") });
    if (BINARY.has(type))
      return this.add({ op: "binary", fn: type, a: arg("argument1"), b: arg("argument2") });
    switch (type) {
      case "constant":
        return this.add({ op: "const", value: num("argument") });
      case "blend_offset":
        return this.add({ op: "const", value: 0 });
      case "blend_alpha":
        return this.add({ op: "const", value: 1 });
      case "beardifier":
        return this.add({ op: "const", value: 0 });
      case "y_clamped_gradient":
        return this.add({ op: "y_gradient", fromY: num("from_y"), toY: num("to_y"), fromValue: num("from_value"), toValue: num("to_value") });
      case "clamp":
        return this.add({ op: "clamp", a: arg("input"), min: num("min"), max: num("max") });
      case "range_choice":
        return this.add({
          op: "range_choice",
          input: arg("input"),
          min: num("min_inclusive"),
          max: num("max_exclusive"),
          inside: arg("when_in_range"),
          outside: arg("when_out_of_range")
        });
      case "noise": {
        const zero = this.add({ op: "const", value: 0 });
        return this.add({ op: "noise", noise: noiseId("noise"), xzScale: num("xz_scale", 1), yScale: num("y_scale", 1), sx: zero, sy: zero, sz: zero });
      }
      case "shifted_noise":
        return this.add({
          op: "noise",
          noise: noiseId("noise"),
          xzScale: num("xz_scale", 1),
          yScale: num("y_scale", 1),
          sx: arg("shift_x"),
          sy: arg("shift_y"),
          sz: arg("shift_z")
        });
      case "shift_a":
        return this.add({ op: "shift", noise: noiseId("argument"), axes: "a" });
      case "shift_b":
        return this.add({ op: "shift", noise: noiseId("argument"), axes: "b" });
      case "shift":
        return this.add({ op: "shift", noise: noiseId("argument"), axes: "xyz" });
      case "spline":
        return this.add({ op: "spline", spline: this.spline(json.spline, `${path}.spline`) });
      case "end_islands":
        return this.add({ op: "end_islands" });
      default:
        throw new DensityCompileError(`${path}: density function type "${json.type}" is not supported for biome sampling`);
    }
  }
  ref(id, path) {
    const hit = this.byRef.get(id);
    if (hit !== undefined)
      return hit;
    const def = this.bundle.density_function[id];
    if (def === undefined)
      throw new DensityCompileError(`${path}: unknown density function ${id}`);
    if (this.resolving.has(id))
      throw new DensityCompileError(`${path}: cyclic reference through ${id}`);
    this.resolving.add(id);
    const n = this.compile(def, id);
    this.resolving.delete(id);
    this.byRef.set(id, n);
    return n;
  }
  spline(json, path) {
    if (typeof json === "number")
      return { kind: "const", value: Math.fround(json) };
    if (!json || typeof json !== "object")
      throw new DensityCompileError(`${path}: spline must be a number or object`);
    const s = json;
    if (s.coordinate === undefined || !Array.isArray(s.points) || s.points.length === 0) {
      throw new DensityCompileError(`${path}: spline needs "coordinate" and non-empty "points"`);
    }
    const coord = this.compile(s.coordinate, `${path}.coordinate`);
    const pts = s.points;
    for (let i = 1;i < pts.length; i++) {
      if (!(pts[i].location >= pts[i - 1].location))
        throw new DensityCompileError(`${path}: spline locations must be ascending`);
    }
    return {
      kind: "multi",
      id: this.splineCount++,
      coord,
      locations: pts.map((p) => Math.fround(p.location)),
      values: pts.map((p, i) => this.spline(p.value, `${path}.points[${i}].value`)),
      derivatives: pts.map((p) => Math.fround(p.derivative))
    };
  }
  add(node) {
    const key = node.op === "spline" ? `spline#${this.splineCount}#${this.nodes.length}` : JSON.stringify(node);
    const hit = this.byKey.get(key);
    if (hit !== undefined)
      return hit;
    this.nodes.push(node);
    const idx = this.nodes.length - 1;
    this.byKey.set(key, idx);
    return idx;
  }
}

// src/core/noise.ts
var GRADIENTS = [
  [1, 1, 0],
  [-1, 1, 0],
  [1, -1, 0],
  [-1, -1, 0],
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 1],
  [0, -1, 1],
  [0, 1, -1],
  [0, -1, -1],
  [1, 1, 0],
  [0, -1, 1],
  [-1, 1, 0],
  [0, -1, -1]
];
var smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10);
var lerp = (t, a, b) => a + t * (b - a);

class ImprovedNoise {
  perm = new Uint8Array(256);
  xo;
  yo;
  zo;
  constructor(r) {
    this.xo = r.nextDouble() * 256;
    this.yo = r.nextDouble() * 256;
    this.zo = r.nextDouble() * 256;
    const p = this.perm;
    for (let i = 0;i < 256; i++)
      p[i] = i;
    for (let i = 0;i < 256; i++) {
      const j = r.nextInt(256 - i);
      const t = p[i];
      p[i] = p[i + j];
      p[i + j] = t;
    }
  }
  noise(x, y, z) {
    const dx = x + this.xo, dy = y + this.yo, dz = z + this.zo;
    const ix = Math.floor(dx), iy = Math.floor(dy), iz = Math.floor(dz);
    return this.sampleLattice(ix, iy, iz, dx - ix, dy - iy, dz - iz);
  }
  sampleLattice(ix, iy, iz, fx, fy, fz) {
    const p = this.perm;
    const a = p[ix & 255], b = p[ix + 1 & 255];
    const aa = p[a + iy & 255], ab = p[a + iy + 1 & 255];
    const ba = p[b + iy & 255], bb = p[b + iy + 1 & 255];
    const g = (h, x, y, z) => {
      const v = GRADIENTS[h & 15];
      return v[0] * x + v[1] * y + v[2] * z;
    };
    const n000 = g(p[aa + iz & 255], fx, fy, fz);
    const n100 = g(p[ba + iz & 255], fx - 1, fy, fz);
    const n010 = g(p[ab + iz & 255], fx, fy - 1, fz);
    const n110 = g(p[bb + iz & 255], fx - 1, fy - 1, fz);
    const n001 = g(p[aa + iz + 1 & 255], fx, fy, fz - 1);
    const n101 = g(p[ba + iz + 1 & 255], fx - 1, fy, fz - 1);
    const n011 = g(p[ab + iz + 1 & 255], fx, fy - 1, fz - 1);
    const n111 = g(p[bb + iz + 1 & 255], fx - 1, fy - 1, fz - 1);
    const sx = smooth(fx), sy = smooth(fy), sz = smooth(fz);
    return lerp(sz, lerp(sy, lerp(sx, n000, n100), lerp(sx, n010, n110)), lerp(sy, lerp(sx, n001, n101), lerp(sx, n011, n111)));
  }
}
var wrap = (v) => v - Math.floor(v / 33554432 + 0.5) * 33554432;

class PerlinNoise {
  octaves;
  constructor(octaves) {
    this.octaves = octaves;
  }
  static create(r, p) {
    const len = p.amplitudes.length;
    const pos = r.forkPositional();
    const octaves = [];
    let inputFactor = 2 ** p.firstOctave;
    let valueFactor = 2 ** (len - 1) / (2 ** len - 1);
    for (let i = 0;i < len; i++, inputFactor *= 2, valueFactor /= 2) {
      const amp = p.amplitudes[i];
      if (amp === 0)
        continue;
      octaves.push({ noise: new ImprovedNoise(pos.fromHashOf(`octave_${p.firstOctave + i}`)), inputFactor, weight: amp * valueFactor });
    }
    return new PerlinNoise(octaves);
  }
  static createLegacy(r, p) {
    const len = p.amplitudes.length;
    const highest = p.firstOctave + len - 1;
    if (highest > 0)
      throw new Error("legacy noise with positive octaves is unsupported");
    r.consume(-highest * 262);
    const levels = new Array(len).fill(null);
    for (let i = len - 1;i >= 0; i--) {
      if (p.amplitudes[i] !== 0)
        levels[i] = new ImprovedNoise(r);
      else
        r.consume(262);
    }
    const octaves = [];
    let inputFactor = 2 ** p.firstOctave;
    let valueFactor = 2 ** (len - 1) / (2 ** len - 1);
    for (let i = 0;i < len; i++, inputFactor *= 2, valueFactor /= 2) {
      const n = levels[i];
      if (n)
        octaves.push({ noise: n, inputFactor, weight: p.amplitudes[i] * valueFactor });
    }
    return new PerlinNoise(octaves);
  }
  sample(x, y, z) {
    let v = 0;
    for (const o of this.octaves) {
      v += o.weight * o.noise.noise(wrap(x * o.inputFactor), wrap(y * o.inputFactor), wrap(z * o.inputFactor));
    }
    return v;
  }
}
var NORMAL_B_FACTOR = 1.0181268882175227;

class NormalNoise {
  a;
  b;
  valueFactor;
  constructor(a, b, p) {
    this.a = a;
    this.b = b;
    let lo = Infinity, hi = -Infinity;
    p.amplitudes.forEach((v, i) => {
      if (v !== 0) {
        lo = Math.min(lo, i);
        hi = Math.max(hi, i);
      }
    });
    const span = hi - lo;
    this.valueFactor = hi < lo ? 0 : 1 / 6 / (0.1 * (1 + 1 / (span + 1)));
  }
  static create(r, p) {
    return new NormalNoise(PerlinNoise.create(r, p), PerlinNoise.create(r, p), p);
  }
  static createLegacy(r, p) {
    return new NormalNoise(PerlinNoise.createLegacy(r, p), PerlinNoise.createLegacy(r, p), p);
  }
  sample(x, y, z) {
    const f = NORMAL_B_FACTOR;
    return (this.a.sample(x, y, z) + this.b.sample(x * f, y * f, z * f)) * this.valueFactor;
  }
}

// src/core/md5.ts
var S = [
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21
];
var K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
function md5(input) {
  const bitLen = input.length * 8;
  const padLen = (input.length + 8 >> 6) + 1 << 6;
  const msg = new Uint8Array(padLen);
  msg.set(input);
  msg[input.length] = 128;
  const view = new DataView(msg.buffer);
  view.setUint32(padLen - 8, bitLen >>> 0, true);
  view.setUint32(padLen - 4, Math.floor(bitLen / 2 ** 32), true);
  let a0 = 1732584193, b0 = 4023233417, c0 = 2562383102, d0 = 271733878;
  const m = new Uint32Array(16);
  for (let off = 0;off < padLen; off += 64) {
    for (let i = 0;i < 16; i++)
      m[i] = view.getUint32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0;i < 64; i++) {
      let f, g;
      if (i < 16) {
        f = b & c | ~b & d;
        g = i;
      } else if (i < 32) {
        f = d & b | ~d & c;
        g = 5 * i + 1 & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = 3 * i + 5 & 15;
      } else {
        f = c ^ (b | ~d);
        g = 7 * i & 15;
      }
      const t = a + f + K[i] + m[g] >>> 0;
      a = d;
      d = c;
      c = b;
      b = b + (t << S[i] | t >>> 32 - S[i]) >>> 0;
    }
    a0 = a0 + a >>> 0;
    b0 = b0 + b >>> 0;
    c0 = c0 + c >>> 0;
    d0 = d0 + d >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return out;
}
function md5Seed(text) {
  const h = md5(new TextEncoder().encode(text));
  const v = new DataView(h.buffer);
  return { lo: v.getBigUint64(0, false), hi: v.getBigUint64(8, false) };
}

// src/core/rng.ts
var M64 = (1n << 64n) - 1n;
var M48 = (1n << 48n) - 1n;
var rotl64 = (x, r) => (x << r | x >> 64n - r) & M64;
var toI64 = (x) => BigInt.asIntN(64, x);
var toU64 = (x) => BigInt.asUintN(64, x);
function mixStafford13(z) {
  z = (z ^ z >> 30n) * 0xbf58476d1ce4e5b9n & M64;
  z = (z ^ z >> 27n) * 0x94d049bb133111ebn & M64;
  return z ^ z >> 31n;
}

class Xoroshiro {
  lo;
  hi;
  constructor(lo, hi) {
    lo = toU64(lo);
    hi = toU64(hi);
    if (lo === 0n && hi === 0n) {
      lo = 0x9e3779b97f4a7c15n;
      hi = 0x6a09e667f3bcc909n;
    }
    this.lo = lo;
    this.hi = hi;
  }
  static fromSeed(seed) {
    const l = toU64(seed) ^ 0x6a09e667f3bcc909n;
    const h = l + 0x9e3779b97f4a7c15n & M64;
    return new Xoroshiro(mixStafford13(l), mixStafford13(h));
  }
  nextLong() {
    const l = this.lo;
    let h = this.hi;
    const n = rotl64(l + h & M64, 17n) + l & M64;
    h ^= l;
    this.lo = rotl64(l, 49n) ^ h ^ h << 21n & M64;
    this.hi = rotl64(h, 28n);
    return n;
  }
  nextInt(bound) {
    const b = BigInt(bound);
    let m = (this.nextLong() & 0xffffffffn) * b;
    let low = m & 0xffffffffn;
    if (low < b) {
      const threshold = (~b + 1n & 0xffffffffn) % b;
      while (low < threshold) {
        m = (this.nextLong() & 0xffffffffn) * b;
        low = m & 0xffffffffn;
      }
    }
    return Number(m >> 32n);
  }
  nextDouble() {
    return Number(this.nextLong() >> 11n) * 2 ** -53;
  }
  consume(count) {
    for (let i = 0;i < count; i++)
      this.nextLong();
  }
  forkPositional() {
    const lo = this.nextLong();
    const hi = this.nextLong();
    return {
      fromHashOf: (name) => {
        const h = md5Seed(name);
        return new Xoroshiro(lo ^ h.lo, hi ^ h.hi);
      }
    };
  }
}

class LegacyRandom {
  seed;
  constructor(seed) {
    this.seed = (toU64(seed) ^ 0x5deece66dn) & M48;
  }
  next(bits) {
    this.seed = this.seed * 0x5deece66dn + 0xbn & M48;
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }
  nextLong() {
    return toU64((BigInt(this.next(32)) << 32n) + BigInt(this.next(32)));
  }
  nextInt(bound) {
    if ((bound & -bound) === bound) {
      return Number(BigInt(bound) * BigInt(this.next(31)) >> 31n);
    }
    let bits;
    let val;
    do {
      bits = this.next(31);
      val = bits % bound;
    } while ((bits - val + (bound - 1) | 0) < 0);
    return val;
  }
  nextDouble() {
    return (this.next(26) * 2 ** 27 + this.next(27)) * 2 ** -53;
  }
  consume(count) {
    for (let i = 0;i < count; i++)
      this.next(32);
  }
  forkPositional() {
    const base = toI64(this.nextLong());
    return {
      fromHashOf: (name) => new LegacyRandom(BigInt(javaStringHash(name)) ^ base)
    };
  }
}
function javaStringHash(s) {
  let h = 0;
  for (let i = 0;i < s.length; i++)
    h = Math.imul(h, 31) + s.charCodeAt(i) | 0;
  return h;
}

// src/core/end.ts
var SKEW = 0.5 * (Math.sqrt(3) - 1);
var UNSKEW = (3 - Math.sqrt(3)) / 6;
var f = Math.fround;
function simplex2(perm, x, y) {
  const s = (x + y) * SKEW;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * UNSKEW;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = 1 - i1;
  const x1 = x0 - i1 + UNSKEW, y1 = y0 - j1 + UNSKEW;
  const x2 = x0 - 1 + 2 * UNSKEW, y2 = y0 - 1 + 2 * UNSKEW;
  const p = (k) => perm[k & 255];
  const corner = (g, cx, cy) => {
    let c = 0.5 - cx * cx - cy * cy;
    if (c < 0)
      return 0;
    c *= c;
    const v = GRADIENTS[g];
    return c * c * (v[0] * cx + v[1] * cy);
  };
  return 70 * (corner(p(i + p(j)) % 12, x0, y0) + corner(p(i + i1 + p(j + j1)) % 12, x1, y1) + corner(p(i + 1 + p(j + 1)) % 12, x2, y2));
}

class EndIslands {
  perm;
  constructor(seed) {
    const r = new LegacyRandom(seed);
    r.consume(17292);
    this.perm = new ImprovedNoise(r).perm;
  }
  height(cx, cz) {
    const hx = cx / 2 | 0, hz = cz / 2 | 0;
    const ox = cx % 2, oz = cz % 2;
    let best = f(100 - f(f(Math.sqrt(f(Math.imul(cx, cx) + Math.imul(cz, cz) | 0))) * 8));
    best = Math.min(80, Math.max(-100, best));
    for (let i = -12;i <= 12; i++) {
      for (let j = -12;j <= 12; j++) {
        const rx = hx + i, rz = hz + j;
        if (rx * rx + rz * rz <= 4096 || simplex2(this.perm, rx, rz) >= f(-0.9))
          continue;
        const size = f(f(f(f(Math.abs(rx)) * 3439) + f(f(Math.abs(rz)) * 147)) % 13 + 9);
        const dx = f(ox - i * 2), dz = f(oz - j * 2);
        let h = f(100 - f(f(Math.sqrt(f(f(dx * dx) + f(dz * dz)))) * size));
        h = Math.min(80, Math.max(-100, h));
        if (h > best)
          best = h;
      }
    }
    return best;
  }
  density(bx, bz) {
    return (this.height(Math.trunc(bx / 8), Math.trunc(bz / 8)) - 8) / 128;
  }
}
function endBiome(qx, qz, erosionAt) {
  const sx = qx << 2 >> 4, sz = qz << 2 >> 4;
  if (sx * sx + sz * sz <= 4096)
    return "minecraft:the_end";
  const e = erosionAt((sx * 2 + 1) * 8, (sz * 2 + 1) * 8);
  if (e > 0.25)
    return "minecraft:end_highlands";
  if (e >= -0.0625)
    return "minecraft:end_midlands";
  if (e < -0.21875)
    return "minecraft:small_end_islands";
  return "minecraft:end_barrens";
}

// src/core/evaluate.ts
var f2 = Math.fround;

class NoiseSet {
  byId = new Map;
  endIslands;
  constructor(bundle, ids, seed, legacy) {
    const factory = legacy ? new LegacyRandom(seed).forkPositional() : Xoroshiro.fromSeed(seed).forkPositional();
    const overrides = legacy ? bundle.legacy_noise_overrides ?? DEFAULT_LEGACY_NOISE_OVERRIDES : {};
    for (const id of ids) {
      const o = overrides[id];
      const params = o?.noise ?? bundle.noise[id];
      let noise;
      if (o?.zero)
        noise = NormalNoise.create(factory.fromHashOf(id), { firstOctave: 0, amplitudes: [0] });
      else if (o?.seed_offset !== undefined)
        noise = NormalNoise.createLegacy(new LegacyRandom(seed + BigInt(o.seed_offset)), params);
      else
        noise = NormalNoise.create(factory.fromHashOf(id), params);
      this.byId.set(id, noise);
    }
    this.endIslands = new EndIslands(seed);
  }
}
var DEFAULT_LEGACY_NOISE_OVERRIDES = {
  "minecraft:temperature": { seed_offset: 0, noise: { firstOctave: -7, amplitudes: [1, 1] } },
  "minecraft:vegetation": { seed_offset: 1, noise: { firstOctave: -7, amplitudes: [1, 1] } },
  "minecraft:offset": { zero: true },
  "minecraft:nether/temperature": { seed_offset: 0 },
  "minecraft:nether/vegetation": { seed_offset: 1 }
};
function splineValue(s, v) {
  if (s.kind === "const")
    return s.value;
  const x = f2(v[s.coord]);
  const locs = s.locations;
  const last = locs.length - 1;
  let i = -1;
  while (i < last && x >= locs[i + 1])
    i++;
  if (i < 0 || i === last) {
    const k = i < 0 ? 0 : last;
    const base = splineValue(s.values[k], v);
    const d = s.derivatives[k];
    return d === 0 ? base : f2(base + f2(d * f2(x - locs[k])));
  }
  const g = locs[i], h = locs[i + 1];
  const t = f2(f2(x - g) / f2(h - g));
  const n = splineValue(s.values[i], v);
  const o = splineValue(s.values[i + 1], v);
  const span = f2(h - g);
  const p = f2(f2(s.derivatives[i] * span) - f2(o - n));
  const q = f2(f2(f2(-s.derivatives[i + 1]) * span) + f2(o - n));
  const lerpNO = f2(n + f2(t * f2(o - n)));
  const lerpPQ = f2(p + f2(t * f2(q - p)));
  return f2(lerpNO + f2(f2(t * f2(1 - t)) * lerpPQ));
}
function evalNode(n, v, noises, bx, by, bz) {
  switch (n.op) {
    case "const":
      return n.value;
    case "y_linear":
      return n.offset + by * n.scale;
    case "y_gradient": {
      const t = (by - n.fromY) / (n.toY - n.fromY);
      return t < 0 ? n.fromValue : t > 1 ? n.toValue : n.fromValue + t * (n.toValue - n.fromValue);
    }
    case "unary": {
      const a = v[n.a];
      switch (n.fn) {
        case "abs":
          return Math.abs(a);
        case "square":
          return a * a;
        case "cube":
          return a * a * a;
        case "half_negative":
          return a > 0 ? a : a * 0.5;
        case "quarter_negative":
          return a > 0 ? a : a * 0.25;
        case "invert":
          return 1 / a;
        case "squeeze": {
          const c = Math.min(1, Math.max(-1, a));
          return c / 2 - c * c * c / 24;
        }
      }
      throw new Error("unreachable");
    }
    case "binary": {
      const a = v[n.a], b = v[n.b];
      switch (n.fn) {
        case "add":
          return a + b;
        case "mul":
          return a * b;
        case "min":
          return Math.min(a, b);
        case "max":
          return Math.max(a, b);
      }
      throw new Error("unreachable");
    }
    case "clamp":
      return Math.min(n.max, Math.max(n.min, v[n.a]));
    case "range_choice": {
      const x = v[n.input];
      return x >= n.min && x < n.max ? v[n.inside] : v[n.outside];
    }
    case "noise":
      return noises.byId.get(n.noise).sample(bx * n.xzScale + v[n.sx], by * n.yScale + v[n.sy], bz * n.xzScale + v[n.sz]);
    case "shift": {
      const nn = noises.byId.get(n.noise);
      if (n.axes === "a")
        return nn.sample(bx * 0.25, 0, bz * 0.25) * 4;
      if (n.axes === "b")
        return nn.sample(bz * 0.25, bx * 0.25, 0) * 4;
      return nn.sample(bx * 0.25, by * 0.25, bz * 0.25) * 4;
    }
    case "spline":
      return splineValue(n.spline, v);
    case "end_islands":
      return noises.endIslands.density(bx, bz);
  }
}
function evaluate(program, noises, bx, by, bz, out) {
  const v = out ?? new Float64Array(program.nodes.length);
  const nodes = program.nodes;
  for (let i = 0;i < nodes.length; i++)
    v[i] = evalNode(nodes[i], v, noises, bx, by, bz);
  return v;
}

// src/core/generator.ts
class DimensionModel {
  bundle;
  dimension;
  program;
  roots;
  legacy;
  index;
  biomes;
  constructor(bundle, dimension) {
    this.bundle = bundle;
    this.dimension = dimension;
    const settings = bundle.noise_settings[dimension.settings];
    this.legacy = settings.legacy_random_source;
    this.program = new DensityProgram(bundle);
    this.roots = CLIMATE_FIELDS.map((f) => this.program.compile(settings.noise_router[f], `${dimension.settings}.noise_router.${f}`));
    if (dimension.source.type === "multi_noise") {
      this.index = buildClimateIndex(bundle.biome_parameters[dimension.source.parameters]);
      this.biomes = this.index.biomes;
    } else {
      this.index = null;
      this.biomes = ["minecraft:the_end", "minecraft:end_highlands", "minecraft:end_midlands", "minecraft:small_end_islands", "minecraft:end_barrens"];
    }
  }
  static fromBundle(json, dimension) {
    const bundle = validateBundle(json);
    const dim = bundle.dimensions[dimension];
    if (!dim)
      throw new Error(`bundle has no dimension "${dimension}"`);
    return new DimensionModel(bundle, dim);
  }
}

class BiomeGenerator {
  model;
  seed;
  noises;
  scratch;
  target = new Float64Array(7);
  constructor(model, seed) {
    this.model = model;
    this.seed = seed;
    this.noises = new NoiseSet(model.bundle, model.program.noises, seed, model.legacy);
    this.scratch = new Float64Array(model.program.nodes.length);
  }
  climate(qx, qy, qz) {
    const v = evaluate(this.model.program, this.noises, qx * 4, qy * 4, qz * 4, this.scratch);
    const t = this.target;
    for (let i = 0;i < 6; i++)
      t[i] = quantize(v[this.model.roots[i]]);
    t[6] = 0;
    return t;
  }
  entry(qx, qy, qz, candidate = -1) {
    return searchClimate(this.model.index, this.climate(qx, qy, qz), candidate);
  }
  biome(qx, qy, qz) {
    const idx = this.model.index;
    if (idx)
      return idx.entryBiome[this.entry(qx, qy, qz)];
    const erosionRoot = this.model.roots[3];
    const name = endBiome(qx, qz, (bx, bz) => evaluate(this.model.program, this.noises, bx, 0, bz, this.scratch)[erosionRoot]);
    return this.model.biomes.indexOf(name);
  }
}

// src/structures/bundle-random.ts
function saltedRandom(seed, x, z, salt) {
  return new LegacyRandom(seed + BigInt(x) * 341873128712n + BigInt(z) * 132897987541n + BigInt(salt));
}
function featureRandom(seed, x, z) {
  const random = new LegacyRandom(seed);
  const a = random.nextLong(), b = random.nextLong();
  return new LegacyRandom(BigInt(x) * a ^ BigInt(z) * b ^ seed);
}
function frequencyPass(seed, x, z, placement) {
  const f = Math.fround(placement.frequency);
  if (f >= 1)
    return true;
  switch (placement.frequencyReductionMethod) {
    case "legacy_type_1": {
      const random = new LegacyRandom(BigInt(x >> 4 ^ z >> 4 << 4) ^ seed);
      random.next(32);
      return random.nextInt(Math.min(2147483647, Math.trunc(Math.fround(1 / f)))) === 0;
    }
    case "legacy_type_2":
      return saltedRandom(seed, x, z, 10387320).next(24) / 2 ** 24 < f;
    case "legacy_type_3":
      return featureRandom(seed, x, z).nextDouble() < f;
    case "default":
      return saltedRandom(seed, placement.salt, x, z).next(24) / 2 ** 24 < f;
  }
}
function weightedOrder(seed, x, z, entries) {
  if (entries.length === 1)
    return [entries[0].structure];
  const random = featureRandom(seed, x, z);
  const remaining = entries.slice();
  const result = [];
  let total = remaining.reduce((sum, entry) => sum + entry.weight, 0);
  while (remaining.length) {
    let weight = random.nextInt(total);
    let index = 0;
    while ((weight -= remaining[index].weight) >= 0)
      index++;
    const entry = remaining[index];
    result.push(entry.structure);
    total -= entry.weight;
    remaining.splice(index, 1);
  }
  return result;
}

// src/structures/bundle-validate.ts
function record(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return value;
}
function integer2(value, name, min, max) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  return value;
}
function id(value, name) {
  if (typeof value !== "string" || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value))
    throw new TypeError(`${name} must be a namespaced registry ID`);
}
function ids(value, name) {
  if (!Array.isArray(value) || value.length > 65536)
    throw new TypeError(`${name} must be a bounded list of IDs`);
  for (const entry of value)
    id(entry, name);
}
function validateStructureBundle(value) {
  const b = record(value, "structure bundle");
  if (b.format !== "structure-bundle-1" || b.version !== "26.2")
    throw new TypeError("Expected a 26.2 structure-bundle-1 bundle");
  const biomeBundle = validateBundle(b.biomes);
  if (biomeBundle.version !== "26.2")
    throw new TypeError("Structure and biome bundle versions must both be 26.2");
  const structures = record(b.structures, "structures"), sets = record(b.sets, "sets"), presets = record(b.presets, "presets");
  if (!Object.keys(sets).length || Object.keys(sets).length > 4096 || Object.keys(structures).length > 65536)
    throw new RangeError("Structure bundle registry sizes are out of bounds");
  for (const [key, value] of Object.entries(structures)) {
    id(key, "structure key");
    const structure = record(value, key);
    if (structure.id !== key)
      throw new TypeError(`Mismatched structure ID ${key}`);
    id(structure.type, `${key}.type`);
    ids(structure.allowedBiomes, `${key}.allowedBiomes`);
  }
  for (const [key, value] of Object.entries(sets)) {
    id(key, "set key");
    const set = record(value, key), p = record(set.placement, `${key}.placement`);
    if (set.id !== key)
      throw new TypeError(`Mismatched set ID ${key}`);
    if (!Array.isArray(set.structures) || !set.structures.length || set.structures.length > 4096)
      throw new TypeError(`Invalid weighted entries for ${key}`);
    let weight = 0;
    for (const value of set.structures) {
      const entry = record(value, "weighted entry");
      id(entry.structure, "weighted structure");
      if (!Object.hasOwn(structures, entry.structure))
        throw new TypeError(`Missing structure ${entry.structure}`);
      weight += integer2(entry.weight, "weight", 1, 2147483647);
      if (weight > 2147483647)
        throw new RangeError("Total structure weight exceeds INT32_MAX");
    }
    integer2(p.salt, "salt", 0, 2147483647);
    if (typeof p.frequency !== "number" || !Number.isFinite(p.frequency) || p.frequency < 0 || p.frequency > 1)
      throw new RangeError("frequency must be in [0, 1]");
    if (!["default", "legacy_type_1", "legacy_type_2", "legacy_type_3"].includes(p.frequencyReductionMethod))
      throw new TypeError("Unknown frequency reduction method");
    if (!Array.isArray(p.locateOffset) || p.locateOffset.length !== 3)
      throw new TypeError("locateOffset must have three coordinates");
    for (const value of p.locateOffset)
      integer2(value, "locateOffset", -16, 16);
    if (p.type === "random_spread") {
      const spacing = integer2(p.spacing, "spacing", 1, 4096);
      integer2(p.separation, "separation", 0, spacing - 1);
      if (p.spreadType !== "linear" && p.spreadType !== "triangular")
        throw new TypeError("Unknown spreadType");
    } else if (p.type === "concentric_rings") {
      integer2(p.distance, "distance", 0, 1023);
      integer2(p.spread, "spread", 1, 1023);
      integer2(p.count, "count", 0, 4095);
      if (p.count > 128)
        throw new RangeError("This runtime supports at most 128 concentric ring positions");
      ids(p.preferredBiomes, "preferredBiomes");
    } else
      throw new TypeError("Unknown placement type");
    if (p.exclusionZone !== undefined) {
      const zone = record(p.exclusionZone, "exclusionZone");
      id(zone.otherSet, "otherSet");
      if (!Object.hasOwn(sets, zone.otherSet))
        throw new TypeError(`Missing exclusion set ${zone.otherSet}`);
      integer2(zone.chunkCount, "chunkCount", 1, 16);
    }
  }
  const visiting = new Set, visited = new Set;
  function visit(key) {
    if (visiting.has(key))
      throw new TypeError("Cyclic structure exclusion zones");
    if (visited.has(key))
      return;
    visiting.add(key);
    const next = sets[key].placement.exclusionZone?.otherSet;
    if (next)
      visit(next);
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of Object.keys(sets))
    visit(key);
  for (const [key, value] of Object.entries(presets)) {
    id(key, "preset");
    const dimensions = record(value, "preset dimensions");
    for (const [dimension, model] of Object.entries(dimensions)) {
      if (!["overworld", "nether", "end"].includes(dimension) || typeof model !== "string" || !Object.hasOwn(biomeBundle.dimensions, model))
        throw new TypeError(`Invalid preset dimension ${key}.${dimension}`);
    }
  }
  return value;
}

// src/structures/bundle-engine.ts
var BLOCK_LIMIT2 = 30000000;
var MAX_SCAN2 = 16384;

class BundleStructureEngine {
  seed;
  dimension;
  version = "26.2";
  preset;
  bundle;
  generator;
  possible;
  active = new Set;
  activeSets = new Set;
  ringStates = new Map;
  constructor(bundle, seed, dimension, preset) {
    this.seed = seed;
    this.dimension = dimension;
    this.bundle = bundle;
    this.preset = preset;
    const modelKey = bundle.presets[preset]?.[dimension];
    if (!modelKey)
      throw new RangeError(`Bundle does not support ${dimension} in preset ${preset}`);
    const model = DimensionModel.fromBundle(bundle.biomes, modelKey);
    this.generator = new BiomeGenerator(model, seed);
    this.possible = new Set(model.biomes);
    for (const structure of Object.values(bundle.structures)) {
      if (structure.allowedBiomes.some((biome) => this.possible.has(biome)))
        this.active.add(structure.id);
    }
    for (const set of Object.values(bundle.sets)) {
      if (set.structures.some((entry) => this.active.has(entry.structure)))
        this.activeSets.add(set.id);
    }
  }
  static async create(input, seed, dimension = "overworld", preset = "normal") {
    if (typeof seed !== "bigint" || seed < -(1n << 63n) || seed >= 1n << 63n)
      throw new RangeError("seed must be a signed 64-bit bigint");
    if (!["overworld", "nether", "end"].includes(dimension))
      throw new TypeError("Unknown structure dimension");
    if (typeof preset !== "string")
      throw new TypeError("preset must be a registry ID");
    const bundle = structuredClone(validateStructureBundle(input));
    return new BundleStructureEngine(bundle, seed, dimension, qualify(preset));
  }
  execute(request) {
    const bundle = this.requireBundle();
    if (!request || typeof request !== "object")
      throw new TypeError("Expected a bundle structure request");
    let response;
    switch (request.op) {
      case "catalog":
        response = this.catalog();
        break;
      case "position": {
        const set = this.randomSpreadSet(request.set);
        const x = this.region(request.regionX, "regionX", set.placement);
        const z = this.region(request.regionZ, "regionZ", set.placement);
        response = { op: "position", set: set.id, candidate: this.candidate(set, x, z) };
        break;
      }
      case "scan": {
        const set = this.randomSpreadSet(request.set);
        const width = integer2(request.width, "width", 1, MAX_SCAN2), height = integer2(request.height, "height", 1, MAX_SCAN2);
        if (width * height > MAX_SCAN2)
          throw new RangeError(`scan area must not exceed ${MAX_SCAN2} regions`);
        const x = this.region(request.regionX, "regionX", set.placement, width);
        const z = this.region(request.regionZ, "regionZ", set.placement, height);
        const candidates = [];
        for (let dz = 0;dz < height; dz++)
          for (let dx = 0;dx < width; dx++)
            candidates.push(this.candidate(set, x + dx, z + dz));
        response = { op: "scan", set: set.id, regionX: x, regionZ: z, width, height, candidates };
        break;
      }
      case "rings": {
        const set = this.set(request.set ?? "minecraft:strongholds");
        if (set.placement.type !== "concentric_rings")
          throw new TypeError(`${set.id} is not a concentric-rings set`);
        const dimensionPass = this.setActive(set);
        const total = dimensionPass ? set.placement.count : 0;
        const offset = request.offset === undefined ? 0 : integer2(request.offset, "offset", 0, total);
        const count = request.count === undefined ? total - offset : integer2(request.count, "count", 0, total - offset);
        const positions = count ? this.rings(set, offset + count).slice(offset, offset + count).map((position) => ({ ...position })) : [];
        response = { op: "rings", set: set.id, total, offset, positions, adjustment: "preferred-biome", dimensionPass };
        break;
      }
      case "biome": {
        if (typeof request.structure !== "string")
          throw new TypeError("structure must be a registry ID");
        const id = qualify(request.structure), structure = bundle.structures[id];
        if (!structure)
          throw new RangeError(`Unknown structure ${id}`);
        const qx = integer2(request.qx, "qx", -7500000, 7500000);
        const qy = integer2(request.qy, "qy", -512, 512);
        const qz = integer2(request.qz, "qz", -7500000, 7500000);
        const generator = this.generator;
        const biome = generator.model.biomes[generator.biome(qx, qy, qz)];
        response = { op: "biome", structure: id, qx, qy, qz, biome, eligible: structure.allowedBiomes.includes(biome), dimensionPass: this.active.has(id), scope: "explicit-quart-point-not-generation-start" };
        break;
      }
      default:
        throw new TypeError("Unknown bundle structure operation");
    }
    return response;
  }
  destroy() {
    this.bundle = undefined;
    this.generator = undefined;
    this.active.clear();
    this.activeSets.clear();
    this.possible.clear();
    this.ringStates.clear();
  }
  requireBundle() {
    if (!this.bundle)
      throw new Error("Bundle structure engine has been destroyed");
    return this.bundle;
  }
  set(id) {
    if (typeof id !== "string")
      throw new TypeError("set must be a registry ID");
    const set = this.requireBundle().sets[qualify(id)];
    if (!set)
      throw new RangeError(`Unknown structure set ${id}`);
    return set;
  }
  randomSpreadSet(id) {
    const set = this.set(id);
    if (set.placement.type !== "random_spread")
      throw new TypeError(`${set.id} uses concentric rings; use the rings operation`);
    return set;
  }
  setActive(set) {
    return this.activeSets.has(set.id);
  }
  region(value, name, placement, extent = 1) {
    const region = integer2(value, name, -BLOCK_LIMIT2, BLOCK_LIMIT2);
    const span = placement.spacing * 16;
    if (region * span < -BLOCK_LIMIT2 || (region + extent) * span - 1 > BLOCK_LIMIT2)
      throw new RangeError(`${name} region bounds exceed the supported block-coordinate range`);
    return region;
  }
  position(placement, chunkX, chunkZ) {
    const blockX = chunkX * 16, blockZ = chunkZ * 16;
    return { chunkX, chunkZ, blockX, blockZ, locateX: blockX + placement.locateOffset[0], locateY: placement.locateOffset[1], locateZ: blockZ + placement.locateOffset[2] };
  }
  potential(p, regionX, regionZ) {
    const random = saltedRandom(this.seed, regionX, regionZ, p.salt);
    const bound = p.spacing - p.separation;
    let x = random.nextInt(bound);
    let z;
    if (p.spreadType === "triangular") {
      x = Math.trunc((x + random.nextInt(bound)) / 2);
      z = Math.trunc((random.nextInt(bound) + random.nextInt(bound)) / 2);
    } else
      z = random.nextInt(bound);
    return this.position(p, regionX * p.spacing + x, regionZ * p.spacing + z);
  }
  candidate(set, regionX, regionZ) {
    const position = this.potential(set.placement, regionX, regionZ);
    const dimensionPass = this.setActive(set);
    const frequency = frequencyPass(this.seed, position.chunkX, position.chunkZ, set.placement);
    const exclusion = frequency && dimensionPass ? !this.excluded(set, position.chunkX, position.chunkZ) : null;
    const placementPass = dimensionPass && frequency && exclusion === true;
    return {
      ...position,
      regionX,
      regionZ,
      initialCandidatePass: true,
      frequencyPass: frequency,
      exclusionPass: exclusion,
      dimensionPass,
      placementPass,
      attemptOrder: placementPass ? weightedOrder(this.seed, position.chunkX, position.chunkZ, set.structures) : []
    };
  }
  placementPass(set, x, z) {
    if (!this.setActive(set))
      return false;
    const p = set.placement;
    if (p.type === "random_spread") {
      const candidate = this.potential(p, Math.floor(x / p.spacing), Math.floor(z / p.spacing));
      if (candidate.chunkX !== x || candidate.chunkZ !== z)
        return false;
    } else if (!this.rings(set, p.count).some((position) => position.chunkX === x && position.chunkZ === z))
      return false;
    return frequencyPass(this.seed, x, z, p) && !this.excluded(set, x, z);
  }
  excluded(set, x, z) {
    const zone = set.placement.exclusionZone;
    if (!zone)
      return false;
    const other = this.set(zone.otherSet);
    if (!this.setActive(other))
      return false;
    const radius = zone.chunkCount, p = other.placement;
    if (p.type === "random_spread") {
      for (let rz = Math.floor((z - radius) / p.spacing);rz <= Math.floor((z + radius) / p.spacing); rz++) {
        for (let rx = Math.floor((x - radius) / p.spacing);rx <= Math.floor((x + radius) / p.spacing); rx++) {
          const position = this.potential(p, rx, rz);
          if (Math.abs(position.chunkX - x) <= radius && Math.abs(position.chunkZ - z) <= radius && this.placementPass(other, position.chunkX, position.chunkZ))
            return true;
        }
      }
    } else {
      for (const position of this.rings(other, p.count)) {
        if (Math.abs(position.chunkX - x) <= radius && Math.abs(position.chunkZ - z) <= radius && this.placementPass(other, position.chunkX, position.chunkZ))
          return true;
      }
    }
    return false;
  }
  rings(set, count) {
    const p = set.placement;
    let state = this.ringStates.get(set.id);
    if (!state) {
      const random = new LegacyRandom(this.seed);
      state = { random, angle: random.nextDouble() * Math.PI * 2, ring: 0, within: 0, spread: p.spread, positions: [], preferred: new Set(p.preferredBiomes) };
      this.ringStates.set(set.id, state);
    }
    const generator = this.generator, model = generator.model;
    while (state.positions.length < count) {
      const index = state.positions.length;
      const distance = 4 * p.distance + p.distance * state.ring * 6 + (state.random.nextDouble() - 0.5) * p.distance * 2.5;
      let x = Math.floor(Math.cos(state.angle) * distance + 0.5), z = Math.floor(Math.sin(state.angle) * distance + 0.5);
      const random = new LegacyRandom(state.random.nextLong());
      const centerX = x * 4 + 2, centerZ = z * 4 + 2;
      let matches = 0, entry = -1;
      for (let qz = centerZ - 28;qz <= centerZ + 28; qz++) {
        for (let qx = centerX - 28;qx <= centerX + 28; qx++) {
          let biome;
          if (model.index) {
            entry = generator.entry(qx, 0, qz, entry);
            biome = model.biomes[model.index.entryBiome[entry]];
          } else
            biome = model.biomes[generator.biome(qx, 0, qz)];
          if (state.preferred.has(biome) && (++matches === 1 || random.nextInt(matches) === 0)) {
            x = Math.floor(qx / 4);
            z = Math.floor(qz / 4);
          }
        }
      }
      state.positions.push(this.position(p, x, z));
      state.angle += 2 * Math.PI / state.spread;
      state.within++;
      if (state.within === state.spread) {
        state.ring++;
        state.within = 0;
        state.spread += Math.trunc(2 * state.spread / (state.ring + 1));
        state.spread = Math.min(state.spread, p.count - index);
        state.angle += state.random.nextDouble() * Math.PI * 2;
      }
    }
    return state.positions;
  }
  catalog() {
    const bundle = this.requireBundle();
    return {
      op: "catalog",
      version: this.version,
      dimension: this.dimension,
      preset: this.preset,
      capabilities: { randomSpread: true, frequency: true, exclusion: true, weightedAttemptOrder: true, pointBiomeEligibility: true, concentricRings: "preferred-biome-adjusted", generationStarts: false, terrain: false, pieces: false },
      sets: Object.values(bundle.sets).map((set) => ({ ...structuredClone(set), activeStructures: set.structures.filter((entry) => this.active.has(entry.structure)).map((entry) => ({ ...entry })) })),
      structures: Object.values(bundle.structures).map((structure) => ({ ...structuredClone(structure), active: this.active.has(structure.id) }))
    };
  }
}

// src/structures/worker.ts
var engine;
var bundleEngine;
var initializing = false;
async function dispatch(message) {
  try {
    if (message.kind === "initialize") {
      if (engine || bundleEngine || initializing)
        throw new Error("Structure worker is already initialized");
      initializing = true;
      let input;
      if (typeof message.wasm === "string") {
        const response = await fetch(message.wasm);
        if (!response.ok)
          throw new Error(`Loading structure WASM failed: HTTP ${response.status}`);
        input = await response.arrayBuffer();
      } else {
        input = message.wasm;
      }
      const created = await StructureEngine.create(input);
      try {
        created.setWorld(message.world.mc, message.world.seed, message.world.largeBiomes);
      } catch (error) {
        created.destroy();
        throw error;
      }
      engine = created;
      postMessage({ id: message.id, ok: true, kind: "initialized" });
    } else if (message.kind === "initializeBundle") {
      if (engine || bundleEngine || initializing)
        throw new Error("Structure worker is already initialized");
      initializing = true;
      let data = message.bundle;
      if (typeof message.bundle === "string") {
        const response = await fetch(message.bundle);
        if (!response.ok)
          throw new Error(`Loading structure bundle failed: HTTP ${response.status}`);
        data = await response.json();
      }
      const created = await BundleStructureEngine.create(data, message.world.seed, message.world.dimension, message.world.preset);
      bundleEngine = created;
      postMessage({ id: message.id, ok: true, kind: "bundleInitialized", version: created.version });
    } else if (message.kind === "execute") {
      if (!engine)
        throw new Error("Structure worker is not initialized");
      const result = engine.execute(message.request);
      postMessage({ id: message.id, ok: true, kind: "result", result });
    } else if (message.kind === "executeBundle") {
      if (!bundleEngine)
        throw new Error("Structure bundle worker is not initialized");
      const result = bundleEngine.execute(message.request);
      postMessage({ id: message.id, ok: true, kind: "bundleResult", result });
    } else {
      throw new TypeError("Unknown structure worker message");
    }
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    const fatal = error instanceof WebAssembly.RuntimeError;
    if (fatal) {
      engine = undefined;
      bundleEngine = undefined;
    }
    postMessage({ id: message.id, ok: false, name: e.name, message: e.message, fatal });
  } finally {
    if (message.kind === "initialize" || message.kind === "initializeBundle")
      initializing = false;
  }
}
globalThis.onmessage = (event) => {
  dispatch(event.data);
};
