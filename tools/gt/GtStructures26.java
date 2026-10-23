// Independent oracle: invokes the local official runtime's public APIs only.
// Numeric results belong in ignored gt-out, never redistribute the server jar.
import java.nio.file.*;
import java.util.*;
import java.util.function.Predicate;
import java.util.stream.Stream;
import com.google.gson.*;
import com.mojang.serialization.JsonOps;
import net.minecraft.SharedConstants;
import net.minecraft.core.*;
import net.minecraft.core.registries.Registries;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.*;
import net.minecraft.server.Bootstrap;
import net.minecraft.server.packs.PackType;
import net.minecraft.server.packs.repository.ServerPacksSource;
import net.minecraft.server.packs.resources.MultiPackResourceManager;
import net.minecraft.tags.TagLoader;
import net.minecraft.world.level.*;
import net.minecraft.world.level.biome.*;
import net.minecraft.world.level.chunk.*;
import net.minecraft.world.level.dimension.LevelStem;
import net.minecraft.world.level.levelgen.*;
import net.minecraft.world.level.levelgen.presets.WorldPreset;
import net.minecraft.world.level.levelgen.structure.*;
import net.minecraft.world.level.levelgen.structure.placement.*;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplateManager;

public class GtStructures26 {
    static final Gson JSON = new GsonBuilder().setPrettyPrinting().serializeNulls().create();
    static HolderLookup.Provider registries;
    static RegistryAccess access;
    static PalettedContainerFactory containers;
    static final Map<String, World> worlds = new HashMap<>();
    static <T> ResourceKey<T> key(ResourceKey<? extends Registry<T>> registry, String name) {
        return ResourceKey.create(registry, Identifier.parse(name.contains(":") ? name : "minecraft:" + name));
    }
    static String id(Holder<?> holder) { return holder.unwrapKey().orElseThrow().identifier().toString(); }
    static JsonObject obj(Object... fields) {
        JsonObject o = new JsonObject();
        for (int i = 0; i < fields.length; i += 2) o.add((String) fields[i], JSON.toJsonTree(fields[i + 1]));
        return o;
    }
    static class World {
        final long seed;
        final String dimension, preset;
        final ChunkGenerator generator;
        final BiomeSource biomes;
        final RandomState random;
        final ChunkGeneratorStructureState state;
        final LevelHeightAccessor height;
        final ResourceKey<Level> level;
        World(JsonObject spec) {
            seed = Long.parseLong(spec.get("seed").getAsString());
            dimension = spec.get("dimension").getAsString();
            preset = spec.has("preset") ? spec.get("preset").getAsString() : "normal";
            String presetId = preset.equals("overworld") ? "normal" : preset;
            WorldPreset wp = registries.lookupOrThrow(Registries.WORLD_PRESET).getOrThrow(key(Registries.WORLD_PRESET, presetId)).value();
            ResourceKey<LevelStem> stemKey = dimension.equals("nether") ? LevelStem.NETHER : dimension.equals("end") ? LevelStem.END : LevelStem.OVERWORLD;
            LevelStem stem = wp.createWorldDimensions().get(stemKey).orElseThrow();
            generator = stem.generator();
            biomes = generator.getBiomeSource();
            random = RandomState.create(((NoiseBasedChunkGenerator) generator).generatorSettings().value(), registries.lookupOrThrow(Registries.NOISE), seed);
            state = generator.createState(registries.lookupOrThrow(Registries.STRUCTURE_SET), random, seed);
            height = LevelHeightAccessor.create(generator.getMinY(), generator.getGenDepth());
            level = key(Registries.DIMENSION, dimension.equals("end") ? "the_end" : dimension.equals("nether") ? "the_nether" : "overworld");
        }
        boolean active(Structure structure) { return structure.biomes().stream().anyMatch(biomes.possibleBiomes()::contains); }
        boolean active(StructureSet set) { return set.structures().stream().anyMatch(e -> active(e.structure().value())); }
    }
    // Observer structures intentionally fail: the official generator, not this harness,
    // chooses every attempted entry. This isolates weighted retry order from terrain.
    static class AttemptObserver extends Structure {
        final String name;
        final List<String> trace;
        AttemptObserver(Structure original, String name, List<String> trace) {
            super(new StructureSettings(original.biomes(), original.spawnOverrides(), original.step(), original.terrainAdaptation()));
            this.name = name; this.trace = trace;
        }
        public StructureStart generate(Holder<Structure> self, ResourceKey<Level> dimension, RegistryAccess access, ChunkGenerator generator, BiomeSource biomes, RandomState state, StructureTemplateManager templates, long seed, ChunkPos chunk, int references, LevelHeightAccessor height, Predicate<Holder<Biome>> predicate) {
            trace.add(name);
            return StructureStart.INVALID_START;
        }
        protected Optional<GenerationStub> findGenerationPoint(GenerationContext context) { throw new AssertionError("observer generate must intercept"); }
        public StructureType<?> type() { return StructureType.BURIED_TREASURE; }
    }
    static class ObserverManager extends StructureManager {
        ObserverManager(long seed) { super(null, new WorldOptions(seed, true, false), null); }
        public StructureStart getStartForStructure(SectionPos pos, Structure structure, StructureAccess chunk) { return null; }
    }
    static List<String> attemptOrder(World world, StructureSet original, ChunkPos chunk) {
        List<String> trace = new ArrayList<>();
        List<StructureSet.StructureSelectionEntry> entries = new ArrayList<>();
        for (var e : original.structures()) entries.add(StructureSet.entry(Holder.direct(new AttemptObserver(e.structure().value(), id(e.structure()), trace)), e.weight()));
        // A guaranteed placement isolates selection even when the original gate fails.
        StructureSet observed = new StructureSet(entries, new RandomSpreadStructurePlacement(1, 0, RandomSpreadType.LINEAR, 0));
        var state = ChunkGeneratorStructureState.createForFlat(world.random, world.seed, world.biomes, Stream.of(Holder.direct(observed)));
        var proto = new ProtoChunk(chunk, UpgradeData.EMPTY, world.height, containers, null);
        world.generator.createStructures(access, state, new ObserverManager(world.seed), proto, null, world.level);
        return trace;
    }
    static JsonObject position(StructurePlacement placement, ChunkPos chunk) {
        var locate = placement.getLocatePos(chunk);
        return obj("chunkX", chunk.x(), "chunkZ", chunk.z(), "blockX", chunk.getMinBlockX(), "blockZ", chunk.getMinBlockZ(), "locateX", locate.getX(), "locateY", locate.getY(), "locateZ", locate.getZ());
    }
    static JsonObject candidate(World world, StructureSet set, int regionX, int regionZ) {
        var placement = (RandomSpreadStructurePlacement) set.placement();
        var chunk = placement.getPotentialStructureChunk(world.seed, Math.multiplyExact(regionX, placement.spacing()), Math.multiplyExact(regionZ, placement.spacing()));
        boolean frequency = placement.applyAdditionalChunkRestrictions(chunk.x(), chunk.z(), world.seed);
        boolean dimension = world.active(set);
        Boolean exclusion = frequency && dimension ? placement.applyInteractionsWithOtherStructures(world.state, chunk.x(), chunk.z()) : null;
        JsonObject result = position(placement, chunk);
        result.addProperty("regionX", regionX); result.addProperty("regionZ", regionZ);
        result.addProperty("initialCandidatePass", true); result.addProperty("frequencyPass", frequency);
        result.add("exclusionPass", JSON.toJsonTree(exclusion)); result.addProperty("dimensionPass", dimension);
        boolean pass = dimension && placement.isStructureChunk(world.state, chunk.x(), chunk.z());
        result.addProperty("placementPass", pass);
        result.add("attemptOrder", JSON.toJsonTree(pass ? attemptOrder(world, set, chunk) : List.of()));
        return result;
    }
    static JsonObject catalog(World world) {
        List<JsonObject> sets = new ArrayList<>(), structures = new ArrayList<>();
        for (var holder : registries.lookupOrThrow(Registries.STRUCTURE_SET).listElements().sorted(Comparator.comparing(GtStructures26::id)).toList()) {
            StructureSet set = holder.value();
            StructurePlacement placement = set.placement();
            JsonObject encoded = StructurePlacement.CODEC.encodeStart(registries.createSerializationContext(JsonOps.INSTANCE), placement).getOrThrow().getAsJsonObject();
            BlockPos offset = placement.getLocatePos(new ChunkPos(0, 0));
            JsonObject normalized = obj("salt", encoded.has("salt") ? encoded.get("salt").getAsInt() : 0, "locateOffset", List.of(offset.getX(), offset.getY(), offset.getZ()), "frequency", encoded.has("frequency") ? encoded.get("frequency").getAsFloat() : 1.0f, "frequencyReductionMethod", encoded.has("frequency_reduction_method") ? encoded.get("frequency_reduction_method").getAsString() : "default");
            if (encoded.has("exclusion_zone")) {
                JsonObject exclusion = encoded.getAsJsonObject("exclusion_zone");
                normalized.add("exclusionZone", obj("otherSet", exclusion.get("other_set").getAsString(), "chunkCount", exclusion.get("chunk_count").getAsInt()));
            }
            if (placement instanceof RandomSpreadStructurePlacement spread) {
                normalized.addProperty("type", "random_spread"); normalized.addProperty("spacing", spread.spacing()); normalized.addProperty("separation", spread.separation()); normalized.addProperty("spreadType", spread.spreadType().getSerializedName());
            } else {
                var rings = (ConcentricRingsStructurePlacement) placement;
                normalized.addProperty("type", "concentric_rings"); normalized.addProperty("distance", rings.distance()); normalized.addProperty("spread", rings.spread()); normalized.addProperty("count", rings.count());
                normalized.add("preferredBiomes", JSON.toJsonTree(rings.preferredBiomes().stream().map(GtStructures26::id).sorted().toList()));
            }
            List<JsonObject> entries = new ArrayList<>(), active = new ArrayList<>();
            for (var entry : set.structures()) {
                JsonObject value = obj("structure", id(entry.structure()), "weight", entry.weight());
                entries.add(value);
                if (world.active(entry.structure().value())) active.add(value);
            }
            sets.add(obj("id", id(holder), "placement", normalized, "structures", entries, "activeStructures", active));
        }
        for (var holder : registries.lookupOrThrow(Registries.STRUCTURE).listElements().sorted(Comparator.comparing(GtStructures26::id)).toList()) {
            Structure structure = holder.value();
            structures.add(obj("id", id(holder), "type", BuiltInRegistries.STRUCTURE_TYPE.getKey(structure.type()).toString(), "allowedBiomes", structure.biomes().stream().map(GtStructures26::id).sorted().toList(), "active", world.active(structure)));
        }
        String preset = world.preset.equals("overworld") ? "normal" : world.preset;
        if (!preset.contains(":")) preset = "minecraft:" + preset;
        return obj("op", "catalog", "version", "26.2", "dimension", world.dimension, "preset", preset,
            "capabilities", obj("randomSpread", true, "frequency", true, "exclusion", true, "weightedAttemptOrder", true, "pointBiomeEligibility", true, "concentricRings", "preferred-biome-adjusted", "generationStarts", false, "terrain", false, "pieces", false),
            "sets", sets, "structures", structures);
    }
    static JsonObject execute(World world, JsonObject request) {
        String op = request.get("op").getAsString();
        if (op.equals("catalog")) return catalog(world);
        if (op.equals("biome")) {
            String name = request.get("structure").getAsString();
            Structure structure = registries.lookupOrThrow(Registries.STRUCTURE).getOrThrow(key(Registries.STRUCTURE, name)).value();
            int x = request.get("qx").getAsInt(), y = request.get("qy").getAsInt(), z = request.get("qz").getAsInt();
            Holder<Biome> sampled = world.biomes.getNoiseBiome(x, y, z, world.random.sampler());
            return obj("op", op, "structure", name, "qx", x, "qy", y, "qz", z, "biome", id(sampled), "eligible", structure.biomes().contains(sampled), "dimensionPass", world.active(structure), "scope", "explicit-quart-point-not-generation-start");
        }
        String name = request.has("set") ? request.get("set").getAsString() : "minecraft:strongholds";
        StructureSet set = registries.lookupOrThrow(Registries.STRUCTURE_SET).getOrThrow(key(Registries.STRUCTURE_SET, name)).value();
        if (op.equals("position")) return obj("op", op, "set", name, "candidate", candidate(world, set, request.get("regionX").getAsInt(), request.get("regionZ").getAsInt()));
        if (op.equals("scan")) {
            int x = request.get("regionX").getAsInt(), z = request.get("regionZ").getAsInt(), w = request.get("width").getAsInt(), h = request.get("height").getAsInt();
            List<JsonObject> candidates = new ArrayList<>();
            for (int j = 0; j < h; j++) for (int i = 0; i < w; i++) candidates.add(candidate(world, set, x + i, z + j));
            return obj("op", op, "set", name, "regionX", x, "regionZ", z, "width", w, "height", h, "candidates", candidates);
        }
        if (op.equals("rings")) {
            var placement = (ConcentricRingsStructurePlacement) set.placement();
            List<ChunkPos> ring = world.state.getRingPositionsFor(placement);
            int offset = request.has("offset") ? request.get("offset").getAsInt() : 0;
            int count = request.has("count") ? request.get("count").getAsInt() : placement.count() - offset;
            List<JsonObject> positions = new ArrayList<>();
            if (ring != null) for (int i = offset; i < Math.min(ring.size(), offset + count); i++) positions.add(position(placement, ring.get(i)));
            return obj("op", op, "set", name, "total", ring == null ? 0 : ring.size(), "offset", offset, "positions", positions, "adjustment", "preferred-biome", "dimensionPass", world.active(set));
        }
        throw new IllegalArgumentException("unsupported oracle operation " + op);
    }
    static JsonArray reducerProbe() {
        JsonArray probes = new JsonArray();
        for (var method : StructurePlacement.FrequencyReductionMethod.values()) for (float frequency : new float[]{0.004f, 0.01f, 0.2f, 0.37f, 0.8f, 1.0f}) {
            var placement = new RandomSpreadStructurePlacement(Vec3i.ZERO, method, frequency, 1234567, Optional.empty(), 1, 0, RandomSpreadType.LINEAR);
            for (long seed : new long[]{0, -1, 12345, Long.MIN_VALUE, Long.MAX_VALUE}) {
                World world = world(obj("seed", Long.toString(seed), "dimension", "overworld"));
                for (int x : new int[]{-513,-17,-1,0,1,19,511}) for (int z : new int[]{-219,-1,0,1,73}) {
                    probes.add(obj("method", method.getSerializedName(), "seed", Long.toString(seed), "x", x, "z", z, "salt", 1234567, "frequency", frequency, "pass", placement.applyAdditionalChunkRestrictions(x, z, seed), "structureChunkPass", placement.isStructureChunk(world.state, x, z)));
                }
            }
        }
        return probes;
    }
    static JsonArray startProbe(JsonArray requests) {
        JsonArray results = new JsonArray();
        for (JsonElement item : requests) {
            JsonObject probe = item.getAsJsonObject();
            World world = world(probe.getAsJsonObject("world"));
            Holder<Structure> holder = registries.lookupOrThrow(Registries.STRUCTURE).getOrThrow(key(Registries.STRUCTURE, probe.get("structure").getAsString()));
            ChunkPos chunk = new ChunkPos(probe.get("chunkX").getAsInt(), probe.get("chunkZ").getAsInt());
            JsonObject result = probe.deepCopy();
            try {
                var start = holder.value().generate(holder, world.level, access, world.generator, world.biomes, world.random, null, world.seed, chunk, 0, world.height, holder.value().biomes()::contains);
                result.addProperty("valid", start.isValid()); result.addProperty("pieces", start.getPieces().size());
                if (start.isValid()) result.addProperty("bounds", start.getBoundingBox().toString());
            } catch (Exception error) { result.addProperty("error", error.toString()); }
            results.add(result);
        }
        return results;
    }
    static JsonArray searchStartRequests(JsonArray searches) {
        JsonArray requests = new JsonArray();
        for (JsonElement item : searches) {
            JsonObject search = item.getAsJsonObject();
            World world = world(search.getAsJsonObject("world"));
            StructureSet set = registries.lookupOrThrow(Registries.STRUCTURE_SET).getOrThrow(key(Registries.STRUCTURE_SET, search.get("set").getAsString())).value();
            var placement = (RandomSpreadStructurePlacement) set.placement();
            int radius = search.get("radius").getAsInt();
            for (int rz = -radius; rz <= radius; rz++) for (int rx = -radius; rx <= radius; rx++) {
                ChunkPos chunk = placement.getPotentialStructureChunk(world.seed, rx * placement.spacing(), rz * placement.spacing());
                if (!world.active(set) || !placement.isStructureChunk(world.state, chunk.x(), chunk.z())) continue;
                requests.add(obj("world", search.get("world"), "structure", search.get("structure"), "set", search.get("set"), "regionX", rx, "regionZ", rz, "chunkX", chunk.x(), "chunkZ", chunk.z(), "placementPass", true));
            }
        }
        return requests;
    }
    static World world(JsonObject spec) { return worlds.computeIfAbsent(spec.toString(), ignored -> new World(spec)); }
    public static void main(String[] args) throws Exception {
        SharedConstants.tryDetectVersion(); Bootstrap.bootStrap();
        var resources = new MultiPackResourceManager(PackType.SERVER_DATA, List.of(ServerPacksSource.createVanillaPackSource()));
        var builtIn = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY);
        var tags = TagLoader.loadTagsForExistingRegistries(resources, builtIn);
        var context = TagLoader.buildUpdatedLookups(builtIn, tags);
        var loaded = RegistryDataLoader.load(resources, context, RegistryDataLoader.WORLDGEN_REGISTRIES, Runnable::run).join();
        tags.forEach(Registry.PendingTags::apply);
        access = new RegistryAccess.ImmutableRegistryAccess(Stream.concat(builtIn.registries(), loaded.registries()));
        registries = access;
        containers = PalettedContainerFactory.create(access);
        JsonObject input = JsonParser.parseString(Files.readString(Path.of(args[0]))).getAsJsonObject();
        JsonArray fixtures = new JsonArray();
        for (JsonElement item : input.getAsJsonArray("cases")) {
            JsonObject fixture = item.getAsJsonObject().deepCopy();
            fixture.add("expected", execute(world(fixture.getAsJsonObject("world")), fixture.getAsJsonObject("request")));
            fixtures.add(fixture);
        }
        JsonObject output = obj("oracle", "official-26.2-public-api", "fixtures", fixtures);
        if (input.has("reducerProbes") && input.get("reducerProbes").getAsBoolean()) output.add("reducerProbes", reducerProbe());
        if (input.has("starts")) output.add("starts", startProbe(input.getAsJsonArray("starts")));
        if (input.has("searchStarts")) output.add("placementStarts", startProbe(searchStartRequests(input.getAsJsonArray("searchStarts"))));
        Files.writeString(Path.of(args[1]), JSON.toJson(output));
        System.err.println("Official API fixtures: " + fixtures.size() + "; worlds: " + worlds.size());
    }
}
