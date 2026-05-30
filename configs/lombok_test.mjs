export default {
  name: 'lombok-project-analysis',
  srcDir: '/path/to/your/workspace/quarkify/lombok',
  outDir: '/path/to/your/workspace/quarkify/lombok_output',

  sourceFiles: [
    'src/core/**/*.java',
  ],

  perfData: {},

  guessRole(name) {
    const n = name.toLowerCase();
    if (n.includes('handler') || n.includes('processor')) return 'annotation_handler';
    if (n.includes('ast') || n.includes('node') || n.includes('tree')) return 'ast_representation';
    return 'general';
  },
};
