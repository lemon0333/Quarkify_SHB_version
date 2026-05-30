// configs/llama_cpp_cuda.mjs — llama.cpp CUDA backend
// 사용 (Usage): node quarkify_v7.mjs configs/llama_cpp_cuda.mjs
// 출력 (Output): ~/antigravity/quark/llama_cpp/cuda/llama3-3b-q4km/

export default {
  name: 'llama.cpp CUDA backend (v7)',
  srcDir: '/path/to/your/workspace/llama.cpp',
  outDir: '/path/to/your/workspace/quark/llama_cpp/cuda/llama3-3b-q4km',

  sourceFiles: [
    'ggml/src/ggml-cuda/common.cuh',
    'ggml/src/ggml-cuda/ggml-cuda.cu',
    'ggml/src/ggml-cuda/mmvq.cu',
    'ggml/src/ggml-cuda/mmvq.cuh',
    'ggml/src/ggml-cuda/mmvf.cu',
    'ggml/src/ggml-cuda/mmvf.cuh',
    // 2026-05-27: MMQ (Matrix-Matrix Quant) = llama.cpp prefill path.
    'ggml/src/ggml-cuda/mmq.cu',
    'ggml/src/ggml-cuda/mmq.cuh',
    'ggml/src/ggml-cuda/mmq-instance-q4_k.cu',
    'ggml/src/ggml-cuda/mmq-instance-q6_k.cu',
    'ggml/src/ggml-cuda/mma.cuh',
    'ggml/src/ggml-cuda/mmf.cu',
    'ggml/src/ggml-cuda/mmf.cuh',
    'ggml/src/ggml-cuda/vecdotq.cuh',
    'ggml/src/ggml-cuda/quantize.cu',
    'ggml/src/ggml-cuda/quantize.cuh',
    'ggml/src/ggml-cuda/dequantize.cuh',
    'ggml/src/ggml-cuda/convert.cu',
    'ggml/src/ggml-cuda/convert.cuh',
    'ggml/src/ggml-cuda/rope.cu',
    'ggml/src/ggml-cuda/rope.cuh',
    'ggml/src/ggml-cuda/norm.cu',
    'ggml/src/ggml-cuda/norm.cuh',
    'ggml/src/ggml-cuda/softmax.cu',
    'ggml/src/ggml-cuda/softmax.cuh',
    'ggml/src/ggml-cuda/fattn.cu',
    'ggml/src/ggml-cuda/fattn.cuh',
    'ggml/src/ggml-cuda/fattn-mma-f16.cuh',
    'ggml/src/ggml-cuda/fattn-tile.cu',
    'ggml/src/ggml-cuda/fattn-tile.cuh',
    'ggml/src/ggml-cuda/fattn-vec.cuh',
    'ggml/src/ggml-cuda/cp-async.cuh',
    'ggml/src/ggml-cuda/argmax.cu',
    'ggml/src/ggml-cuda/argmax.cuh',
  ],

  perfData: {},  // llama.cpp 측 NCU 데이터는 추후 측정 시 채움 (llama.cpp NCU data will be filled in during later measurements)

  guessRole(name) {
    const n = name.toLowerCase();
    if (n === 'main') return 'entry_point';
    if (n.includes('flash_attn') || n.includes('fattn') || n.includes('attention') ||
        n.includes('softmax')) return 'compute_attention';
    if (n.includes('gemv') || n.includes('matmul') || n.includes('mma') ||
        n.includes('mul_mat_vec') || n.includes('mul_mm') || n.includes('vec_dot')) return 'compute_gemv';
    if (n.includes('rope')) return 'compute_rope';
    if (n.includes('rms') || n.includes('norm')) return 'compute_norm';
    if (n.includes('dequant')) return 'compute_dequant';
    if (n.includes('quantize') || n.includes('q8_1')) return 'compute_quantize';
    if (n.includes('cp_async') || n.includes('cp.async')) return 'memory_transfer';
    if (n.includes('mma_available') || n.includes('arch_available')) return 'cuda_driver';
    if (n.includes('graph')) return 'cuda_graph';
    if (n.includes('argmax')) return 'sampling';
    if (n.includes('alloc') || n.includes('buffer')) return 'memory_alloc';
    if (n.includes('forward')) return 'model_forward';
    if (n.includes('compute_forward')) return 'kernel_launch';
    return 'general';
  },
};
