/* MIT Cubiomes bridge. ABI 1: scalar arguments in, owned JSON snapshot out.
 * sb_run(op,type,a,b,c,d,e,f,g,h): see engine.ts for argument mapping.
 * No native struct layouts or pointers cross the JS API. */
#include "finders.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>

static Generator generators[3];
static int ready[3], world_ready, world_mc, world_large;
static uint64_t world_seed;
static SurfaceNoise surface;
static int surface_ready;
static char *result;
static size_t result_len, result_cap;
static const char *error_text = "";
static Piece *pieces;
static int pieces_cap;
#define JSON_LIMIT (16u * 1024u * 1024u)
#define BOOL(x) ((x) ? "true" : "false")

static int fail(const char *message) { error_text = message; return -1; }
/* -2 denotes an explicit caller resource/range bound, not a runtime fault. */
static int range_error(const char *message) { error_text = message; return -2; }
static void emit(const char *fmt, ...)
{
    if (*error_text) return;
    if (!result_cap) {
        result = malloc(4096);
        if (!result) { fail("Allocating structure result failed"); return; }
        result_cap = 4096;
    }
    va_list ap, copy;
    va_start(ap, fmt);
    va_copy(copy, ap);
    int n = vsnprintf(result + result_len, result_cap - result_len, fmt, copy);
    va_end(copy);
    if (n < 0 || (size_t)n + result_len + 1 > JSON_LIMIT) {
        va_end(ap); fail("Structure result exceeds bounded output memory"); return;
    }
    size_t required = result_len + (size_t)n + 1;
    if (required > result_cap) {
        size_t cap = result_cap ? result_cap : 4096;
        while (cap < required) cap *= 2;
        if (cap > JSON_LIMIT) cap = JSON_LIMIT;
        char *p = realloc(result, cap);
        if (!p) { va_end(ap); fail("Allocating structure result failed"); return; }
        result = p; result_cap = cap;
        vsnprintf(result + result_len, result_cap - result_len, fmt, ap);
    }
    va_end(ap);
    result_len += (size_t)n;
}
static void pos(Pos p) { emit("{\"x\":%d,\"z\":%d}", p.x, p.z); }
static void pos3(Pos3 p) { emit("{\"x\":%d,\"y\":%d,\"z\":%d}", p.x, p.y, p.z); }
static void quoted(const char *s)
{
    emit("\"");
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') emit("\\%c", c);
        else if (c < 32) emit("\\u%04x", c);
        else emit("%c", c);
    }
    emit("\"");
}
static int dimension(int type)
{
    if (type == Ruined_Portal_N || type == Fortress || type == Bastion) return DIM_NETHER;
    if (type == End_City || type == End_Gateway || type == End_Island) return DIM_END;
    return DIM_OVERWORLD;
}
static Generator *generator(int dim)
{
    int i = dim + 1;
    if (!ready[i]) {
        setupGenerator(&generators[i], world_mc, world_large ? LARGE_BIOMES : 0);
        applySeed(&generators[i], dim, world_seed);
        ready[i] = 1;
    }
    return &generators[i];
}
static SurfaceNoise *end_surface(void)
{
    if (!surface_ready) {
        initSurfaceNoise(&surface, DIM_END, world_seed);
        surface_ready = 1;
    }
    return &surface;
}
static int supported(int type)
{
    StructureConfig config;
    return getStructureConfig(type, world_mc, &config) != 0;
}
static int biome_supported(int type) { return supported(type) && type != Feature && type != End_Island; }
static int feature_supported(int type) { return supported(type) && type != Feature && type != Geode && type != End_Island; }
static int variant_supported(int type)
{
    if (!supported(type)) return 0;
    switch (type) {
    case Village: return world_mc >= MC_1_10;
    case Desert_Pyramid: case Jungle_Temple: case Swamp_Hut: case Igloo:
    case Monument: case Ruined_Portal: case Ruined_Portal_N: case Ancient_City:
    case Bastion: case Geode: case Trial_Chambers: return 1;
    default: return 0;
    }
}
static int requires_biome(int type) { return type == Village || type == Ruined_Portal || type == Ruined_Portal_N; }
/* An unconditional upstream terrain return is not a surface-height calculation. */
static const char *terrain_mode(int type)
{
    if (!supported(type)) return "unsupported";
    if (type == End_City) return "end-surface";
    if (dimension(type) != DIM_OVERWORLD || type == Feature) return "unsupported";
    if (world_mc >= MC_1_18 && (type == Desert_Pyramid || type == Jungle_Temple || type == Mansion)) return "approximate";
    return "not-required";
}
static int terrain_raw(int type, int x, int z)
{
    if (type == End_City) return isViableEndCityTerrain(generator(DIM_END), end_surface(), x, z);
    return isViableStructureTerrain(type, generator(DIM_OVERWORLD), x, z);
}
static void check(int supported_check, int raw)
{
    if (supported_check) emit("{\"supported\":true,\"raw\":%d,\"viable\":%s}", raw, BOOL(raw != 0));
    else emit("{\"supported\":false,\"raw\":null,\"viable\":null}");
}
static void config_json(int type)
{
    StructureConfig c;
    int valid = getStructureConfig(type, world_mc, &c);
    emit("{\"type\":%d,\"supported\":%s,", type, BOOL(valid));
    if (valid) emit("\"salt\":%d,\"regionSize\":%d,\"chunkRange\":%d,\"rarity\":%.17g,", c.salt, c.regionSize, c.chunkRange, (double)c.rarity);
    else emit("\"salt\":null,\"regionSize\":null,\"chunkRange\":null,\"rarity\":null,");
    emit("\"dimension\":%d,\"biomeSupported\":%s,\"featureBiomeSupported\":%s,\"terrain\":\"%s\",\"variantSupported\":%s,\"variantRequiresBiome\":%s}",
        dimension(type), BOOL(biome_supported(type)), BOOL(feature_supported(type)), terrain_mode(type), BOOL(variant_supported(type)), BOOL(variant_supported(type) && requires_biome(type)));
}
static void known_fields(int type)
{
    const char *fields = "";
    switch (type) {
    case Village: fields = world_mc <= MC_1_13 ? "\"abandoned\"" : "\"abandoned\",\"biome\",\"start\",\"rotation\",\"x\",\"z\",\"sx\",\"sy\",\"sz\""; break;
    case Bastion: fields = "\"start\",\"rotation\",\"x\",\"z\",\"sx\",\"sy\",\"sz\""; break;
    case Ancient_City: case Trial_Chambers: fields = "\"start\",\"rotation\",\"x\",\"y\",\"z\",\"sx\",\"sy\",\"sz\""; break;
    case Ruined_Portal: case Ruined_Portal_N: fields = "\"biome\",\"underground\",\"airpocket\",\"giant\",\"start\",\"rotation\",\"mirror\""; break;
    case Monument: fields = "\"x\",\"z\",\"sx\",\"sz\""; break;
    case Igloo: fields = "\"basement\",\"size\",\"rotation\",\"mirror\",\"sx\",\"sy\",\"sz\""; break;
    case Desert_Pyramid: case Jungle_Temple: case Swamp_Hut: fields = world_mc <= MC_1_19 ? "\"sx\",\"sy\",\"sz\"" : "\"rotation\",\"mirror\",\"sx\",\"sy\",\"sz\""; break;
    case Geode: fields = "\"x\",\"y\",\"z\",\"size\",\"cracked\""; break;
    }
    emit("[%s]", fields);
}
static void variant_json(int type, StructureVariant *v)
{
    emit("{\"abandoned\":%s,\"giant\":%s,\"underground\":%s,\"airpocket\":%s,\"basement\":%s,\"cracked\":%s,\"size\":%u,\"start\":%u,\"biome\":%d,\"rotation\":%u,\"mirror\":%u,\"x\":%d,\"y\":%d,\"z\":%d,\"sx\":%d,\"sy\":%d,\"sz\":%d,\"knownFields\":",
        BOOL(v->abandoned), BOOL(v->giant), BOOL(v->underground), BOOL(v->airpocket), BOOL(v->basement), BOOL(v->cracked),
        v->size, v->start, v->biome, v->rotation, v->mirror, v->x, v->y, v->z, v->sx, v->sy, v->sz);
    known_fields(type); emit("}");
}
static int reserve_pieces(int capacity)
{
    if (pieces_cap >= capacity) return 0;
    Piece *p = realloc(pieces, (size_t)capacity * sizeof(*pieces));
    if (!p) return fail("Allocating structure pieces failed");
    pieces = p; pieces_cap = capacity; return 0;
}
int sb_abi(void) { return 1; }
const char *sb_result_ptr(void) { return result; }
size_t sb_result_len(void) { return result_len; }
const char *sb_error_ptr(void) { return error_text; }
int sb_set_world(int mc, uint32_t seed_lo, uint32_t seed_hi, int large)
{
    error_text = "";
    if (mc < MC_1_0 || mc > MC_NEWEST || (large != 0 && large != 1)) return fail("Invalid structure world");
    world_mc = mc; world_seed = (uint64_t)seed_hi << 32 | seed_lo; world_large = large;
    memset(ready, 0, sizeof(ready)); surface_ready = 0; world_ready = 1; return 0;
}
void sb_destroy(void)
{
    free(result); result = NULL; result_len = result_cap = 0;
    free(pieces); pieces = NULL; pieces_cap = 0;
    world_ready = 0; memset(ready, 0, sizeof(ready)); surface_ready = 0;
}
int sb_run(int op, int type, int a, int b, int c, int d, int e, int f, int g, int h)
{
    (void)h;
    error_text = ""; result_len = 0;
    if (!world_ready) return fail("Structure world is not initialized");
    if (type < 0 || type >= FEATURE_NUM) return fail("Unknown structure type");
    switch (op) {
    case 0:
        emit("{\"op\":\"catalog\",\"structures\":[");
        for (int i = 0; i < FEATURE_NUM; i++) { if (i) emit(","); config_json(i); }
        emit("]}"); break;
    case 1: {
        Pos p; int valid = supported(type);
        emit("{\"op\":\"position\",\"type\":%d,\"supported\":%s,\"position\":", type, BOOL(valid));
        if (valid && getStructurePos(type, world_mc, world_seed, a, b, &p)) pos(p); else emit("null");
        emit("}"); break;
    }
    case 2: {
        if (c < 1 || d < 1 || c > 16384 || d > 16384 || (int64_t)c*d > 16384 || e < 0 || e > 2) return fail("Invalid scan bounds or stage");
        const char *stages[] = {"placement", "biome", "terrain"};
        const char *mode = terrain_mode(type);
        emit("{\"op\":\"scan\",\"type\":%d,\"supported\":%s,\"stage\":\"%s\",\"terrainMode\":\"%s\",\"records\":[", type, BOOL(supported(type)), stages[e], mode);
        int comma = 0, bs = biome_supported(type), ts = strcmp(mode, "unsupported") != 0;
        if (supported(type)) for (int j = 0; j < d; j++) for (int i = 0; i < c; i++) {
            Pos p;
            if (!getStructurePos(type, world_mc, world_seed, a+i, b+j, &p)) continue;
            int br = e && bs ? isViableStructurePos(type, generator(dimension(type)), p.x, p.z, (uint32_t)g) : 0;
            int tr = e == 2 && ts && br ? terrain_raw(type, p.x, p.z) : 0;
            int accepted = e == 0 ? 1 : !bs ? -1 : !br ? 0 : e == 1 ? 1 : !ts ? -1 : tr != 0;
            if (accepted != 1 && !f) continue;
            if (comma++) emit(",");
            emit("{\"regionX\":%d,\"regionZ\":%d,\"position\":", a+i, b+j); pos(p);
            emit(",\"biome\":"); if (e) check(bs, br); else emit("null");
            emit(",\"terrain\":"); if (e == 2 && bs && br) check(ts, tr); else emit("null");
            emit(",\"accepted\":%s}", accepted < 0 ? "null" : BOOL(accepted));
        }
        emit("]}"); break;
    }
    case 3: {
        int bs = biome_supported(type); const char *mode = terrain_mode(type);
        emit("{\"op\":\"check\",\"type\":%d,\"biome\":", type);
        check(bs, bs ? isViableStructurePos(type, generator(dimension(type)), a, b, (uint32_t)c) : 0);
        emit(",\"terrain\":");
        if (d) { int ts = strcmp(mode, "unsupported") != 0; check(ts, ts ? terrain_raw(type, a, b) : 0); } else emit("null");
        emit(",\"terrainMode\":\"%s\"}", mode); break;
    }
    case 4: {
        int fs = feature_supported(type);
        emit("{\"op\":\"featureBiome\",\"type\":%d,\"biome\":%d,\"check\":", type, a);
        check(fs, fs ? isViableFeatureBiome(world_mc, type, a) : 0); emit("}"); break;
    }
    case 5: {
        int vs = variant_supported(type); StructureVariant v;
        emit("{\"op\":\"variant\",\"type\":%d,\"supported\":%s,\"variant\":", type, BOOL(vs));
        if (vs && getVariant(&v, type, world_mc, world_seed, a, b, c)) variant_json(type, &v); else emit("null");
        emit("}"); break;
    }
    case 6: {
        int total = world_mc >= MC_1_9 ? 128 : 3;
        if (a < 0 || b < 0 || a > total || b > total-a) return fail("Stronghold range exceeds world total");
        StrongholdIter sh; Pos first = initFirstStronghold(&sh, world_mc, world_seed);
        emit("{\"op\":\"strongholds\",\"total\":%d,\"firstApprox\":", total); pos(first); emit(",\"records\":[");
        for (int i = 0; i < a+b; i++) {
            int ring = sh.ringnum;
            nextStronghold(&sh, generator(DIM_OVERWORLD));
            if (i < a) continue;
            if (i > a) emit(",");
            emit("{\"index\":%d,\"ring\":%d,\"position\":", i, ring); pos(sh.pos);
            emit(",\"nextApprox\":"); pos(sh.nextapprox); emit("}");
        }
        emit("]}"); break;
    }
    case 7: {
        if ((type != End_City && type != Fortress) || c < 1 || c > 16384) return fail("Invalid piece algorithm or bound");
        int valid = supported(type), count = 0;
        if (valid && type == End_City) {
            if (reserve_pieces(END_CITY_PIECES_MAX)) return -1;
            count = getEndCityPieces(pieces, world_seed, a, b);
            if (count > c) return range_error("Complete End City exceeds maxPieces");
        } else if (valid) {
            int capacity = c < 256 ? c : 256;
            for (;;) {
                if (reserve_pieces(capacity)) return -1;
                count = getFortressPieces(pieces, capacity, world_mc, world_seed, a, b);
                if (count < capacity) break;
                if (capacity == c) return range_error("Fortress completeness cannot be established within maxPieces");
                capacity = capacity > c/2 ? c : capacity*2;
            }
        }
        emit("{\"op\":\"pieces\",\"type\":%d,\"supported\":%s,\"pieces\":[", type, BOOL(valid));
        for (int i = 0; i < count; i++) {
            Piece *p = &pieces[i]; if (i) emit(",");
            emit("{\"name\":"); quoted(p->name); emit(",\"position\":"); pos3(p->pos);
            emit(",\"bb0\":"); pos3(p->bb0); emit(",\"bb1\":"); pos3(p->bb1);
            emit(",\"rotation\":%u,\"depth\":%d,\"type\":%d}", p->rot, p->depth, p->type);
        }
        emit("]}"); break;
    }
    case 8: {
        EndIsland islands[2]; int valid = world_mc >= MC_1_13;
        int n = valid ? getEndIslands(islands, world_mc, world_seed, a, b) : 0;
        emit("{\"op\":\"endIslands\",\"supported\":%s,\"islands\":[", BOOL(valid));
        for (int i = 0; i < n; i++) { if (i) emit(","); emit("{\"x\":%d,\"y\":%d,\"z\":%d,\"r\":%d}", islands[i].x, islands[i].y, islands[i].z, islands[i].r); }
        if (valid) { int id = getBiomeAt(generator(DIM_END), 16, a, 0, b); emit("],\"biome\":%d,\"biomeViable\":%s}", id, BOOL(id == small_end_islands)); }
        else emit("],\"biome\":null,\"biomeViable\":null}");
        break;
    }
    case 9: {
        int valid = world_mc >= MC_1_9; Pos positions[20];
        emit("{\"op\":\"fixedGateways\",\"supported\":%s,\"positions\":[", BOOL(valid));
        if (valid) { getFixedEndGateways(world_mc, world_seed, positions); for (int i = 0; i < 20; i++) { if (i) emit(","); pos(positions[i]); } }
        emit("]}"); break;
    }
    case 10: {
        if ((!a && !b) || (int64_t)a*a + (int64_t)b*b > INT32_MAX) return fail("Gateway source must be nonzero with squared radius within int32");
        int valid = world_mc >= MC_1_13;
        emit("{\"op\":\"linkedGateway\",\"supported\":%s,\"chunk\":", BOOL(valid));
        if (valid) {
            Pos src = {a,b}, search; Generator *eg = generator(DIM_END); SurfaceNoise *sn = end_surface();
            Pos chunk = getLinkedGatewayChunk(&eg->en, sn, world_seed, src, &search);
            Pos destination = getLinkedGatewayPos(&eg->en, sn, world_seed, src);
            pos(chunk); emit(",\"searchPosition\":"); pos(search); emit(",\"position\":"); pos(destination);
        } else emit("null,\"searchPosition\":null,\"position\":null");
        emit("}"); break;
    }
    case 11: {
        int valid = world_mc < MC_1_14, houses[HOUSE_NUM];
        emit("{\"op\":\"villageHouses\",\"supported\":%s,\"counts\":[", BOOL(valid));
        uint64_t rng = valid ? getHouseList(houses, world_seed, a, b) : 0;
        if (valid) for (int i = 0; i < HOUSE_NUM; i++) { if (i) emit(","); emit("%d", houses[i]); }
        if (valid) emit("],\"rngState\":\"%" PRIu64 "\"}", rng); else emit("],\"rngState\":null}");
        break;
    }
    case 12: {
        /* Earlier End releases lack supported small-island decoration in this baseline. */
        int valid = world_mc >= MC_1_13;
        emit("{\"op\":\"endChunkEmpty\",\"supported\":%s,\"empty\":", BOOL(valid));
        if (valid) emit("%s", BOOL(isEndChunkEmpty(&generator(DIM_END)->en, end_surface(), world_seed, a, b))); else emit("null");
        emit(",\"bounds\":{\"minX\":%d,\"minZ\":%d,\"maxX\":%d,\"maxZ\":%d}}", a*16, b*16, a*16+15, b*16+15); break;
    }
    default: return fail("Unknown structure operation");
    }
    return *error_text ? -1 : 0;
}
