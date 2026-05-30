// configs/llama_cpp_metal.mjs — llama.cpp Metal backend configuration (v7)
// 사용: node quarkify_v7.mjs configs/llama_cpp_metal.mjs
// 출력: ~/antigravity/quark/llama_cpp/metal/llama3-3b-q4km/

export default {
  name: 'llama-cpp-metal-llama3-3b-q4km (v7)',
  srcDir: '/path/to/your/workspace/llama.cpp',
  outDir: '/path/to/your/workspace/quark/llama_cpp/metal/llama3-3b-q4km',

  sourceFiles: [
    'ggml/src/ggml-metal/ggml-metal.metal',
    'ggml/src/ggml-metal/ggml-metal.cpp',
    'ggml/src/ggml-metal/ggml-metal-common.cpp',
    'ggml/src/ggml-metal/ggml-metal-common.h',
    'ggml/src/ggml-metal/ggml-metal-context.h',
    'ggml/src/ggml-metal/ggml-metal-context.m',
    'ggml/src/ggml-metal/ggml-metal-device.cpp',
    'ggml/src/ggml-metal/ggml-metal-device.h',
    'ggml/src/ggml-metal/ggml-metal-device.m',
    'ggml/src/ggml-metal/ggml-metal-impl.h',
    'ggml/src/ggml-metal/ggml-metal-ops.cpp',
    'ggml/src/ggml-metal/ggml-metal-ops.h',
    'ggml/include/ggml-metal.h',
  ],

  perfData: {
    // llama.cpp Metal 벤치마크 데이터를 수집하면 여기에 누적합니다.
  },

  guessRole(name) {
    const n = name.toLowerCase();
    if (n === 'main') return 'entry_point';
    if (n.includes('attention') || n.includes('flash_attn') || n.includes('softmax')) return 'compute_attention';
    if (n.includes('gemv') || n.includes('matmul') || n.includes('mul_mm') ||
        n.includes('mma') || n.includes('vec_dot') || n.includes('mul_mat')) return 'compute_gemv';
    if (n.includes('rope')) return 'compute_rope';
    if (n.includes('rms') || n.includes('norm')) return 'compute_norm';
    if (n.includes('dequant')) return 'compute_dequant';
    if (n.includes('quantize') || n.includes('q8_1') || n.includes('quant')) return 'compute_quantize';
    if (n.includes('swiglu') || n.includes('sgl') || n.includes('silu') ||
        n.includes('geglu') || n.includes('sigmoid')) return 'compute_activation';
    if (n.includes('residual') || (n.startsWith('res') && !n.includes('read'))) return 'compute_residual';
    if (n.includes('embed') || n.includes('emb_lookup')) return 'compute_embedding';
    if (n.includes('kv_store') || n.includes('kv_cache') || n.includes('kvstore')) return 'kv_cache';
    if (n.includes('argmax') || n.includes('sample') || n.includes('topp')) return 'sampling';
    return 'general';
  },
};
