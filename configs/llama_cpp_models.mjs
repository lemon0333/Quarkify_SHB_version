// configs/llama_cpp_models.mjs - llama.cpp model graph builders
// Usage: node quarkify_v7.mjs configs/llama_cpp_models.mjs
// Output: ~/antigravity/quark/llama_cpp/models/
//
// Created 2026-05-26 for Gemma 4 31B forward debugging. The earlier
// llama_cpp_cuda.mjs only covered the CUDA backend (kernels) but not
// per-model graph construction. This config quarkifies the model-graph
// .cpp files so we can systematically compare Gemma family vs Llama vs
// EXAONE forward graphs.

export default {
  name: 'llama.cpp model graph builders (v7)',
  srcDir: '/path/to/your/workspace/llama.cpp',
  outDir: '/path/to/your/workspace/quark/llama_cpp/models',

  sourceFiles: [
    // Architecture entry points (small but central)
    'src/llama-arch.cpp',
    'src/llama-model.cpp',
    'src/llama-graph.cpp',
    'src/llama-graph.h',
    'src/llama-hparams.cpp',
    'src/llama-hparams.h',
    // Per-model graph builders for cross-compare
    'src/models/gemma.cpp',
    'src/models/gemma2.cpp',
    'src/models/gemma3.cpp',
    'src/models/gemma3n.cpp',
    'src/models/gemma4.cpp',
    'src/models/llama.cpp',
    'src/models/exaone.cpp',
    'src/models/exaone4.cpp',
    'src/models/qwen3.cpp',
    'src/models/models.h',
  ],

  perfData: {},

  guessRole(name) {
    const n = name.toLowerCase();
    if (n.includes('graph')) return 'forward_graph';
    if (n.includes('build_norm') || n.includes('rms_norm') || n.includes('norm')) return 'compute_norm';
    if (n.includes('build_attn') || n.includes('attention') || n.includes('attn')) return 'compute_attention';
    if (n.includes('build_ffn') || n.includes('ffn') || n.includes('mlp')) return 'compute_ffn';
    if (n.includes('build_rope') || n.includes('rope')) return 'compute_rope';
    if (n.includes('load_arch') || n.includes('load_hparams') || n.includes('load_tensors')) return 'loader';
    if (n.includes('softcap') || n.includes('soft_cap')) return 'compute_softcap';
    if (n.includes('residual') || n.includes('add')) return 'compute_residual';
    if (n.includes('embed') || n.includes('inp_embd')) return 'compute_embedding';
    if (n.includes('lora') || n.includes('lm_head') || n.includes('output')) return 'output_head';
    return 'general';
  },
};
