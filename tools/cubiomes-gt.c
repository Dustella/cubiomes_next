// Ground-truth sampler built on cubiomes, for versions cubiomes supports
// (up to 1.21 Winter Drop) and whose server jars are obfuscated.
// Same output format as tools/gt/GtSample.java.
//
// Build: cc -O2 -fwrapv -I<cubiomes> tools/cubiomes-gt.c <cubiomes>/libcubiomes.a -lm -o gt-out/cubiomes-gt
// Usage: cubiomes-gt <overworld|large_biomes|nether> <seed> <x0> <z0> <w> <h> <step> <y> <out.bin>

#include "generator.h"
#include "util.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv)
{
    if (argc != 10) { fprintf(stderr, "bad args\n"); return 2; }
    const char *preset = argv[1];
    uint64_t seed = (uint64_t) strtoll(argv[2], NULL, 10);
    int x0 = atoi(argv[3]), z0 = atoi(argv[4]), w = atoi(argv[5]), h = atoi(argv[6]);
    int step = atoi(argv[7]), y = atoi(argv[8]);

    int dim = strcmp(preset, "nether") == 0 ? DIM_NETHER : DIM_OVERWORLD;
    uint32_t flags = strcmp(preset, "large_biomes") == 0 ? LARGE_BIOMES : 0;
    Generator g;
    setupGenerator(&g, MC_1_21_WD, flags);
    applySeed(&g, dim, seed);

    FILE *f = fopen(argv[9], "wb");
    int32_t n = w * h;
    fwrite(&n, 4, 1, f);
    int ids[256];
    int nids = 0;
    memset(ids, -1, sizeof(ids));
    const char *names[256];
    for (int j = 0; j < h; j++) {
        for (int i = 0; i < w; i++) {
            int qx = x0 + i * step, qz = z0 + j * step;
            int64_t np[6] = {0};
            int b;
            if (dim == DIM_OVERWORLD) {
                b = sampleBiomeNoise(&g.bn, np, qx, y, qz, NULL, 0);
            } else {
                b = getBiomeAt(&g, 4, qx, y, qz);
            }
            if (ids[b] < 0) { ids[b] = nids; names[nids++] = biome2str(MC_1_21_WD, b); }
            int32_t id = ids[b];
            fwrite(&id, 4, 1, f);
            fwrite(np, 8, 6, f);
        }
    }
    fclose(f);

    char path[4096];
    snprintf(path, sizeof(path), "%s.names", argv[9]);
    f = fopen(path, "w");
    for (int k = 0; k < nids; k++) fprintf(f, "%sminecraft:%s", k ? "\n" : "", names[k]);
    fclose(f);
    return 0;
}
