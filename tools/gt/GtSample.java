// Ground-truth sampler that calls the official server jar's public APIs.
// Lives under official_source/ (never tracked). Emits only numeric samples.
//
// Usage: java -cp <server classpath>:. GtSample <preset> <seed> <x0> <z0> <w> <h> <step> <y> <out.bin>
//   preset: overworld | large_biomes | amplified | nether
//   Coordinates are in quart (biome) units, matching cubiomes scale=4.
// Output (little-endian):
//   int32 count, then per sample: int32 biomeIndex, int64 t,h,c,e,d,w
// plus a sidecar <out.bin>.names listing biome ids by index.
import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;

import net.minecraft.SharedConstants;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.Registries;
import net.minecraft.data.registries.VanillaRegistries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.biome.Climate;
import net.minecraft.world.level.biome.BiomeSource;
import net.minecraft.world.level.biome.MultiNoiseBiomeSource;
import net.minecraft.world.level.biome.TheEndBiomeSource;
import net.minecraft.world.level.biome.MultiNoiseBiomeSourceParameterList;
import net.minecraft.world.level.levelgen.NoiseGeneratorSettings;
import net.minecraft.world.level.levelgen.RandomState;

public class GtSample {
    /** ResourceKey for minecraft:<path>; the id class was renamed (ResourceLocation -> Identifier) in 1.21.11, so resolve it reflectively. */
    @SuppressWarnings("unchecked")
    static <T> ResourceKey<T> key(ResourceKey<? extends Registry<T>> registry, String path) throws Exception {
        for (var m : ResourceKey.class.getMethods()) {
            if (!m.getName().equals("create") || m.getParameterCount() != 2) continue;
            Class<?> idClass = m.getParameterTypes()[1];
            Object id = idClass.getMethod("withDefaultNamespace", String.class).invoke(null, path);
            return (ResourceKey<T>) m.invoke(null, registry, id);
        }
        throw new IllegalStateException("ResourceKey.create not found");
    }

    public static void main(String[] a) throws Exception {
        SharedConstants.tryDetectVersion();
        Bootstrap.bootStrap();
        String preset = a[0];
        long seed = Long.parseLong(a[1]);
        int x0 = Integer.parseInt(a[2]), z0 = Integer.parseInt(a[3]);
        int w = Integer.parseInt(a[4]), h = Integer.parseInt(a[5]);
        int step = Integer.parseInt(a[6]), y = Integer.parseInt(a[7]);
        Path out = Paths.get(a[8]);

        HolderLookup.Provider reg = VanillaRegistries.createLookup();
        ResourceKey<NoiseGeneratorSettings> sk = key(Registries.NOISE_SETTINGS, preset);
        RandomState rs = RandomState.create(reg, sk, seed);
        Climate.Sampler sampler = rs.sampler();

        BiomeSource src;
        if (preset.equals("end")) {
            src = TheEndBiomeSource.create(reg.lookupOrThrow(Registries.BIOME));
        } else {
            String listName = preset.equals("nether") ? "nether" : "overworld";
            ResourceKey<MultiNoiseBiomeSourceParameterList> lk = key(Registries.MULTI_NOISE_BIOME_SOURCE_PARAMETER_LIST, listName);
            Holder<MultiNoiseBiomeSourceParameterList> list = reg.lookupOrThrow(Registries.MULTI_NOISE_BIOME_SOURCE_PARAMETER_LIST).getOrThrow(lk);
            src = MultiNoiseBiomeSource.createFromPreset(list);
        }

        Map<String, Integer> ids = new LinkedHashMap<>();
        int n = w * h;
        ByteBuffer buf = ByteBuffer.allocate(4 + n * (4 + 6 * 8)).order(ByteOrder.LITTLE_ENDIAN);
        buf.putInt(n);
        for (int j = 0; j < h; j++) {
            for (int i = 0; i < w; i++) {
                int qx = x0 + i * step, qz = z0 + j * step;
                Climate.TargetPoint tp = sampler.sample(qx, y, qz);
                String name = src.getNoiseBiome(qx, y, qz, sampler).getRegisteredName();
                Integer id = ids.get(name);
                if (id == null) { id = ids.size(); ids.put(name, id); }
                buf.putInt(id);
                buf.putLong(tp.temperature()); buf.putLong(tp.humidity());
                buf.putLong(tp.continentalness()); buf.putLong(tp.erosion());
                buf.putLong(tp.depth()); buf.putLong(tp.weirdness());
            }
        }
        Files.write(out, buf.array());
        Files.write(Paths.get(out + ".names"), String.join("\n", ids.keySet()).getBytes());
        System.err.println("wrote " + n + " samples, " + ids.size() + " biomes");
    }
}
