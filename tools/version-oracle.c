// Independent executable oracle: calls unmodified MIT Cubiomes APIs.
// Arguments: mc dim seed x0 z0 w h step qy largeBiomes scale
// Emits row-major native little-endian int32 biome IDs, no game assets.
#include "generator.h"
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

static int number(const char *text, int *out) {
    char *end;
    errno = 0;
    long n = strtol(text, &end, 10);
    if (errno || !*text || *end || n < INT_MIN || n > INT_MAX) return 0;
    *out = (int)n;
    return 1;
}

int main(int argc, char **argv) {
    if (argc != 12) { fprintf(stderr, "expected mc dim seed x0 z0 w h step qy largeBiomes scale\n"); return 2; }
    int mc, dim, x0, z0, w, h, step, qy, large;
    if (!number(argv[1], &mc) || !number(argv[2], &dim) ||
        !number(argv[4], &x0) || !number(argv[5], &z0) ||
        !number(argv[6], &w) || !number(argv[7], &h) ||
        !number(argv[8], &step) || !number(argv[9], &qy) ||
        !number(argv[10], &large)) return 2;
    // Last argument is the scale; quart is used by the public preview API.
    int scale;
    if (!number(argv[11], &scale) || (scale != 1 && scale != 4)) return 2;
    if (mc < MC_1_0 || mc > MC_1_21_3 || dim < -1 || dim > 1 ||
        w <= 0 || h <= 0 || step <= 0) return 2;
    char *end;
    errno = 0;
    long long signedSeed = strtoll(argv[3], &end, 10);
    if (errno || !*argv[3] || *end) return 2;
    Generator g;
    setupGenerator(&g, mc, large ? LARGE_BIOMES : 0);
    applySeed(&g, dim, (uint64_t)signedSeed);
#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    for (int j = 0; j < h; j++) {
        for (int i = 0; i < w; i++) {
            int32_t id = getBiomeAt(&g, scale, x0 + i * step, qy, z0 + j * step);
            if (id < 0) { fprintf(stderr, "Cubiomes generation failed\n"); return 1; }
            if (fwrite(&id, sizeof id, 1, stdout) != 1) return 1;
        }
    }
    return fflush(stdout) ? 1 : 0;
}
