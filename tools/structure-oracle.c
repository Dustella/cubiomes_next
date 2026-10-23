/* Independent native reference, intentionally does not include/link structures.c.
 * Usage: structure-oracle mc signedSeed large op type a b c d e f g h
 * --batch accepts one whitespace-separated argument line per query on stdin.
 * Emits native raw fields; structure-fixtures.ts independently maps public JSON.
 * Operations 0..12: catalog, position, scan, check, featureBiome, variant,
 * strongholds, pieces, endIslands, fixedGateways, linkedGateway, villageHouses,
 * endChunkEmpty. Compile against unmodified vendor/cubiomes with real libm.
 */
#include "finders.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <inttypes.h>
#include <string.h>
#include <errno.h>

static const char *boolean(int x) { return x ? "true" : "false"; }
static void p2(Pos p) { printf("{\"x\":%d,\"z\":%d}", p.x, p.z); }
static void p3(Pos3 p) { printf("{\"x\":%d,\"y\":%d,\"z\":%d}", p.x, p.y, p.z); }
static int dim_for(int type)
{
    return type == Fortress || type == Bastion || type == Ruined_Portal_N ? DIM_NETHER :
        type == End_City || type == End_Gateway || type == End_Island ? DIM_END : DIM_OVERWORLD;
}
static void nullable(int valid, int value) { if (valid) printf("%d", value); else printf("null"); }
static int query(int argc, char **argv)
{
    if (argc < 5 || argc > 13) { fprintf(stderr, "Expected mc seed large op type [a..h]\n"); return 1; }
    int64_t values[13] = {0};
    for (int i = 0; i < argc; i++) {
        char *end; errno = 0; values[i] = strtoll(argv[i], &end, 10);
        if (errno || !*argv[i] || *end) { fprintf(stderr, "Invalid integer argument\n"); return 1; }
    }
    int mc = (int)values[0], large = (int)values[2], op = (int)values[3], type = (int)values[4];
    if (mc < MC_1_0 || mc > MC_NEWEST || type < 0 || type >= FEATURE_NUM || (large != 0 && large != 1)) return 1;
    uint64_t seed = (uint64_t)values[1];
    int a = (int)values[5], b = (int)values[6], c = (int)values[7], d = (int)values[8];
    int e = (int)values[9], f = (int)values[10]; uint32_t flags = (uint32_t)values[11];
    (void)f;
    StructureConfig config;
    int supported = getStructureConfig(type, mc, &config) != 0;
    int bs = supported && type != Feature && type != End_Island;
    int fs = bs && type != Geode;
    int ts = supported && (dim_for(type) == DIM_OVERWORLD && type != Feature || type == End_City);
    Generator gen;
    setupGenerator(&gen, mc, large ? LARGE_BIOMES : 0);
    applySeed(&gen, dim_for(type), seed);
    SurfaceNoise sn;
    if (op == 8 || op == 9 || op == 10 || op == 12 || type == End_City) {
        if (gen.dim != DIM_END) applySeed(&gen, DIM_END, seed);
        initSurfaceNoise(&sn, DIM_END, seed);
    }
    switch (op) {
    case 0:
        printf("{\"configs\":[");
        for (int i = 0; i < FEATURE_NUM; i++) {
            StructureConfig sc; if (i) printf(",");
            if (!getStructureConfig(i, mc, &sc)) printf("null");
            else printf("{\"salt\":%d,\"regionSize\":%d,\"chunkRange\":%d,\"dimension\":%d,\"rarity\":%.17g}", sc.salt, sc.regionSize, sc.chunkRange, sc.dim, (double)sc.rarity);
        }
        printf("]}"); break;
    case 1: {
        Pos p; printf("{\"supported\":%s,\"position\":", boolean(supported));
        if (supported && getStructurePos(type, mc, seed, a, b, &p)) p2(p); else printf("null");
        printf("}"); break;
    }
    case 2: {
        if (c < 1 || d < 1 || (int64_t)c*d > 16384 || e < 0 || e > 2) return 1;
        printf("{\"supported\":%s,\"records\":[", boolean(supported)); int comma = 0;
        if (supported) for (int j = 0; j < d; j++) for (int i = 0; i < c; i++) {
            Pos p; if (!getStructurePos(type, mc, seed, a+i, b+j, &p)) continue;
            if (comma++) printf(",");
            printf("{\"regionX\":%d,\"regionZ\":%d,\"position\":", a+i, b+j); p2(p);
            int br = e && bs ? isViableStructurePos(type, &gen, p.x, p.z, flags) : 0;
            int tr = 0;
            if (e == 2 && ts && br) tr = type == End_City ? isViableEndCityTerrain(&gen, &sn, p.x, p.z) : isViableStructureTerrain(type, &gen, p.x, p.z);
            printf(",\"biome\":"); nullable(e && bs, br);
            printf(",\"terrain\":"); nullable(e == 2 && ts && br, tr); printf("}");
        }
        printf("]}"); break;
    }
    case 3:
        printf("{\"biome\":"); nullable(bs, bs ? isViableStructurePos(type, &gen, a, b, (uint32_t)c) : 0);
        printf(",\"terrain\":");
        nullable(d && ts, d && ts ? type == End_City ? isViableEndCityTerrain(&gen, &sn, a, b) : isViableStructureTerrain(type, &gen, a, b) : 0);
        printf("}"); break;
    case 4:
        printf("{\"raw\":"); nullable(fs, fs ? isViableFeatureBiome(mc, type, a) : 0); printf("}"); break;
    case 5: {
        StructureVariant v;
        int ok = supported && getVariant(&v, type, mc, seed, a, b, c);
        printf("{\"variant\":");
        if (!ok) printf("null");
        else printf("[%u,%u,%u,%u,%u,%u,%u,%u,%d,%u,%u,%d,%d,%d,%d,%d,%d]", v.abandoned,v.giant,v.underground,v.airpocket,v.basement,v.cracked,v.size,v.start,v.biome,v.rotation,v.mirror,v.x,v.y,v.z,v.sx,v.sy,v.sz);
        printf("}"); break;
    }
    case 6: {
        int total = mc >= MC_1_9 ? 128 : 3; if (a < 0 || b < 0 || a+b > total) return 1;
        StrongholdIter sh; Pos first = initFirstStronghold(&sh, mc, seed);
        printf("{\"total\":%d,\"firstApprox\":", total); p2(first); printf(",\"records\":[");
        for (int i = 0; i < a+b; i++) {
            int ring = sh.ringnum; nextStronghold(&sh, &gen); if (i < a) continue;
            if (i != a) printf(","); printf("{\"index\":%d,\"ring\":%d,\"position\":", i, ring); p2(sh.pos);
            printf(",\"nextApprox\":"); p2(sh.nextapprox); printf("}");
        }
        printf("]}"); break;
    }
    case 7: {
        if ((type != End_City && type != Fortress) || c < 1 || c > 16384) return 1;
        int capacity = type == End_City ? END_CITY_PIECES_MAX : c < 256 ? c : 256, count = 0;
        Piece *list = NULL;
        if (supported) for (;;) {
            Piece *p = realloc(list, (size_t)capacity * sizeof(*list)); if (!p) { free(list); return 1; } list = p;
            count = type == End_City ? getEndCityPieces(list, seed, a, b) : getFortressPieces(list, capacity, mc, seed, a, b);
            if (type == End_City) { if (count > c) { free(list); return 1; } break; }
            if (count < capacity) break;
            if (capacity == c) { fprintf(stderr,"Fortress exceeds complete piece bound\n"); free(list); return 1; }
            capacity = capacity > c/2 ? c : capacity*2;
        }
        printf("{\"supported\":%s,\"pieces\":[", boolean(supported));
        for (int i = 0; i < count; i++) {
            Piece *p = list+i; if (i) printf(","); printf("{\"name\":\"%s\",\"position\":", p->name); p3(p->pos);
            printf(",\"bb0\":"); p3(p->bb0); printf(",\"bb1\":"); p3(p->bb1);
            printf(",\"rotation\":%u,\"depth\":%d,\"type\":%d}",p->rot,p->depth,p->type);
        }
        printf("]}"); free(list); break;
    }
    case 8: {
        int valid = mc >= MC_1_13; EndIsland islands[2]; int n = valid ? getEndIslands(islands,mc,seed,a,b) : 0;
        printf("{\"supported\":%s,\"islands\":[", boolean(valid));
        for (int i = 0; i < n; i++) { if(i)printf(","); printf("{\"x\":%d,\"y\":%d,\"z\":%d,\"r\":%d}",islands[i].x,islands[i].y,islands[i].z,islands[i].r); }
        printf("],\"biome\":"); nullable(valid,valid ? getBiomeAt(&gen,16,a,0,b) : 0); printf("}"); break;
    }
    case 9: {
        int valid = mc >= MC_1_9; Pos points[20]; printf("{\"supported\":%s,\"positions\":[",boolean(valid));
        if(valid) { getFixedEndGateways(mc,seed,points); for(int i=0;i<20;i++){if(i)printf(",");p2(points[i]);} }
        printf("]}"); break;
    }
    case 10: {
        if ((!a && !b) || (int64_t)a*a + (int64_t)b*b > INT32_MAX) return 1;
        int valid=mc>=MC_1_13; printf("{\"supported\":%s,\"chunk\":",boolean(valid));
        if(valid) { Pos src={a,b},search; Pos chunk=getLinkedGatewayChunk(&gen.en,&sn,seed,src,&search); Pos point=getLinkedGatewayPos(&gen.en,&sn,seed,src);p2(chunk);printf(",\"searchPosition\":");p2(search);printf(",\"position\":");p2(point); }
        else printf("null,\"searchPosition\":null,\"position\":null"); printf("}"); break;
    }
    case 11: {
        int valid=mc<MC_1_14, houses[HOUSE_NUM]; uint64_t rng=valid?getHouseList(houses,seed,a,b):0;
        printf("{\"supported\":%s,\"counts\":[",boolean(valid)); if(valid)for(int i=0;i<HOUSE_NUM;i++){if(i)printf(",");printf("%d",houses[i]);}
        if(valid)printf("],\"rngState\":\"%" PRIu64 "\"}",rng);else printf("],\"rngState\":null}"); break;
    }
    case 12: {
        int valid=mc>=MC_1_13; printf("{\"supported\":%s,\"empty\":",boolean(valid)); if(valid)printf("%s",boolean(isEndChunkEmpty(&gen.en,&sn,seed,a,b)));else printf("null");
        printf(",\"bounds\":{\"minX\":%d,\"minZ\":%d,\"maxX\":%d,\"maxZ\":%d}}",a*16,b*16,a*16+15,b*16+15);break;
    }
    default: return 1;
    }
    putchar('\n'); return 0;
}
int main(int argc, char **argv)
{
    if (argc == 2 && !strcmp(argv[1], "--batch")) {
        char line[2048];
        while (fgets(line,sizeof(line),stdin)) {
            char *args[14]; int n=0; char *token=strtok(line," \t\r\n");
            while(token && n<14){args[n++]=token;token=strtok(NULL," \t\r\n");}
            if (n && query(n,args)) return 1;
        }
        return ferror(stdin) ? 1 : 0;
    }
    return query(argc-1,argv+1);
}
